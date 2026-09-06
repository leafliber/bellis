import type { AudienceBatch } from "@bellis/contracts";
import type { LoopLogger, LoopMetrics } from "../observability.js";

/**
 * Decision Trigger 与 Mailbox（phase-3-development-guide.md §6.3）。
 *
 * ```text
 * idle + normal batch     → start Turn（normal_batch）
 * busy + interrupt        → 回收未采用 Batch → cancel 活跃子任务 → 合并为
 *                           覆盖完整未消费区间的 interrupt Batch → urgent Turn
 * busy + next_cycle       → 并入下一 Cycle 快照（FIFO 为空时才允许）
 * busy + next_turn        → 有界 FIFO（满时合并最旧，不显式拒绝）
 * ```
 *
 * 区间连续性不变量（ADR 0004 §1）：Batch 的采用顺序必须与封窗顺序一致
 * ——消费水位只沿闭区间序列前进。interrupt 通过「回收活跃 Turn 与 FIFO
 * 中全部未采用 Batch + urgent Batch 合并为一个区间并集的 Batch」维持
 * 该不变量：被中断的输入不丢失、不跳号、不乱序。
 */
export interface TurnOwnerPort {
  /** 是否有空闲（无拥有提交权的 Turn）。 */
  isIdle(): boolean;
  /**
   * 取消活跃 Turn 的全部子任务（模型流/Prepare/Tool/可中断 Scene），
   * 返回消费水位尚未采用（未推进）的全部 Batch（区间升序）；
   * 空闲时返回空数组。取消不得绕过 Scene Director。
   */
  cancelActiveTurn(): readonly AudienceBatch[];
  /**
   * 启动 Turn；返回 false 表示无法接受（忙碌或已关闭）。trigger=interrupt 的
   * Batch 覆盖全部未消费区间（本 Trigger 合并保证）。
   */
  startTurn(batch: AudienceBatch, trigger: "normal_batch" | "interrupt" | "next_turn"): boolean;
  /**
   * 忙碌时并入下一 Cycle 快照；返回 false 表示不可合并
   * （如 Turn 正在收尾）→ 转入 next_turn 队列。
   */
  mergeIntoNextCycle(batch: AudienceBatch): boolean;
}

export interface DecisionTriggerConfig {
  /** next_turn FIFO 容量（合并前上限）。 */
  readonly mailboxCapacity: number;
}

export const DEFAULT_TRIGGER_CONFIG: DecisionTriggerConfig = { mailboxCapacity: 8 };

const MERGE_LIMITS = { maxHighlights: 100, maxUrgent: 64, maxTopics: 32, maxExamples: 10 } as const;

/** 合并两个相邻 Batch（区间取并；保序确定性：保留 newer 身份）。 */
export function mergeBatches(older: AudienceBatch, newer: AudienceBatch): AudienceBatch {
  const from =
    BigInt(older.watermarkFrom) < BigInt(newer.watermarkFrom)
      ? older.watermarkFrom
      : newer.watermarkFrom;
  const to =
    BigInt(older.watermarkTo) > BigInt(newer.watermarkTo) ? older.watermarkTo : newer.watermarkTo;
  const topicByLabel = new Map<
    string,
    { label: string; count: number; participants: number; examples: string[] }
  >();
  for (const topic of [...older.topics, ...newer.topics]) {
    const existing = topicByLabel.get(topic.label);
    if (existing === undefined) {
      topicByLabel.set(topic.label, {
        label: topic.label,
        count: topic.count,
        participants: topic.participants,
        examples: [...topic.examples],
      });
    } else {
      existing.count += topic.count;
      existing.participants += topic.participants;
      for (const example of topic.examples) {
        if (existing.examples.length < MERGE_LIMITS.maxExamples) {
          existing.examples.push(example);
        }
      }
    }
  }
  // highlights 保最新（旧弹幕在 Signal Record 留档，Batch 只是决策摘要）。
  const highlights = [...newer.highlights, ...older.highlights].slice(
    0,
    MERGE_LIMITS.maxHighlights,
  );
  const urgentSignals = [...newer.urgentSignals, ...older.urgentSignals].slice(
    0,
    MERGE_LIMITS.maxUrgent,
  );
  const topics = [...topicByLabel.values()]
    .map((topic) => ({
      schemaVersion: 1 as const,
      label: topic.label,
      count: topic.count,
      participants: topic.participants,
      examples: topic.examples.slice(0, MERGE_LIMITS.maxExamples),
    }))
    .toSorted((a, b) => b.count - a.count || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
    .slice(0, MERGE_LIMITS.maxTopics);
  return {
    schemaVersion: 1,
    id: newer.id,
    watermarkFrom: from,
    watermarkTo: to,
    highlights,
    topics,
    urgentSignals,
    tokenEstimate: older.tokenEstimate + newer.tokenEstimate,
  };
}

export class DecisionTrigger {
  readonly #options: DecisionTriggerOptions;
  readonly #mailboxCapacity: number;
  #mailbox: AudienceBatch[] = [];
  #closed = false;
  #interruptPending = false;

  constructor(options: DecisionTriggerOptions) {
    this.#options = options;
    this.#mailboxCapacity =
      options.config?.mailboxCapacity ?? DEFAULT_TRIGGER_CONFIG.mailboxCapacity;
  }

  /** Batch 到达（Batcher onBatch 的下游；封窗顺序调用）。 */
  submit(batch: AudienceBatch): void {
    if (this.#closed) {
      return;
    }
    if (batch.urgentSignals.length > 0) {
      this.#submitInterrupt(batch);
      return;
    }
    if (this.#options.owner.isIdle()) {
      this.#options.owner.startTurn(batch, "normal_batch");
      return;
    }
    // FIFO 非空时不得跳过排队 Batch 并入 next_cycle：采用顺序必须与
    // 封窗顺序一致，否则 Batch 区间连续性被破坏（水位倒退）。
    if (this.#mailbox.length === 0 && this.#options.owner.mergeIntoNextCycle(batch)) {
      return;
    }
    this.#enqueueNextTurn(batch);
  }

  /** TurnOwner 终态回调：排空 FIFO 启动下一个 Turn。 */
  notifyOwnerIdle(): void {
    if (this.#closed) {
      return;
    }
    while (this.#mailbox.length > 0 && this.#options.owner.isIdle()) {
      const next = this.#mailbox.shift();
      if (next === undefined) return;
      const trigger = this.#interruptPending ? "interrupt" : "next_turn";
      if (!this.#options.owner.startTurn(next, trigger)) {
        this.#mailbox.unshift(next);
        return;
      }
      this.#interruptPending = false;
    }
  }

  /** Session 关闭：清空 Mailbox，后续 submit 丢弃。 */
  close(): void {
    this.#closed = true;
    this.#mailbox = [];
  }

  get mailboxSize(): number {
    return this.#mailbox.length;
  }

  /** Mailbox 只读快照（审计/测试视图）。 */
  peekMailbox(): readonly AudienceBatch[] {
    return this.#mailbox;
  }

  /**
   * 批次回插队首（区间序早于现有 FIFO）：Turn 失败/正常结束时有
   * 未采用 Batch（下一轮未见输入）时由宿主调用——维持采用顺序。
   */
  requeueFront(batches: readonly AudienceBatch[]): void {
    if (this.#closed || batches.length === 0) {
      return;
    }
    this.#mailbox.unshift(...batches);
    while (this.#mailbox.length > this.#mailboxCapacity) {
      const oldest = this.#mailbox[0];
      const second = this.#mailbox[1];
      if (oldest === undefined || second === undefined) {
        break;
      }
      this.#mailbox.splice(0, 2, mergeBatches(oldest, second));
    }
  }

  #submitInterrupt(urgent: AudienceBatch): void {
    const reclaimed = this.#options.owner.cancelActiveTurn();
    const parts = [...reclaimed, ...this.#mailbox, urgent];
    this.#mailbox = [];
    let merged = parts[0];
    if (merged === undefined) {
      return;
    }
    for (let index = 1; index < parts.length; index += 1) {
      const part = parts[index];
      if (part !== undefined) {
        merged = mergeBatches(merged, part);
      }
    }
    this.#options.metrics?.counter("bellis_decision_interrupt_total").inc();
    this.#mailbox = [merged];
    this.#interruptPending = true;
    this.notifyOwnerIdle();
  }

  #enqueueNextTurn(batch: AudienceBatch): void {
    this.#mailbox.push(batch);
    while (this.#mailbox.length > this.#mailboxCapacity) {
      const oldest = this.#mailbox[0];
      const second = this.#mailbox[1];
      if (oldest === undefined || second === undefined) {
        break;
      }
      this.#mailbox.splice(0, 2, mergeBatches(oldest, second));
      this.#options.metrics?.counter("bellis_decision_mailbox_merged_total").inc();
    }
  }
}

export interface DecisionTriggerOptions {
  readonly owner: TurnOwnerPort;
  readonly config?: Partial<DecisionTriggerConfig>;
  readonly logger?: LoopLogger;
  readonly metrics?: LoopMetrics;
}
