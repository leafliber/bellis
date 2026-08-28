import type { IngestedSignal, MonotonicClock } from "@bellis/contracts";
import { AudienceBatcher, type BatchSealInfo } from "./batcher/audience-batcher.js";
import type { BatcherConfig } from "./batcher/audience-batcher.js";
import type { LoopLogger, LoopMetrics } from "./observability.js";
import type { IngestResult } from "./signals/ingress.js";
import { SignalIngress } from "./signals/ingress.js";
import { DEFAULT_PRIORITY_POLICY, type SignalPriorityPolicy } from "./signals/priority.js";
import type { SignalStorePort } from "./signals/store.js";
import {
  DecisionTrigger,
  type DecisionTriggerConfig,
  type TurnOwnerPort,
} from "./trigger/decision-trigger.js";
import type { AudienceBatch } from "@bellis/contracts";

/**
 * Signal Pipeline 宿主：Ingress → Batcher → Trigger 的装配与生命周期
 * （phase-3-development-guide.md §6）。
 *
 * - 定时循环用 MonotonicClock.sleepUntil（测试注入 VirtualClock）；
 * - 启动时从 SignalStorePort 恢复未消费信号与水位（ADR 0004 §7）；
 * - 关闭顺序：Ingress 停止 → 窗口丢弃（信号已在持久化存储）→
 *   Trigger 清空 → 等待者全部释放；
 * - Cycle adoption 成功后宿主调用 markConsumed 推进持久化水位。
 */
export interface SignalPipelineOptions {
  readonly sessionId: string;
  readonly clock: MonotonicClock;
  readonly wallClockMs: () => number;
  readonly store: SignalStorePort;
  readonly owner: TurnOwnerPort;
  readonly nextBatchId: () => string;
  readonly priorityPolicy?: Partial<SignalPriorityPolicy>;
  readonly batcherConfig?: Partial<BatcherConfig>;
  readonly triggerConfig?: Partial<DecisionTriggerConfig>;
  readonly logger?: LoopLogger;
  readonly metrics?: LoopMetrics;
}

export class SignalPipeline {
  readonly #options: SignalPipelineOptions;
  readonly #batcher: AudienceBatcher;
  readonly #trigger: DecisionTrigger;
  readonly #ingress: SignalIngress;
  readonly #closeController = new AbortController();
  #started = false;
  #closed = false;
  #wakeup: (() => void) | null = null;
  #lastSealInfo: BatchSealInfo | null = null;
  #lastBatch: AudienceBatch | null = null;
  readonly #sealedBatches: { batch: AudienceBatch; info: BatchSealInfo }[] = [];

  constructor(options: SignalPipelineOptions) {
    this.#options = options;
    this.#trigger = new DecisionTrigger({
      owner: options.owner,
      ...(options.triggerConfig === undefined ? {} : { config: options.triggerConfig }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
    });
    this.#batcher = new AudienceBatcher({
      clock: options.clock,
      ...(options.batcherConfig === undefined ? {} : { config: options.batcherConfig }),
      nextBatchId: options.nextBatchId,
      onBatch: (batch, info) => {
        this.#lastBatch = batch;
        this.#lastSealInfo = info;
        this.#sealedBatches.push({ batch, info });
        this.#trigger.submit(batch);
      },
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
    });
    this.#ingress = new SignalIngress({
      store: options.store,
      policy: { ...DEFAULT_PRIORITY_POLICY, ...options.priorityPolicy },
      wallClockMs: options.wallClockMs,
      sink: (ingested) => {
        this.#batcher.onIngested(ingested);
        this.#pump();
      },
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
    });
  }

  /** 启动：恢复持久化状态并进入定时循环（幂等）。 */
  async start(): Promise<void> {
    if (this.#started || this.#closed) {
      return;
    }
    this.#started = true;
    const state = await this.#options.store.restore();
    this.#batcher.restore(state.pending, state.consumed);
    this.#pump();
    void this.#runLoop();
  }

  ingest(input: unknown): Promise<IngestResult> {
    return this.#ingress.ingest(input);
  }

  /** Cycle adoption 成功后推进持久化消费水位（宿主调用）。 */
  markConsumed(sequence: bigint): void {
    this.#options.store.markConsumed(sequence);
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#ingress.close();
    this.#batcher.cancelWindow();
    this.#trigger.close();
    this.#closeController.abort();
    const wakeup = this.#wakeup;
    this.#wakeup = null;
    wakeup?.();
  }

  /** 测试/审计视图：最近一次封窗。 */
  get lastSeal(): { batch: AudienceBatch; info: BatchSealInfo } | null {
    return this.#lastBatch === null || this.#lastSealInfo === null
      ? null
      : { batch: this.#lastBatch, info: this.#lastSealInfo };
  }

  /** 测试/审计视图：全部封窗历史（内存有界：随 Session 生命周期）。 */
  get sealedBatches(): readonly { batch: AudienceBatch; info: BatchSealInfo }[] {
    return this.#sealedBatches;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  async #runLoop(): Promise<void> {
    while (!this.#closed) {
      const deadline = this.#batcher.currentDeadlineUs;
      if (deadline === null) {
        if (this.#closed) {
          return;
        }
        await new Promise<void>((resolve) => {
          this.#wakeup = resolve;
        });
        continue;
      }
      try {
        await this.#options.clock.sleepUntil(deadline, this.#closeController.signal);
      } catch {
        return;
      }
      if (this.#closed) {
        return;
      }
      this.#batcher.onDeadline(this.#options.clock.nowUs());
    }
  }

  #pump(): void {
    const wakeup = this.#wakeup;
    this.#wakeup = null;
    wakeup?.();
  }
}

/** 恢复视图辅助：把恢复的 pending 转为序号列表（测试断言用）。 */
export function pendingSequences(pending: readonly IngestedSignal[]): bigint[] {
  return pending.map((entry) => BigInt(entry.sequence));
}
