import { AudienceBatchSchema } from "@bellis/contracts";
import type { AudienceBatch, IngestedSignal, MonotonicClock } from "@bellis/contracts";
import type { LoopLogger, LoopMetrics } from "../observability.js";
import { clusterSignals, estimateTokens, readSignalText } from "./cluster.js";

/**
 * 确定性自适应 Audience Batcher（phase-3-development-guide.md §6.2）。
 *
 * - 窗口 200–500 ms 自适应：窗口打开时按积压深度选择（确定性策略，
 *   不依赖到达时刻的随机性）；Deadline 用单调时钟；
 * - 达到消息数/Token/字节上限即封窗；urgent Signal 立即封窗
 *   （不等待普通窗口），Batch 区间保持闭区间连续无重叠
 *   （ADR 0004 §1）；
 * - Batch 区间覆盖 [上一封窗序号+1 .. 本窗最大序号]：区间内被拒
 *   （容量）的信号不占序号；被接受的普通信号进 highlights 聚类、
 *   urgent 进 urgentSignals；
 * - 输出再次通过 AudienceBatchSchema 校验（防御性），失败即抛错
 *   （生产者 bug，不允许静默发出非法 Batch）。
 */
export type BatchSealTrigger =
  | "deadline"
  | "count"
  | "token_budget"
  | "byte_budget"
  | "urgent_bypass"
  | "close";

export interface BatcherConfig {
  readonly minWindowMs: number;
  readonly maxWindowMs: number;
  /** 积压 ≥ low 时窗口延伸到 midWindowMs；≥ high 时到 maxWindowMs。 */
  readonly midWindowMs: number;
  readonly extendBacklogLow: number;
  readonly extendBacklogHigh: number;
  readonly maxMessages: number;
  readonly maxTokenEstimate: number;
  readonly maxTextBytes: number;
}

export const DEFAULT_BATCHER_CONFIG: BatcherConfig = {
  minWindowMs: 200,
  midWindowMs: 350,
  maxWindowMs: 500,
  extendBacklogLow: 8,
  extendBacklogHigh: 32,
  maxMessages: 64,
  maxTokenEstimate: 4_000,
  maxTextBytes: 16_384,
};

export interface BatchSealInfo {
  readonly trigger: BatchSealTrigger;
  readonly openedAtUs: bigint | null;
  readonly sealedAtUs: bigint;
  /** 实际封窗时刻 − 窗口打开时刻（受驱动方唤醒时机影响）。 */
  readonly latencyMs: number;
  /** 窗口配置长度（Deadline − 打开时刻；≤ maxWindowMs）。 */
  readonly windowMs: number;
  readonly messageCount: number;
  readonly urgentCount: number;
  readonly watermarkFrom: bigint;
  readonly watermarkTo: bigint;
}

export interface AudienceBatcherOptions {
  readonly clock: MonotonicClock;
  readonly config?: Partial<BatcherConfig>;
  readonly nextBatchId: () => string;
  readonly onBatch: (batch: AudienceBatch, info: BatchSealInfo) => void;
  readonly logger?: LoopLogger;
  readonly metrics?: LoopMetrics;
}

const SCHEMA_LIMITS = {
  maxHighlights: 100,
  maxTopics: 32,
  maxExamples: 10,
  maxUrgent: 64,
} as const;

export class AudienceBatcher {
  readonly #clock: MonotonicClock;
  readonly #config: BatcherConfig;
  readonly #options: AudienceBatcherOptions;
  #pendingNormal: IngestedSignal[] = [];
  #windowDeadlineUs: bigint | null = null;
  #windowOpenedUs: bigint | null = null;
  #lastSealedTo = 0n;
  #closed = false;

  constructor(options: AudienceBatcherOptions) {
    this.#options = options;
    this.#clock = options.clock;
    this.#config = { ...DEFAULT_BATCHER_CONFIG, ...options.config };
  }

  /** 恢复消费水位与未消费信号（ADR 0004 §7：旧窗口不恢复 Deadline）。 */
  restore(pending: readonly IngestedSignal[], consumed: bigint): void {
    this.#lastSealedTo = consumed;
    const ordered = [...pending]
      .filter((entry) => BigInt(entry.sequence) > consumed)
      .sort((a, b) => (BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1));
    for (const ingested of ordered) {
      this.onIngested(ingested);
    }
  }

  /** 已分配序号且已入库信号的投递入口（Ingress 的 sink）。 */
  onIngested(ingested: IngestedSignal): void {
    if (this.#closed) {
      return;
    }
    if (ingested.priorityClass === "urgent") {
      this.#seal("urgent_bypass", ingested);
      return;
    }
    this.#pendingNormal.push(ingested);
    if (this.#windowOpenedUs === null || this.#windowDeadlineUs === null) {
      const nowUs = this.#clock.nowUs();
      this.#windowOpenedUs = nowUs;
      this.#windowDeadlineUs =
        nowUs + BigInt(this.#windowMsFor(this.#pendingNormal.length) * 1_000);
      return;
    }
    // 窗口内随积压单调延伸（只延长不缩短）：突发洪峰把窗口推向
    // 350/500ms；延迟上限仍 ≤ maxWindowMs。
    const candidate =
      this.#windowOpenedUs + BigInt(this.#windowMsFor(this.#pendingNormal.length) * 1_000);
    if (candidate > this.#windowDeadlineUs) {
      this.#windowDeadlineUs = candidate;
    }
    if (this.#pendingNormal.length >= this.#config.maxMessages) {
      this.#seal("count", null);
      return;
    }
    if (this.#pendingTokenEstimate() >= this.#config.maxTokenEstimate) {
      this.#seal("token_budget", null);
      return;
    }
    if (this.#pendingTextBytes() >= this.#config.maxTextBytes) {
      this.#seal("byte_budget", null);
      return;
    }
  }

  /** 到期驱动（Pipeline 的定时循环调用）。 */
  onDeadline(nowUs: bigint): void {
    if (this.#closed || this.#windowDeadlineUs === null || nowUs < this.#windowDeadlineUs) {
      return;
    }
    this.#seal("deadline", null);
  }

  /** 当前窗口 Deadline（无窗口为 null）；Pipeline 据此 sleepUntil。 */
  get currentDeadlineUs(): bigint | null {
    return this.#windowDeadlineUs;
  }

  /** 优雅关闭：立即封窗投递（宿主随后取消触发器与等待者）。 */
  sealRemaining(): void {
    if (this.#closed) {
      return;
    }
    if (this.#pendingNormal.length > 0 || this.#windowDeadlineUs !== null) {
      this.#seal("close", null);
    }
    this.#closed = true;
  }

  /** 硬关闭：丢弃窗口（信号仍在持久化存储中，重启重建）。 */
  cancelWindow(): void {
    this.#closed = true;
    this.#pendingNormal = [];
    this.#windowDeadlineUs = null;
    this.#windowOpenedUs = null;
  }

  get pendingCount(): number {
    return this.#pendingNormal.length;
  }

  #windowMsFor(backlog: number): number {
    if (backlog >= this.#config.extendBacklogHigh) {
      return this.#config.maxWindowMs;
    }
    if (backlog >= this.#config.extendBacklogLow) {
      return this.#config.midWindowMs;
    }
    return this.#config.minWindowMs;
  }

  #pendingTokenEstimate(): number {
    return this.#pendingNormal.reduce(
      (sum, entry) => sum + estimateTokens(readSignalText(entry.signal) ?? ""),
      0,
    );
  }

  #pendingTextBytes(): number {
    return this.#pendingNormal.reduce(
      (sum, entry) => sum + Buffer.byteLength(readSignalText(entry.signal) ?? "", "utf8"),
      0,
    );
  }

  #seal(trigger: BatchSealTrigger, urgent: IngestedSignal | null): void {
    const nowUs = this.#clock.nowUs();
    const intervalFrom = this.#lastSealedTo + 1n;
    const lastPendingSeq = this.#pendingNormal.reduce((max, entry) => {
      const seq = BigInt(entry.sequence);
      return seq > max ? seq : max;
    }, 0n);
    const urgentSeq = urgent === null ? 0n : BigInt(urgent.sequence);
    const intervalTo = lastPendingSeq > urgentSeq ? lastPendingSeq : urgentSeq;
    if (intervalTo < intervalFrom && this.#pendingNormal.length === 0 && urgent === null) {
      return;
    }
    const clustered = clusterSignals(this.#pendingNormal, SCHEMA_LIMITS);
    const urgentSignals =
      urgent === null
        ? []
        : [
            {
              schemaVersion: 1 as const,
              id: urgent.signal.id,
              kind: urgent.signal.kind,
              source: urgent.signal.source,
              occurredAt: urgent.signal.occurredAt,
              priority: urgent.signal.priority,
              payload: urgent.signal.payload,
            },
          ];
    const draft: AudienceBatch = {
      schemaVersion: 1,
      id: this.#options.nextBatchId(),
      watermarkFrom: intervalFrom.toString(10),
      watermarkTo: intervalTo.toString(10),
      highlights: [...clustered.highlights],
      topics: [...clustered.topics],
      urgentSignals,
      tokenEstimate:
        clustered.tokenEstimate +
        urgentSignals.reduce((sum, signal) => sum + estimateTokens(signal.kind), 0),
    };
    const check = AudienceBatchSchema.safeParse(draft);
    if (!check.success) {
      // 生产者 bug：非法 Batch 不允许静默投递。
      throw new Error(`audience batcher produced invalid batch: ${check.error.message}`);
    }
    this.#lastSealedTo = intervalTo;
    this.#pendingNormal = [];
    const deadlineAtSeal = this.#windowDeadlineUs;
    this.#windowDeadlineUs = null;
    const openedAtUs = this.#windowOpenedUs;
    this.#windowOpenedUs = null;
    const info: BatchSealInfo = {
      trigger,
      openedAtUs,
      sealedAtUs: nowUs,
      latencyMs: Number((nowUs - (openedAtUs ?? nowUs)) / 1000n),
      windowMs:
        deadlineAtSeal !== null && openedAtUs !== null
          ? Number((deadlineAtSeal - openedAtUs) / 1000n)
          : 0,
      messageCount: clustered.highlights.length + clustered.truncatedHighlights,
      urgentCount: urgentSignals.length,
      watermarkFrom: intervalFrom,
      watermarkTo: intervalTo,
    };
    this.#options.metrics
      ?.histogram("bellis_audience_batch_latency_ms", {
        trigger,
      })
      .observe(info.latencyMs);
    this.#options.onBatch(check.data, info);
  }
}
