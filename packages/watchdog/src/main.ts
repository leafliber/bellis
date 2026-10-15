/**
 * 外部看门狗入口（R-14）。由启动器拉起，不是宿主的子进程，宿主崩溃后仍然存活；
 * 从 SecretStore 读取本次会话的连接信息与 OBS 凭据（R-23），从配置文件读取应急目标与超时。
 */
import { decodeSessionKey } from '@bellis/channel';
import { loadConfig, obsSecretName, readObsSecret } from '@bellis/config';
import { logEvent, watchLifeline } from '@bellis/process';
import { ChildEnv } from '@bellis/protocol';
import { KeyringSecretStore, readSessionInfo } from '@bellis/secret-store';
import { Watchdog } from './watchdog.ts';

let watchdog: Watchdog | undefined;
watchLifeline(() => {
  logEvent('watchdog.stopping', { reason: 'stdin-eof' });
  watchdog?.stop();
  process.exit(0);
});
// 控制台的 Ctrl+C 会送达同一控制台的全部进程；看门狗只按启动器的停止顺序退出。
process.on('SIGINT', () => {});

const configPath = process.env[ChildEnv.Config];
if (!configPath) throw new Error(`缺少环境变量 ${ChildEnv.Config}`);
const config = loadConfig(configPath);
const store = new KeyringSecretStore(process.env[ChildEnv.SecretService] ?? 'bellis');
const info = await readSessionInfo(store);
if (info === undefined || info.sessionId !== process.env[ChildEnv.SessionId]) {
  logEvent('watchdog.session-missing', { expected: process.env[ChildEnv.SessionId] ?? null });
  process.exit(1);
}
logEvent('watchdog.ready', { pid: process.pid, ppid: process.ppid, sessionId: info.sessionId });

watchdog = new Watchdog({
  channelPath: info.channelPath,
  key: decodeSessionKey(info.channelKey),
  obs: await readObsSecret(store, obsSecretName(config)),
  policy: config.safety.emergency,
  heartbeatTimeoutMs: config.watchdog.heartbeatTimeoutMs,
  log: logEvent,
});
watchdog.start();
