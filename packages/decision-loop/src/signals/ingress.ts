import { SignalSchema } from "@bellis/contracts";
import type { IngestedSignal, SignalPriorityClass } from "@bellis/contracts";
import type { LoopLogger, LoopMetrics } from "../observability.js";
import { classifySignal, type SignalPriorityPolicy } from "./priority.js";
import type { SignalAppendOutcome, SignalStorePort } from "./store.js";

/**
 * Signal Ingress（phase-3-development-guide.md §6.1）。
 *
 * - 所有输入先经 SignalSchema 与来源策略，不允许 Route 直接触发模型；
 * - append+投递串行化（内部链式 mutex）：投递给 Batcher 的顺序与
 *   序号顺序一致；
 * - 重复来源事件幂等（回显原序号），不生成第二个水位；
 * - 墙钟只记录事件事实（receivedAtMs），窗口与 Deadline 由 Batcher
 *   用单调时钟决定；
 * - 拒绝可观测：metrics + 可选审计钩子（宿主持久化 phase3 记录）。
 */
export type IngestResult =
  | {
      readonly result: "accepted";
      readonly sequence: bigint;
      readonly priorityClass: SignalPriorityClass;
    }
  | {
      readonly result: "deduplicated";
      readonly sequence: bigint;
      readonly priorityClass: SignalPriorityClass;
    }
  | {
      readonly result: "rejected";
      readonly reason: "invalid_signal" | "normal_capacity" | "urgent_capacity";
    };

/** 已入库信号的同步下游（Batcher 注册；缺省丢弃供恢复装配使用）。 */
export type IngestedSignalSink = (ingested: IngestedSignal) => void;

export interface SignalIngressOptions {
  readonly store: SignalStorePort;
  readonly policy: SignalPriorityPolicy;
  readonly wallClockMs: () => number;
  readonly sink: IngestedSignalSink;
  readonly logger?: LoopLogger;
  readonly metrics?: LoopMetrics;
  readonly audit?: (payload: {
    readonly signalId: string;
    readonly result: "accepted" | "deduplicated" | "rejected";
    readonly sequence?: bigint;
    readonly priorityClass?: SignalPriorityClass;
    readonly reason?: string;
  }) => void;
}

export class SignalIngress {
  readonly #options: SignalIngressOptions;
  #chain: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(options: SignalIngressOptions) {
    this.#options = options;
  }

  /** 入口：校验 → 分类 → 持久化分配序号 → 投递 Batcher。 */
  ingest(input: unknown): Promise<IngestResult> {
    if (this.#closed) {
      return Promise.resolve({ result: "rejected", reason: "invalid_signal" });
    }
    const run = this.#chain.then(() => this.#ingestSerialized(input));
    // 链只承载互斥顺序，不传播前一个失败。
    this.#chain = run.catch(() => undefined);
    return run;
  }

  close(): void {
    this.#closed = true;
  }

  async #ingestSerialized(input: unknown): Promise<IngestResult> {
    const parsed = SignalSchema.safeParse(input);
    if (!parsed.success) {
      this.#options.metrics
        ?.counter("bellis_signal_ingress_total", {
          result: "rejected",
          priority_class: "normal",
        })
        .inc();
      this.#options.audit?.({
        signalId: "unknown",
        result: "rejected",
        reason: "invalid_signal",
      });
      return { result: "rejected", reason: "invalid_signal" };
    }
    const signal = parsed.data;
    const priorityClass = classifySignal(signal, this.#options.policy);
    const outcome: SignalAppendOutcome = await this.#options.store.append(signal, priorityClass);
    if (outcome.result === "rejected") {
      const reason = outcome.reason === "urgent_capacity" ? "urgent_capacity" : "normal_capacity";
      this.#options.metrics
        ?.counter("bellis_signal_ingress_total", {
          result: "rejected",
          priority_class: priorityClass,
        })
        .inc();
      this.#options.logger?.log("warn", "signal_ingress_rejected", {
        reason,
        kind: signal.kind,
      });
      this.#options.audit?.({
        signalId: signal.id,
        result: "rejected",
        priorityClass,
        reason,
      });
      return { result: "rejected", reason };
    }
    this.#options.metrics
      ?.counter("bellis_signal_ingress_total", {
        result: outcome.result,
        priority_class: priorityClass,
      })
      .inc();
    if (outcome.result === "deduplicated") {
      this.#options.audit?.({
        signalId: signal.id,
        result: "deduplicated",
        sequence: outcome.sequence,
        priorityClass,
      });
      return { result: "deduplicated", sequence: outcome.sequence, priorityClass };
    }
    const ingested: IngestedSignal = {
      schemaVersion: 1,
      signalId: signal.id,
      sequence: outcome.sequence.toString(10),
      priorityClass,
      receivedAtMs: this.#options.wallClockMs(),
      signal,
    };
    this.#options.sink(ingested);
    this.#options.audit?.({
      signalId: signal.id,
      result: "accepted",
      sequence: outcome.sequence,
      priorityClass,
    });
    return { result: "accepted", sequence: outcome.sequence, priorityClass };
  }
}
