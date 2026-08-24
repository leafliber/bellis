/**
 * Phase 1 指标定义（docs/phase-1-reference.md）。
 *
 * - 每个指标声明类型、说明与 Label Allowlist；未列入 Allowlist 的 Label
 *   会被 Registry 拒绝，从源头阻断高基数。
 * - 高基数业务 ID（traceId/sessionId/messageId/sceneId/outboxId/userId 等）
 *   被 BLOCKED_METRIC_LABEL_NAMES 硬禁止，任何定义都不得把它们作为 Label。
 */

export type MetricKind = "counter" | "gauge" | "histogram";

export interface MetricDefinition {
  readonly name: string;
  readonly kind: MetricKind;
  readonly help: string;
  /** Label Allowlist：只有列出的 Label 名合法。 */
  readonly labels: readonly string[];
  /** Histogram 的升序有限上界（含）；超出最后边界落入隐式 +Inf 桶。 */
  readonly buckets?: readonly number[];
}

/** 禁止作为 Metric Label 的高基数标识名。 */
const BLOCKED_LABEL_NAMES = [
  "traceId",
  "sessionId",
  "turnId",
  "cycleId",
  "sceneId",
  "cueId",
  "toolRunId",
  "messageId",
  "recordId",
  "outboxId",
  "userId",
] as const;

export const BLOCKED_METRIC_LABEL_NAMES: readonly string[] = Object.freeze([
  ...BLOCKED_LABEL_NAMES,
]);

export const METRIC_NAME_PATTERN = /^bellis_[a-z][a-z0-9_]*$/;

/**
 * 原始定义（模块私有）：公开导出的是逐层 Object.freeze 的副本。
 * readonly 只在编译期生效，公开可变数组会在运行时绕过高基数禁令
 * （labels.push("sessionId") 即可注入），因此必须运行期冻结。
 */
const RAW_PHASE_1_METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  {
    name: "bellis_ws_connections",
    kind: "gauge",
    help: "当前活跃的 WebSocket 连接数（channel=control|media）。",
    labels: ["channel"],
  },
  {
    name: "bellis_ws_queue_messages",
    kind: "gauge",
    help: "每连接待发送队列中的消息数（channel=control|media）。",
    labels: ["channel"],
  },
  {
    name: "bellis_ws_queue_bytes",
    kind: "gauge",
    help: "每连接待发送队列中的字节总数（channel=control|media）。",
    labels: ["channel"],
  },
  {
    name: "bellis_ws_dropped_messages_total",
    kind: "counter",
    help: "被队列策略丢弃的消息总数（reason=overflow|closed|invalid）。",
    labels: ["channel", "reason"],
  },
  {
    name: "bellis_clock_rtt_us",
    kind: "histogram",
    help: "时钟同步 RTT（微秒）。",
    labels: [],
    buckets: [250, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000],
  },
  {
    name: "bellis_clock_offset_us",
    kind: "gauge",
    help: "最近一次时钟同步的偏移量（微秒，可为负）。",
    labels: [],
  },
  {
    name: "bellis_db_operation_duration_ms",
    kind: "histogram",
    help: "DB Worker RPC 操作耗时（毫秒，operation 为 RPC 名）。",
    labels: ["operation"],
    buckets: [0.5, 1, 2.5, 5, 10, 25, 50, 100, 250],
  },
  {
    name: "bellis_db_worker_queue_depth",
    kind: "gauge",
    help: "DB Worker 待处理请求数。",
    labels: [],
  },
  {
    name: "bellis_outbox_pending",
    kind: "gauge",
    help: "Outbox 中待交付消息数（topic 为业务主题）。",
    labels: ["topic"],
  },
  {
    name: "bellis_outbox_delivery_total",
    kind: "counter",
    help: "Outbox 交付结果计数（result=delivered|retry|dead）。",
    labels: ["result"],
  },
  {
    name: "bellis_scene_commit_total",
    kind: "counter",
    help: "Scene Commit 结果计数（result=committed|duplicate|conflict|error）。",
    labels: ["result"],
  },
  {
    name: "bellis_scene_commit_duration_ms",
    kind: "histogram",
    help: "Scene Commit 事务耗时（毫秒）。",
    labels: [],
    buckets: [1, 2.5, 5, 10, 25, 50, 100, 250, 500],
  },
];

/**
 * Phase 2 指标定义（docs/phase-2-development-guide.md §13 Runtime 侧名单）。
 * bellis_stage_*（Stage 侧时钟/音频缓冲/重连）由 Stage 上报路径承载，
 * 不在 Runtime Registry 注册。
 */
const RAW_PHASE_2_METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  {
    name: "bellis_scene_prepare_duration_ms",
    kind: "histogram",
    help: "Scene Prepare（含 Stage 往返）耗时（毫秒，result=ready|unavailable）。",
    labels: ["result"],
    buckets: [1, 2.5, 5, 10, 25, 50, 100, 250, 500],
  },
  {
    name: "bellis_scene_barrier_wait_ms",
    kind: "histogram",
    help: "Prepare Barrier 等待耗时（毫秒，level=hard|soft，result=ready|unavailable）。",
    labels: ["level", "result"],
    buckets: [1, 2.5, 5, 10, 25, 50, 100, 250, 500],
  },
  {
    name: "bellis_scene_start_skew_ms",
    kind: "histogram",
    help: "同 Scene 各 Lane 起始时刻相对首 Lane 的偏差（毫秒，lane 为 Lane 名）。",
    labels: ["lane"],
    buckets: [0.5, 1, 2.5, 5, 10, 25, 50, 100],
  },
  {
    name: "bellis_scene_cancel_latency_ms",
    kind: "histogram",
    help: "取消链路时延（毫秒，lane/result 为取消结算视图）。",
    labels: ["lane", "result"],
    buckets: [1, 2.5, 5, 10, 25, 50, 100, 250],
  },
  {
    name: "bellis_scene_execution_total",
    kind: "counter",
    help: "Scene 执行终态计数（result=completed|cancelled|failed|uncertain）。",
    labels: ["result"],
  },
];

function freezeDefinition(definition: MetricDefinition): MetricDefinition {
  const frozen: MetricDefinition = Object.freeze({
    ...definition,
    labels: Object.freeze([...definition.labels]),
    ...(definition.buckets === undefined
      ? {}
      : { buckets: Object.freeze([...definition.buckets]) }),
  });
  return frozen;
}

/** Phase 1 指标定义：对象、labels、buckets 与外层数组全部运行期冻结。 */
export const PHASE_1_METRIC_DEFINITIONS: readonly MetricDefinition[] = Object.freeze(
  RAW_PHASE_1_METRIC_DEFINITIONS.map(freezeDefinition),
);

/** Phase 2 指标定义（同上冻结）。 */
export const PHASE_2_METRIC_DEFINITIONS: readonly MetricDefinition[] = Object.freeze(
  RAW_PHASE_2_METRIC_DEFINITIONS.map(freezeDefinition),
);

/** Registry 接受的完整指标目录（Phase 1 + Phase 2）。 */
export const METRIC_DEFINITIONS: readonly MetricDefinition[] = Object.freeze([
  ...PHASE_1_METRIC_DEFINITIONS,
  ...PHASE_2_METRIC_DEFINITIONS,
]);
