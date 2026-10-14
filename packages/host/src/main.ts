/**
 * 宿主进程入口。由启动器拉起（R-23），从环境变量获得本次会话的通道地址与密钥，作为本机通道的服务端。
 * 装配顺序：状态存储（并恢复）→ OBS 应急连接 → 安全核 → 插件内核；之后向看门狗发送心跳。
 */
import { listen, RpcPeer } from '@bellis/channel';
import { loadConfig, readObsSecret } from '@bellis/config';
import { ChannelHub, Kernel, SidecarHostService, systemClock } from '@bellis/kernel';
import {
  channelCredentialsFromEnv,
  handleShutdown,
  logEvent,
  watchLifeline,
} from '@bellis/process';
import { ChildEnv, HostHeartbeat, HostStatus, HostStopping, Role } from '@bellis/protocol';
import { ObsEmergencyConnection, SafetyCore } from '@bellis/safety';
import { KeyringSecretStore } from '@bellis/secret-store';
import { StateStore } from '@bellis/store';

const RPC_TIMEOUT_MS = 2000;

const configPath = process.env[ChildEnv.Config];
if (!configPath) throw new Error(`缺少环境变量 ${ChildEnv.Config}`);
const config = loadConfig(configPath);
const credentials = channelCredentialsFromEnv();
const secrets = new KeyringSecretStore(process.env[ChildEnv.SecretService] ?? 'bellis');
const clock = systemClock();

let safety: SafetyCore | undefined;
const store = StateStore.open({
  path: config.storePath,
  onFault: (error) => {
    logEvent('host.store-fault', { error: error.message });
    safety?.downgrade('状态存储不可用');
  },
});
const recovery = store.recover();
logEvent('host.recovered', {
  abandoned: recovery.abandoned.map((i) => i.key),
  orphaned: recovery.orphaned.map((i) => i.key),
});

const emergency = new ObsEmergencyConnection(await readObsSecret(secrets), clock, logEvent);
await emergency.start();

const peers = new Set<RpcPeer>();
const watchdogs = () =>
  [...peers].filter((peer) => peer.connection.role === Role.Watchdog && peer.connection.isOpen);

let kernel: Kernel | undefined;
const core = new SafetyCore({
  store,
  clock,
  config: { simulation: config.simulation, ...config.safety },
  obs: emergency,
  permissionsOf: (holder) => kernel?.permissionsOf(holder),
  watchdogConnected: () => watchdogs().length > 0,
  log: logEvent,
});
safety = core;

const host = new Kernel({
  clock,
  safety: core.kernelHooks(),
  log: logEvent,
  onTransition: (transition) => {
    logEvent('plugin.transition', { ...transition });
    const tier = host.snapshot().find((entry) => entry.id === transition.entryId)?.tier;
    if (tier) core.onPluginTransition(transition, tier);
  },
});
kernel = host;
const hub = new ChannelHub();
host.provideCore(SidecarHostService, { credentials, hub });

let stopping = false;
const server = await listen(credentials.path, {
  key: credentials.key,
  onConnection(connection) {
    if (connection.role !== Role.Launcher && connection.role !== Role.Watchdog) {
      if (!hub.accept(connection))
        logEvent('host.connection-unexpected', { role: connection.role });
      return;
    }
    const rpc = new RpcPeer(connection, { timeoutMs: RPC_TIMEOUT_MS });
    peers.add(rpc);
    connection.on('close', () => peers.delete(rpc));
    if (connection.role === Role.Launcher) {
      handleShutdown(rpc, (reason) => void stop(reason ?? Role.Launcher));
      rpc.handle(HostStatus, () => ({ watchdogConnected: watchdogs().length > 0 }));
    }
    logEvent('host.connection-accepted', { role: connection.role });
  },
  onRejected(error) {
    logEvent('host.connection-rejected', { code: error.code, message: error.message });
  },
  onError(error) {
    logEvent('host.channel-error', { message: error.message });
  },
});

let seq = 0;
const heartbeat = setInterval(() => {
  seq += 1;
  for (const peer of watchdogs()) peer.notify(HostHeartbeat, { seq, ...core.heartbeat() });
}, config.heartbeatIntervalMs);

watchLifeline(() => void stop('stdin-eof'));
// 控制台的 Ctrl+C 会送达同一控制台的全部进程；宿主只按启动器的停止顺序退出。
process.on('SIGINT', () => {});
logEvent('host.ready', { pid: process.pid, ppid: process.ppid, mode: core.mode });

/** 计划内停止：先走急停路径（吊销许可、切安全场景），再通知对端、卸载插件、关闭存储。 */
async function stop(reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logEvent('host.stopping', { reason });
  await core.emergencyStop(`宿主停止：${reason}`);
  clearInterval(heartbeat);
  for (const peer of peers) {
    if (peer.connection.isOpen) peer.notify(HostStopping, { reason });
  }
  await host.shutdown();
  emergency.close();
  store.close();
  await server.close();
  process.exit(0);
}
