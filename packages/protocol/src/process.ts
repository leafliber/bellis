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

/** 启动器查询宿主状态，用于判断会话是否就绪（看门狗已连上宿主）。 */
export const HostStatus = 'host.status';

export const HostStatusResult = Type.Object({ watchdogConnected: Type.Boolean() }, closed);
export type HostStatusResult = Static<typeof HostStatusResult>;

/** 连接宿主时使用的固定角色。 */
export const Role = {
  Launcher: 'launcher',
  Watchdog: 'watchdog',
} as const;
