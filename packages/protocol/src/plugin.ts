import Type, { type Static } from 'typebox';

/**
 * 插件清单、profile 与 sidecar 握手（D-13、D-14、D-21）。
 */

const closed = { additionalProperties: false } as const;

/** 插件与 profile 条目的标识，例如 `tts-sim`、`speech.arbiter`。 */
export const PluginId = Type.String({
  pattern: '^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)*$',
  maxLength: 48,
});

/** 服务引用 `名字@主版本`；出现在 inject 中时可加 `?` 表示可选依赖。 */
export const ServiceRef = Type.String({ pattern: '^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)*@[0-9]+$' });
export const InjectRef = Type.String({
  pattern: '^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)*@[0-9]+\\??$',
});

/**
 * 权限，例如 `speech.output`、`net.egress:api.example.com`；外发权限另可写成子域名通配
 * `net.egress:*.example.com`（匹配规则见 `egressAllowed`）。
 */
export const Permission = Type.String({
  pattern:
    '^(?:[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)*(:[A-Za-z0-9.-]+)?|net\\.egress:\\*\\.[A-Za-z0-9.-]+)$',
});

export const PluginTier = Type.Union([Type.Literal('critical'), Type.Literal('ordinary')]);
export const PluginProcess = Type.Union([Type.Literal('in-process'), Type.Literal('sidecar')]);

/** 插件清单。`config` 为该插件配置的 JSON Schema。 */
export const PluginManifest = Type.Object(
  {
    id: PluginId,
    version: Type.String({ minLength: 1, maxLength: 32 }),
    tier: PluginTier,
    provides: Type.Array(ServiceRef),
    inject: Type.Array(InjectRef),
    permissions: Type.Array(Permission),
    process: PluginProcess,
    config: Type.Record(Type.String(), Type.Unknown()),
  },
  closed,
);
export type PluginManifest = Static<typeof PluginManifest>;

/** profile 中的一个条目：`id` 是位置，`plugin` 是填在这个位置上的实现。 */
export const ProfileEntry = Type.Object(
  {
    id: PluginId,
    plugin: PluginId,
    /** 显式禁用：保留条目，但不加载实例。 */
    disabled: Type.Optional(Type.Boolean()),
    config: Type.Optional(Type.Unknown()),
    /** 授予该条目的权限；插件申请而未授予的权限会使它停在 WAITING。 */
    grant: Type.Optional(Type.Array(Permission)),
  },
  closed,
);
export type ProfileEntry = Static<typeof ProfileEntry>;

export const ProfilePack = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: 48 }), entries: Type.Array(ProfileEntry) },
  closed,
);
export type ProfilePack = Static<typeof ProfilePack>;

/** profile：有序的插件包，按顺序展开后再依次应用 patch。 */
export const Profile = Type.Object({ name: PluginId, packs: Type.Array(ProfilePack) }, closed);
export type Profile = Static<typeof Profile>;

export const PatchOp = Type.Union([
  Type.Object({ op: Type.Literal('replace'), entry: ProfileEntry }, closed),
  Type.Object(
    { op: Type.Literal('insert'), entry: ProfileEntry, after: Type.Optional(PluginId) },
    closed,
  ),
  Type.Object({ op: Type.Literal('disable'), id: PluginId }, closed),
  Type.Object({ op: Type.Literal('enable'), id: PluginId }, closed),
]);
export type PatchOp = Static<typeof PatchOp>;

export const ProfilePatch = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: 48 }), ops: Type.Array(PatchOp) },
  closed,
);
export type ProfilePatch = Static<typeof ProfilePatch>;

/** sidecar 握手：宿主依次调用 describe 与 health，核对后才注册其服务。 */
export const SidecarDescribe = 'sidecar.describe';
export const SidecarHealth = 'sidecar.health';
export const SIDECAR_PROTOCOL = 1;

export const SidecarDescription = Type.Object(
  {
    protocol: Type.Literal(SIDECAR_PROTOCOL),
    provides: Type.Array(ServiceRef),
    permissions: Type.Array(Permission),
  },
  closed,
);
export type SidecarDescription = Static<typeof SidecarDescription>;

/**
 * sidecar 进程的电源节流状态（Windows 的 QoS，见 Windows 平台“定时与调度”），每次健康检查时读回：
 * `high` 显式 HighQoS；`eco` 显式 EcoQoS（例如任务管理器的“效率模式”）；`default` 没有显式设置、由系统管理；
 * `unknown` 读取失败；`unsupported` 不是 Windows。
 */
export const SidecarQos = Type.Union([
  Type.Literal('high'),
  Type.Literal('eco'),
  Type.Literal('default'),
  Type.Literal('unknown'),
  Type.Literal('unsupported'),
]);
export type SidecarQos = Static<typeof SidecarQos>;

/** Python sidecar 运行时总是带 `qos`；不读节流状态的 sidecar（例如 Node 实现）不带。 */
export const SidecarHealthResult = Type.Object(
  {
    ok: Type.Boolean(),
    detail: Type.Optional(Type.String({ maxLength: 200 })),
    qos: Type.Optional(SidecarQos),
  },
  closed,
);
export type SidecarHealthResult = Static<typeof SidecarHealthResult>;
