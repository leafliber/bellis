import type { IngestedSignal, Signal, SignalPriorityClass } from "@bellis/contracts";

/**
 * Signal 持久化 Port（P0 冻结语义 1/2；ADR 0004 §1）。
 *
 * 生产实现（P4）在入库事务内分配单调序号并持久化 IngestedSignal；
 * 本包只依赖接口。序号 1 起、Session 内单调无缺口；同一来源内重复 signalId
 * 返回 deduplicated 并回显原序号；容量满在分配序号前拒绝
 * （被拒信号不占用序号空间，审计事实由宿主记录）。
 */
export type SignalAppendOutcome =
  | { readonly result: "accepted"; readonly sequence: bigint }
  | { readonly result: "deduplicated"; readonly sequence: bigint }
  | {
      readonly result: "rejected";
      readonly reason: "normal_capacity" | "urgent_capacity";
    };

export interface SignalRestoreState {
  /** 未消费信号（按序号升序）。 */
  readonly pending: readonly IngestedSignal[];
  /** 最后分配序号（无信号时 0n）。 */
  readonly lastAssigned: bigint;
  /** 已消费水位（Batch adoption 前进；无消费时 0n）。 */
  readonly consumed: bigint;
}

export interface SignalStorePort {
  append(signal: Signal, priorityClass: SignalPriorityClass): Promise<SignalAppendOutcome>;
  /** 启动恢复：从持久化事实重建内存管道（ADR 0004 §7）。 */
  restore(): Promise<SignalRestoreState>;
  /** Cycle adoption 成功后推进消费水位（幂等；只能前进）。 */
  markConsumed(sequence: bigint): void;
}

export interface SignalStoreCapacity {
  readonly normalCapacity: number;
  readonly urgentCapacity: number;
  /** 去重键记忆上限（有界；超限逐出最旧）。 */
  readonly dedupeCapacity: number;
}

/**
 * 进程内实现：测试与开发装配。语义与持久化实现一致——
 * 序号单调无缺口、去重幂等、容量显式、markConsumed 单调。
 */
export class InMemorySignalStore implements SignalStorePort {
  readonly #capacity: SignalStoreCapacity;
  readonly #seen = new Map<string, bigint>();
  #lastAssigned = 0n;
  #consumed = 0n;
  #pendingNormal: IngestedSignal[] = [];
  #pendingUrgent: IngestedSignal[] = [];
  readonly #all: IngestedSignal[] = [];

  constructor(capacity: SignalStoreCapacity) {
    this.#capacity = capacity;
  }

  async append(signal: Signal, priorityClass: SignalPriorityClass): Promise<SignalAppendOutcome> {
    const key = JSON.stringify([signal.source, signal.id]);
    const existing = this.#seen.get(key);
    if (existing !== undefined) {
      return { result: "deduplicated", sequence: existing };
    }
    const queue = priorityClass === "urgent" ? this.#pendingUrgent : this.#pendingNormal;
    if (
      queue.length >=
      (priorityClass === "urgent" ? this.#capacity.urgentCapacity : this.#capacity.normalCapacity)
    ) {
      return {
        result: "rejected",
        reason: priorityClass === "urgent" ? "urgent_capacity" : "normal_capacity",
      };
    }
    this.#lastAssigned += 1n;
    this.#seen.set(key, this.#lastAssigned);
    if (this.#seen.size > this.#capacity.dedupeCapacity) {
      const oldest = this.#seen.keys().next().value;
      if (oldest !== undefined) {
        this.#seen.delete(oldest);
      }
    }
    const ingested: IngestedSignal = {
      schemaVersion: 1,
      signalId: signal.id,
      sequence: this.#lastAssigned.toString(10),
      priorityClass,
      receivedAtMs: signal.occurredAt,
      signal,
    };
    queue.push(ingested);
    this.#all.push(ingested);
    return { result: "accepted", sequence: this.#lastAssigned };
  }

  async restore(): Promise<SignalRestoreState> {
    const pending = this.#all.filter((entry) => BigInt(entry.sequence) > this.#consumed);
    return { pending, lastAssigned: this.#lastAssigned, consumed: this.#consumed };
  }

  markConsumed(sequence: bigint): void {
    if (sequence < this.#consumed) {
      throw new Error(
        `consumed watermark must not regress (current=${this.#consumed}, got=${sequence})`,
      );
    }
    if (sequence <= this.#consumed) {
      return;
    }
    this.#consumed = sequence;
    this.#pendingNormal = this.#pendingNormal.filter((entry) => BigInt(entry.sequence) > sequence);
    this.#pendingUrgent = this.#pendingUrgent.filter((entry) => BigInt(entry.sequence) > sequence);
  }

  /** 测试视图：当前未消费计数（按类）。 */
  pendingCounts(): { normal: number; urgent: number } {
    return { normal: this.#pendingNormal.length, urgent: this.#pendingUrgent.length };
  }

  get consumed(): bigint {
    return this.#consumed;
  }
}
