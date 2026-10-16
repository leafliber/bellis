/**
 * 宿主进程入口。由启动器拉起（R-23），从环境变量获得本次会话的通道地址与密钥，作为本机通道的服务端。
 * 装配顺序：状态存储（并恢复）→ OBS 应急连接 → 安全核 → 插件内核 → 按 profile 加载插件；之后向看门狗发送心跳。
 * 启动后总处于安全停止，由操作员显式切换模式。
 */
import { listen, RpcPeer } from '@bellis/channel';
import { loadConfig, obsSecretName, readObsSecret } from '@bellis/config';
import {
  ChannelHub,
  ClockService,
  Kernel,
  readJsonFile,
  resolveProfile,
  SidecarHostService,
  systemClock,
} from '@bellis/kernel';
import { builtinPlugins } from '@bellis/plugins';
import {
  channelCredentialsFromEnv,
  handleShutdown,
  logEvent,
  watchLifeline,
} from '@bellis/process';
import {
  ChildEnv,
  HostHeartbeat,
  HostStatus,
  HostStopping,
  OperatorEmergencyParams,
  OperatorMethod,
  OperatorModeParams,
  Role,
} from '@bellis/protocol';
import { ObsEmergencyConnection, SafetyCore, SafetyService, safetyFacade } from '@bellis/safety';
import { KeyringSecretStore } from '@bellis/secret-store';
import { StateStore } from '@bellis/store';
import { Compile } from 'typebox/compile';

const RPC_TIMEOUT_MS = 2000;
/** 写进日志的事实类型，便于运维观察。 */
const LOGGED_FACTS = new Set([
  'utterance.played',
  'sentence.skipped',
  'supervision.changed',
  'supervision.refused',
  'moderation.switched',
  'safety.emergency-requested',
  'safety.emergency-completed',
]);
const isModeParams = Compile(OperatorModeParams);
const isEmergencyParams = Compile(OperatorEmergencyParams);

const configPath = process.env[ChildEnv.Config];
if (!configPath) throw new Error(`缺少环境变量 ${ChildEnv.Config}`);
const config = loadConfig(configPath);
const entries = resolveProfile(readJsonFile(config.profile), config.patches.map(readJsonFile));
// 审核插件的开关必须在 profile 中显式设置，没有隐含默认（D-18）。
const moderationEntry = entries.find((entry) => entry.id === 'moderation');
if (!moderationEntry?.explicitSwitch) {
  logEvent('host.config-invalid', {
    reason: 'profile 中必须显式设置审核插件（moderation）的启用或关闭',
  });
  process.exit(1);
}
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
store.subscribe((event) => {
  if (LOGGED_FACTS.has(event.type)) logEvent('fact', { type: event.type, data: event.data });
});
const recovery = store.recover();
logEvent('host.recovered', {
  abandoned: recovery.abandoned.map((i) => i.key),
  orphaned: recovery.orphaned.map((i) => i.key),
});

const emergency = new ObsEmergencyConnection(
  await readObsSecret(secrets, obsSecretName(config)),
  clock,
  logEvent,
);
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
  bootId: process.env[ChildEnv.SessionId] ?? 'local',
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
host.provideCore(ClockService, clock);
host.provideScoped(SafetyService, ({ instanceId }) => safetyFacade(core, instanceId));
core.setModeration(!moderationEntry.disabled);
host.add(entries, builtinPlugins);
await host.settled();

let stopping = false;
const server = await listen(credentials.path, {
  key: credentials.key,
  onConnection(connection) {
    const known: string[] = [Role.Launcher, Role.Watchdog, Role.Operator];
    if (!known.includes(connection.role)) {
      if (!hub.accept(connection))
        logEvent('host.connection-unexpected', { role: connection.role });
      return;
    }
    const rpc = new RpcPeer(connection, { timeoutMs: RPC_TIMEOUT_MS });
    peers.add(rpc);
    connection.on('close', () => {
      peers.delete(rpc);
      // 看门狗断开：它可能已经静音并切了安全场景，也可能自己崩溃了。真实输出模式下都不能继续。
      if (
        connection.role === Role.Watchdog &&
        !stopping &&
        ['M1', 'M2', 'M3'].includes(core.mode)
      ) {
        void core.emergencyStop('外部看门狗连接断开');
      }
    });
    if (connection.role === Role.Launcher) {
      handleShutdown(rpc, (reason) => void stop(reason ?? Role.Launcher));
      rpc.handle(HostStatus, () => ({ watchdogConnected: watchdogs().length > 0 }));
    }
    if (connection.role === Role.Operator) serveOperator(rpc);
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

/** 操作员命令：查看状态、切换模式（升级只能经这里显式发起）、确认在场、急停。 */
function serveOperator(rpc: RpcPeer): void {
  rpc.handle(OperatorMethod.Status, () => ({
    mode: core.mode,
    maintenance: core.maintenance,
    moderationEnabled: core.moderationEnabled ?? null,
    presenceValid: core.presenceValid(),
    plugins: host
      .snapshot()
      .map((e) => ({ id: e.id, plugin: e.plugin, state: e.state, reason: e.reason ?? null })),
  }));
  rpc.handle(OperatorMethod.Mode, (params) => {
    if (!isModeParams.Check(params)) return { ok: false, reason: '参数不合法' };
    return core.requestMode(params.target);
  });
  rpc.handle(OperatorMethod.Presence, () => {
    core.confirmPresence();
    return { ok: true };
  });
  rpc.handle(OperatorMethod.EmergencyStop, async (params) => {
    const reason = isEmergencyParams.Check(params) ? params.reason : '操作员急停';
    return core.emergencyStop(reason);
  });
}

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
