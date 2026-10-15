import Type, { type Static } from 'typebox';
import { Permission } from './plugin.ts';

/**
 * 宿主与看门狗共用的配置文件。不含凭据：OBS 的地址与密码在 SecretStore 中（D-28）。
 * 时长与限额都是初始值，以真机实测为准（D-34）。
 */

const closed = { additionalProperties: false } as const;
const Positive = Type.Integer({ minimum: 1 });

export const EmergencyPolicyConfig = Type.Object(
  {
    /** Stage 浏览器源的名字。 */
    stageSource: Type.String({ minLength: 1 }),
    safeScene: Type.String({ minLength: 1 }),
    stopStream: Type.Boolean(),
  },
  closed,
);

export const HostConfig = Type.Object(
  {
    v: Type.Literal(1),
    /** 状态存储文件；相对路径以配置文件所在目录为基准。 */
    storePath: Type.String({ minLength: 1 }),
    /** `sim` profile：只允许 M0，外部服务全部换成模拟实现。 */
    simulation: Type.Boolean(),
    /** 插件 profile 文件与依次应用的 patch 文件；相对路径以配置文件所在目录为基准。 */
    profile: Type.String({ minLength: 1 }),
    patches: Type.Array(Type.String({ minLength: 1 })),
    heartbeatIntervalMs: Positive,
    watchdog: Type.Object({ heartbeatTimeoutMs: Positive }, closed),
    safety: Type.Object(
      {
        leaseTtlMs: Type.Record(Type.String(), Positive),
        leaseCapabilities: Type.Record(Type.String(), Permission),
        presenceTtlMs: Positive,
        rateLimits: Type.Record(
          Type.String(),
          Type.Object({ max: Positive, windowMs: Positive }, closed),
        ),
        guardTimeoutMs: Positive,
        emergency: EmergencyPolicyConfig,
        unattendedGatesSatisfied: Type.Boolean(),
      },
      closed,
    ),
  },
  closed,
);
export type HostConfig = Static<typeof HostConfig>;

/** SecretStore 中名为 `obs` 的条目：obs-websocket 的地址与密码。 */
export const ObsSecret = Type.Object(
  { url: Type.String({ pattern: '^wss?://' }), password: Type.Optional(Type.String()) },
  closed,
);
export type ObsSecret = Static<typeof ObsSecret>;
