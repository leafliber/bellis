/**
 * 宿主进程入口。由启动器拉起（R-23），从环境变量获得本次会话的通道地址与密钥，作为本机通道的服务端。
 * 装配顺序：状态存储（并恢复）→ OBS 应急连接 → 安全核 → 插件内核 → 操作员动作 → 本机通道 → 操作台
 * → 按 profile 加载插件；看门狗的心跳在加载插件之前开始。
 * 启动后总处于安全停止，由操作员显式切换模式。操作员动作由命令行与操作台共用（operator.ts）。
 */
import { dirname } from 'node:path';
import { VoteService, type Votes } from '@bellis/audience';
import { type Avatar, AvatarService } from '@bellis/avatar';
import { listen, RpcPeer } from '@bellis/channel';
import {
  loadConfig,
  OBS_SECRET,
  obsSecretName,
  readObsSecret,
  SIM_OBS_SECRET,
} from '@bellis/config';
import { ConsoleServer } from '@bellis/console';
import {
  ChannelHub,
  ClockService,
  DataDirService,
  Kernel,
  RandomService,
  readJsonFile,
  resolveProfile,
  SecretsService,
  SidecarHostService,
  systemClock,
  systemRandom,
} from '@bellis/kernel';
import { ObsClient, ObsMeters } from '@bellis/obs';
import { builtinPlugins, builtinProjections } from '@bellis/plugins';
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
  Role,
  WatchdogActed,
  WatchdogActedParams,
} from '@bellis/protocol';
import { ObsEmergencyConnection, SafetyCore, SafetyService, safetyFacade } from '@bellis/safety';
import { KeyringSecretStore, SESSION_SECRET } from '@bellis/secret-store';
import { type Review, ReviewService, type TtsRouting, TtsRoutingService } from '@bellis/speech';
import {
  OBS_CONTROL,
  OBS_METERS,
  ObsConnectorService,
  ObsMetersService,
  type Presentation,
  type Stage,
  StageService,
} from '@bellis/stage';
import { StateStore } from '@bellis/store';
import { Compile } from 'typebox/compile';
import { consoleRoutes, createOperator, serveOperator, type Target } from './operator.ts';
import { preflight } from './preflight.ts';
import { pluginSecrets } from './secrets.ts';

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
  'watchdog.acted',
  'stage.connected',
  'speech.held',
  'speech.released',
  'speech.vetoed',
  'speech.withdrawn',
  'safety.obs-external',
  'tts.switched',
  'tts.started',
  'tts.degraded',
  'vote.announced',
  'vote.ended',
  'vote.aborted',
  'vote.rejected',
]);
const isWatchdogActed = Compile(WatchdogActedParams);

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
  projections: builtinProjections,
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

const obsSecret = await readObsSecret(secrets, obsSecretName(config));
const emergency = new ObsEmergencyConnection(obsSecret, clock, logEvent);
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
host.provideCore(RandomService, systemRandom());
// 状态存储所在目录：遥测在它下面的子目录里写 JSONL（见运维“观测”）。
host.provideCore(DataDirService, { path: dirname(config.storePath) });
host.provideScoped(SafetyService, ({ instanceId, permissions }) =>
  safetyFacade(core, instanceId, permissions),
);
// 插件凭据：只放行 profile 授予的条目；会话连接信息与 OBS 凭据由宿主管理，插件拿不到。
const reservedSecrets = new Set([SESSION_SECRET, OBS_SECRET, SIM_OBS_SECRET]);
host.provideScoped(SecretsService, ({ permissions }) =>
  pluginSecrets(secrets, permissions, reservedSecrets),
);
// OBS 控制的连接：凭据留在宿主装配代码里，只有被授予 obs.control 权限的实例能连接。
host.provideScoped(ObsConnectorService, ({ instanceId, permissions }) => ({
  connect: () =>
    permissions.has(OBS_CONTROL)
      ? ObsClient.connect(obsSecret.url, obsSecret.password, { timeoutMs: 2000 })
      : Promise.reject(new Error(`${instanceId} 没有权限 ${OBS_CONTROL}`)),
}));
// 只读的音量表连接（Stage 文档“对齐”）：同一份凭据，另开一条连接，只订阅音量表、只能读同步偏移；
// 只有被授予 obs.meters 的实例能连接，与 obs.control 无关。
host.provideScoped(ObsMetersService, ({ instanceId, permissions }) => ({
  connect: () =>
    permissions.has(OBS_METERS)
      ? ObsMeters.connect(obsSecret.url, obsSecret.password, { timeoutMs: 2000 })
      : Promise.reject(new Error(`${instanceId} 没有权限 ${OBS_METERS}`)),
}));

// 操作员动作：命令行与操作台共用（R-20）。操作台与命令行一样由宿主装配，不是插件。
let consoleServer: ConsoleServer | undefined;
const operator = createOperator({
  core,
  subscribe: (listener) => store.subscribe(listener),
  plugins: () => host.snapshot(),
  presentation,
  review: () => {
    const review = host.services.resolve(ReviewService.name, ReviewService.major);
    return 'missing' in review ? null : (review.impl as Review).settings;
  },
  vote: () => {
    const votes = host.services.resolve(VoteService.name, VoteService.major);
    return 'missing' in votes ? null : ((votes.impl as Votes).current() ?? null);
  },
  preflight: runPreflight,
  consoleLogin: () => consoleServer?.issueLogin(),
});
// 在操作员动作订阅状态存储之后报告审核开关，开关状态也进近期告警。
core.setModeration(!moderationEntry.disabled);

let stopping = false;
// 先监听再加载插件：sidecar 代理插件在激活期间等它的子进程连上来。
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
    if (connection.role === Role.Operator) serveOperator(rpc, operator);
    if (connection.role === Role.Watchdog) {
      // 看门狗已静音并切了安全场景：宿主据此进入安全停止（断开即急停只是兜底）。
      rpc.onNotification(WatchdogActed, (params) => {
        if (isWatchdogActed.Check(params)) core.watchdogActed(params);
        else logEvent('host.watchdog-report-invalid', {});
      });
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
// 看门狗一连上就开始计时，心跳要在加载插件之前开始：sidecar 代理插件激活时要等子进程启动并连上来，
// 加载可能超过心跳超时，期间宿主照常运行，不能让看门狗误判为卡死。
let seq = 0;
const heartbeat = setInterval(() => {
  seq += 1;
  for (const peer of watchdogs()) peer.notify(HostHeartbeat, { seq, ...core.heartbeat() });
}, config.heartbeatIntervalMs);

// 操作台在加载插件之前开启：插件加载卡住或出错时照样可用。
try {
  consoleServer = await ConsoleServer.start({ routes: consoleRoutes(operator), log: logEvent });
} catch (error) {
  logEvent('console.start-failed', { error: (error as Error).message });
}

host.add(entries, builtinPlugins);
await host.settled();

watchLifeline(() => void stop('stdin-eof'));
// 控制台的 Ctrl+C 会送达同一控制台的全部进程；宿主只按启动器的停止顺序退出。
process.on('SIGINT', () => {});
logEvent('host.ready', { pid: process.pid, ppid: process.ppid, mode: core.mode });

/**
 * 开播预检（见 preflight.ts）。withSafety 时先问安全核目标模式的前置条件（已处于该模式不算未通过），
 * 把原因列为一项；切换时安全核已先核对过，不再重复。
 */
function runPreflight(target: Target, withSafety: boolean): Promise<string[]> {
  const stage = host.services.resolve(StageService.name, StageService.major);
  const review = host.services.resolve(ReviewService.name, ReviewService.major);
  const avatar = host.services.resolve(AvatarService.name, AvatarService.major);
  const routing = host.services.resolve(TtsRoutingService.name, TtsRoutingService.major);
  return preflight({
    target,
    safetyBlocker: withSafety ? core.preconditionBlocker(target) : undefined,
    plugins: host.snapshot(),
    stageReady: 'missing' in stage ? undefined : (stage.impl as Stage).ready,
    avatar:
      'missing' in avatar
        ? undefined
        : { ready: (avatar.impl as Avatar).ready, status: (avatar.impl as Avatar).status },
    moderationEnabled: core.moderationEnabled,
    reviewPresent: !('missing' in review),
    ttsPrimary: 'missing' in routing ? undefined : (routing.impl as TtsRouting).primary(),
    inspectObs: () => emergency.inspect(config.safety.emergency),
  });
}

/** 当前的呈现延迟与样本数（Stage 文档“对齐”）；没有 Stage 服务时为 null。 */
function presentation(): Presentation | null {
  const stage = host.services.resolve(StageService.name, StageService.major);
  return 'missing' in stage ? null : (stage.impl as Stage).presentation;
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
  await consoleServer?.close();
  await host.shutdown();
  operator.dispose();
  emergency.close();
  store.close();
  await server.close();
  process.exit(0);
}
