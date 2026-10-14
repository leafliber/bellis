/**
 * 外部看门狗入口（R-14）。由启动器拉起，不是宿主的子进程，宿主崩溃后仍然存活；
 * 从 SecretStore 读取本次会话的连接信息（R-23），以 `watchdog` 角色连接宿主。
 * 心跳超时判定与 OBS 静音、切安全场景在安全核步骤中加入。
 */
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { connect, decodeSessionKey, RpcPeer } from '@bellis/channel';
import { logEvent, watchLifeline } from '@bellis/process';
import { ChildEnv, HostStopping, Role } from '@bellis/protocol';
import { KeyringSecretStore, readSessionInfo } from '@bellis/secret-store';

const RECONNECT_DELAY_MS = 200;

watchLifeline(() => {
  logEvent('watchdog.stopping', { reason: 'stdin-eof' });
  process.exit(0);
});

// 控制台的 Ctrl+C 会送达同一控制台的全部进程；看门狗只按启动器的停止顺序退出。
process.on('SIGINT', () => {});

const store = new KeyringSecretStore(process.env[ChildEnv.SecretService] ?? 'bellis');
const info = await readSessionInfo(store);
if (info === undefined || info.sessionId !== process.env[ChildEnv.SessionId]) {
  logEvent('watchdog.session-missing', { expected: process.env[ChildEnv.SessionId] ?? null });
  process.exit(1);
}
const key = decodeSessionKey(info.channelKey);
logEvent('watchdog.ready', { pid: process.pid, ppid: process.ppid, sessionId: info.sessionId });

let waitingLogged = false;
for (;;) {
  try {
    const connection = await connect(info.channelPath, Role.Watchdog, { key });
    const rpc = new RpcPeer(connection, { timeoutMs: 2000 });
    let planned = false;
    rpc.onNotification(HostStopping, () => {
      planned = true;
    });
    waitingLogged = false;
    logEvent('watchdog.connected');
    const [error] = await once(connection, 'close');
    logEvent(planned ? 'watchdog.host-stopped' : 'watchdog.host-lost', {
      error: error?.message ?? null,
    });
  } catch (error) {
    if (!waitingLogged) {
      logEvent('watchdog.waiting-for-host', { error: (error as Error).message });
      waitingLogged = true;
    }
  }
  await sleep(RECONNECT_DELAY_MS);
}
