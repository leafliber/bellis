import Type, { type Static } from 'typebox';

/**
 * 遥测的跨进程部分（R-21，见运维“观测”）。
 *
 * - 宿主调用 sidecar 的 JSON-RPC 请求在参数里带 W3C `traceparent`，sidecar 以它为父写自己的 span；
 * - 宿主经环境变量 `BELLIS_TELEMETRY`（{@link SidecarTelemetry} 的 JSON）告诉 sidecar 把 JSONL 写到哪里、
 *   怎样轮转；没有这个变量（或不合格）时 sidecar 不写遥测，其余照常。
 */

const closed = { additionalProperties: false } as const;

/** W3C Trace Context 的 `traceparent`，只用版本 00：`00-<trace-id>-<parent-id>-<flags>`，小写十六进制。 */
export const Traceparent = Type.String({ pattern: '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$' });
export type Traceparent = Static<typeof Traceparent>;

/** 宿主告诉 sidecar 的遥测输出：与宿主写在同一目录，文件名按进程区分，轮转规则相同。 */
export const SidecarTelemetry = Type.Object(
  {
    v: Type.Literal(1),
    /** 写 JSONL 的目录（绝对路径）。 */
    dir: Type.String({ minLength: 1, maxLength: 1024 }),
    /** 单个文件写到这么大就换新文件。 */
    maxFileBytes: Type.Integer({ minimum: 65_536 }),
    /** 单个文件写了这么久就换新文件。 */
    maxFileAgeMs: Type.Integer({ minimum: 1000 }),
    /** 同一进程角色的文件最多保留这么多个，更早的删除。 */
    maxFiles: Type.Integer({ minimum: 1, maximum: 1000 }),
    /** 等待写出的记录上限，满了丢弃最旧的。 */
    maxQueue: Type.Integer({ minimum: 1 }),
    /** 分批写出的间隔。 */
    flushIntervalMs: Type.Integer({ minimum: 1 }),
  },
  closed,
);
export type SidecarTelemetry = Static<typeof SidecarTelemetry>;
