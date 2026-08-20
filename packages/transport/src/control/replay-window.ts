import { parseDecimalString } from "@bellis/contracts";
import type { ServerControlEnvelope } from "@bellis/contracts";

/**
 * 服务端消息的有界 Replay Window（phase-1-build-guide.md §8.2；ADR 0001 §3）。
 *
 * - 每条服务端消息按分配顺序追加；窗口容量固定（默认 512），满时淘汰最旧。
 * - latestAssignedSeq 是单调计数器，不随剪枝回退；Session 可用它恢复 Seq 基线。
 * - replayAfter(lastAck)：lastAck 超过已分配最大 Seq → invalid_ahead（协议错误）；
 *   等于 → up_to_date；lastAck+1 早于窗口最旧条目，**或请求区间 (lastAck,
 *   latest] 内存在缺失 Seq** → snapshot_required（缺口由 P4 读取 Persistence 后
 *   发送 session.snapshot 补齐）；否则按原 Seq、原 messageId、原文重放。
 * - 缺口来源：跨重启恢复时 P4 只持久化 persistable=true 的 Replay 内容
 *   （瞬时 Pong 被过滤），以及防御性的 append 跳号。缺口以有序不相交区间
 *   记录，可由（条目集合, 水位）完整推导，无需持久化。
 * - 心跳/Clock Pong 等瞬时消息同样占用窗口（它们也消耗 Seq，排除会造成
 *   虚假缺口）；persistable=false 只表示**不持久化该消息的 Replay 内容**，
 *   最新分配水位（nextSeq）对包括瞬时消息在内的一切 Seq 推进都必须持久化，
 *   否则进程重启后会复用 Seq。
 */
export interface ReplayMessage {
  readonly seq: bigint;
  readonly messageId: string;
  /** 追加时编码的原始 JSON 文本；重放时按原文重发。 */
  readonly text: string;
  readonly envelope: ServerControlEnvelope;
  /** false 表示瞬时消息（heartbeat.pong / clock.pong）：不持久化其内容。 */
  readonly persistable: boolean;
}

export type ReplayOutcome =
  | { readonly status: "replay"; readonly messages: readonly ReplayMessage[] }
  | { readonly status: "snapshot_required" }
  | { readonly status: "up_to_date" }
  | { readonly status: "invalid_ahead" };

export interface ReplayWindowOptions {
  /** 窗口容量（消息条数），默认 512，必须 ≥ 1。 */
  readonly capacity?: number;
  /**
   * 恢复逻辑会话时的最新分配 Seq 水位（默认 0）。窗口内容可能已被全部
   * 确认而清空，但单调计数器必须从恢复水位继续，否则合法 ACK 会被
   * 误判为超前（invalid_ahead）。
   */
  readonly initialLatestSeq?: bigint;
}

/** [start, end] 闭区间内缺失的 Seq；区间有序且互不相交。 */
interface SeqGap {
  start: bigint;
  end: bigint;
}

const DEFAULT_REPLAY_CAPACITY = 512;

export class ReplayWindow {
  readonly #capacity: number;
  #entries: ReplayMessage[] = [];
  #gaps: SeqGap[] = [];
  #latestAssignedSeq: bigint;

  constructor(options: ReplayWindowOptions = {}) {
    const capacity = options.capacity ?? DEFAULT_REPLAY_CAPACITY;
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("replay window capacity must be a positive integer");
    }
    const initialLatestSeq = options.initialLatestSeq ?? 0n;
    if (initialLatestSeq < 0n) {
      throw new RangeError("initialLatestSeq must be non-negative");
    }
    this.#capacity = capacity;
    this.#latestAssignedSeq = initialLatestSeq;
  }

  get capacity(): number {
    return this.#capacity;
  }

  /** 已分配的最大 Seq（单调，不随剪枝回退）。 */
  latestAssignedSeq(): bigint {
    return this.#latestAssignedSeq;
  }

  append(message: ReplayMessage): void {
    if (message.seq <= this.#latestAssignedSeq) {
      throw new RangeError("replay window seq must strictly increase");
    }
    // 正常路径 seq = latest+1（Session 逐条连续分配）；跳号属防御性记录。
    if (message.seq > this.#latestAssignedSeq + 1n) {
      this.#recordGap(this.#latestAssignedSeq + 1n, message.seq - 1n);
    }
    this.#latestAssignedSeq = message.seq;
    this.#entries.push(message);
    this.#trimToCapacity();
  }

  /**
   * 恢复历史条目（resume 路径）：条目之间升序且不越过当前水位即可，
   * 不推进单调计数器（水位已由 initialLatestSeq 表达）。P4 跨重启只恢复
   * persistable=true 的条目时，被过滤的瞬时 Seq 会在条目之间或条目与水位
   * 之间留下缺口——在此推导并记录，供 replayAfter 判定 snapshot_required。
   */
  restore(messages: readonly ReplayMessage[]): void {
    let previous = 0n;
    for (const message of messages) {
      if (message.seq <= previous) {
        throw new RangeError("restored replay entries must strictly increase");
      }
      if (message.seq > this.#latestAssignedSeq) {
        throw new RangeError("restored replay entry exceeds the assigned seq watermark");
      }
      if (message.seq > previous + 1n) {
        this.#recordGap(previous + 1n, message.seq - 1n);
      }
      previous = message.seq;
    }
    if (this.#latestAssignedSeq > previous) {
      this.#recordGap(previous + 1n, this.#latestAssignedSeq);
    }
    this.#entries.push(...messages);
    this.#trimToCapacity();
  }

  /** 窗口内最旧 Seq；窗口为空时为 null。 */
  oldestSeq(): bigint | null {
    return this.#entries[0]?.seq ?? null;
  }

  /**
   * 客户端重连携带 lastAck（十进制字符串或 bigint）时的重放决策。
   * 只有当 (lastAck, latestAssignedSeq] 能被窗口条目**无缺口地完整覆盖**
   * 时才重放；累计 ACK 语义下任何缺口都意味着客户端无法推进确认，
   * 必须改走 snapshot。
   */
  replayAfter(lastAck: bigint | string): ReplayOutcome {
    const ack = typeof lastAck === "string" ? parseDecimalString(lastAck) : lastAck;
    if (ack > this.#latestAssignedSeq) {
      return { status: "invalid_ahead" };
    }
    if (ack === this.#latestAssignedSeq) {
      return { status: "up_to_date" };
    }
    const oldest = this.oldestSeq();
    if (oldest === null || ack + 1n < oldest) {
      return { status: "snapshot_required" };
    }
    for (const gap of this.#gaps) {
      // 缺口区间 ⊆ [1, latest]；与请求区间 (ack, latest] 相交即 end > ack。
      if (gap.end > ack) {
        return { status: "snapshot_required" };
      }
    }
    return { status: "replay", messages: this.#entries.filter((entry) => entry.seq > ack) };
  }

  /** ACK 推进后清理已确认条目与缺口，返回清理的条目数量。 */
  pruneThrough(seq: bigint): number {
    const before = this.#entries.length;
    this.#entries = this.#entries.filter((entry) => entry.seq > seq);
    // 客户端确认到 seq 意味着 ≤ seq 的消息已完整送达（含重启前收到的瞬时
    // 消息）：缺口中 ≤ seq 的部分不再是缺口。
    const gaps: SeqGap[] = [];
    for (const gap of this.#gaps) {
      if (gap.end <= seq) {
        continue;
      }
      gaps.push(gap.start <= seq ? { start: seq + 1n, end: gap.end } : gap);
    }
    this.#gaps = gaps;
    return before - this.#entries.length;
  }

  /** 窗口快照（按 Seq 升序），用于跨连接导出逻辑会话状态。 */
  snapshot(): readonly ReplayMessage[] {
    return [...this.#entries];
  }

  #recordGap(start: bigint, end: bigint): void {
    if (start > end) {
      return;
    }
    this.#gaps.push({ start, end });
  }

  #trimToCapacity(): void {
    if (this.#entries.length > this.#capacity) {
      this.#entries.splice(0, this.#entries.length - this.#capacity);
    }
  }
}
