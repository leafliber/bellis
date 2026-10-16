import Type, { type Static } from 'typebox';
import { ChannelBytes32 } from './channel.ts';

/**
 * 进程启动与连接信息分发（R-06、R-23）。
 */

const closed = { additionalProperties: false } as const;

/** 子进程从环境变量获得本次会话的连接信息；非子进程从 SecretStore 读取 `SessionInfo`。 */
export const ChildEnv = {
  SessionId: 'BELLIS_SESSION_ID',
  ChannelPath: 'BELLIS_CHANNEL_PATH',
  ChannelKey: 'BELLIS_CHANNEL_KEY',
  /** 宿主与看门狗共用的配置文件路径。 */
  Config: 'BELLIS_CONFIG',
  /** sidecar 连接宿主时使用的角色，由代理插件分配。 */
  Role: 'BELLIS_ROLE',
  /** SecretStore 的服务名，缺省为 `bellis`；测试用独立的服务名互不干扰。 */
  SecretService: 'BELLIS_SECRET_SERVICE',
} as const;

export const SessionId = Type.String({ pattern: '^[a-z0-9]{1,16}$' });

/** 启动器写入 SecretStore 的本次会话连接信息，供看门狗与单独启动的 Game Runtime 读取。 */
export const SessionInfo = Type.Object(
  {
    v: Type.Literal(1),
    sessionId: SessionId,
    channelPath: Type.String({ minLength: 1, maxLength: 260 }),
    /** 会话密钥的 base64url 编码。 */
    channelKey: ChannelBytes32,
    launcherPid: Type.Integer({ minimum: 1 }),
    startedAt: Type.String({ format: 'date-time' }),
  },
  closed,
);
export type SessionInfo = Static<typeof SessionInfo>;

/** 停止顺序第 1 步：请求进程自行收尾后退出（R-06）。 */
export const ProcessShutdown = 'process.shutdown';

export const ProcessShutdownParams = Type.Object(
  { reason: Type.Optional(Type.String({ maxLength: 200 })) },
  closed,
);
export type ProcessShutdownParams = Static<typeof ProcessShutdownParams>;

export const ProcessShutdownResult = Type.Object({ accepted: Type.Boolean() }, closed);
export type ProcessShutdownResult = Static<typeof ProcessShutdownResult>;

/** 宿主计划内停止前，通知已连接的对端（看门狗据此区分计划内停止与崩溃）。 */
export const HostStopping = 'host.stopping';

export const HostStoppingParams = Type.Object({ reason: Type.String({ maxLength: 200 }) }, closed);
export type HostStoppingParams = Static<typeof HostStoppingParams>;

/** 宿主发给看门狗的心跳通知；看门狗在超时内收不到即执行静音与切安全场景（R-14）。 */
export const HostHeartbeat = 'host.heartbeat';

export const HostHeartbeatParams = Type.Object(
  {
    seq: Type.Integer({ minimum: 0 }),
    mode: Type.String(),
    maintenance: Type.Boolean(),
  },
  closed,
);
export type HostHeartbeatParams = Static<typeof HostHeartbeatParams>;

/**
 * 看门狗执行过应急动作后通知宿主，宿主据此进入安全停止并记录事件（R-14）。
 * 连接还在（宿主卡死）时立即发送，宿主恢复后读到；连接已断开时在重连后补报。
 */
export const WatchdogActed = 'watchdog.acted';

export const WatchdogActedParams = Type.Object(
  {
    reason: Type.Union([Type.Literal('heartbeat-lost'), Type.Literal('connection-lost')]),
    /** OBS 是否确认了全部应急请求。 */
    ok: Type.Boolean(),
    actedAt: Type.String({ format: 'date-time' }),
  },
  closed,
);
export type WatchdogActedParams = Static<typeof WatchdogActedParams>;

/** 启动器查询宿主状态，用于判断会话是否就绪（看门狗已连上宿主）。 */
export const HostStatus = 'host.status';

export const HostStatusResult = Type.Object({ watchdogConnected: Type.Boolean() }, closed);
export type HostStatusResult = Static<typeof HostStatusResult>;

/** 连接宿主时使用的固定角色。 */
export const Role = {
  Launcher: 'launcher',
  Watchdog: 'watchdog',
  /** 操作员入口（P0 为命令行，操作台待 R-20）。 */
  Operator: 'operator',
} as const;

/** 操作员命令。模式升级只能经这里由操作员显式发起。 */
export const OperatorMethod = {
  Status: 'operator.status',
  Mode: 'operator.mode',
  Presence: 'operator.presence',
  EmergencyStop: 'operator.emergency_stop',
  /** M1 中否决等待放行的句子。 */
  Veto: 'operator.veto',
  /** 只跑开播预检，不切换模式。 */
  Preflight: 'operator.preflight',
} as const;

export const OperatorModeParams = Type.Object(
  { target: Type.Union(['M0', 'M1', 'M2', 'M3', 'safe-stop'].map((m) => Type.Literal(m))) },
  closed,
);
export type OperatorModeParams = Static<typeof OperatorModeParams>;

export const OperatorEmergencyParams = Type.Object(
  { reason: Type.String({ minLength: 1, maxLength: 200 }) },
  closed,
);
export type OperatorEmergencyParams = Static<typeof OperatorEmergencyParams>;

/** 否决指定的句子（`发言编号#句序号`）；不给 key 时否决全部等待中的句子。 */
export const OperatorVetoParams = Type.Object(
  { key: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })) },
  closed,
);
export type OperatorVetoParams = Static<typeof OperatorVetoParams>;

export const OperatorPreflightParams = Type.Object(
  { target: Type.Optional(Type.Union(['M1', 'M2', 'M3'].map((m) => Type.Literal(m)))) },
  closed,
);
export type OperatorPreflightParams = Static<typeof OperatorPreflightParams>;
