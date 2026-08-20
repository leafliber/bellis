import { parseDecimalString } from "@bellis/contracts";
import type { ServerControlEnvelope } from "@bellis/contracts";

/**
 * 服务端消息的有界 Replay Window（phase-1-build-guide.md §8.2；ADR 0001 §3）。
 *
 * - 每条服务端消息按分配顺序追加；窗口容量固定（默认 512），满时淘汰最旧。
 * - latestAssignedSeq 是单调计数器，不随剪枝回退；Session 可用它恢复 Seq 基线。
 * - replayAfter(lastAck)：lastAck 超过已分配最大 Seq → invalid_ahead（协议错误）；
 *   等于 → up_to_date；lastAck+1 早于窗口最旧条目 → snapshot_required
 *   （缺口超出窗口，由 P4 读取 Persistence 后发送 session.snapshot）；
 *   否则按原 Seq、原 messageId、原文重放。
 * - 心跳/Clock Pong 等瞬时消息同样占用窗口（它们也消耗 Seq，排除会造成
 *   虚假缺口）；「不写 Replay 持久记录」通过 persistable=false 标记交给
 *   P4 的持久化 Effect 处理。
 */
export interface ReplayMessage {
  readonly seq: bigint;
  readonly messageId: string;
  /** 追加时编码的原始 JSON 文本；重放时按原文重发。 */
  readonly text: string;
  readonly envelope: ServerControlEnvelope;
  /** false 表示瞬时消息（heartbeat.pong / clock.pong），P4 不得为其持久化 Seq。 */
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
}

const DEFAULT_REPLAY_CAPACITY = 512;

export class ReplayWindow {
  readonly #capacity: number;
  #entries: ReplayMessage[] = [];
  #latestAssignedSeq = 0n;

  constructor(options: ReplayWindowOptions = {}) {
    const capacity = options.capacity ?? DEFAULT_REPLAY_CAPACITY;
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("replay window capacity must be a positive integer");
    }
    this.#capacity = capacity;
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
    this.#latestAssignedSeq = message.seq;
    this.#entries.push(message);
    if (this.#entries.length > this.#capacity) {
      this.#entries.splice(0, this.#entries.length - this.#capacity);
    }
  }

  /** 窗口内最旧 Seq；窗口为空时为 null。 */
  oldestSeq(): bigint | null {
    return this.#entries[0]?.seq ?? null;
  }

  /**
   * 客户端重连携带 lastAck（十进制字符串或 bigint）时的重放决策。
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
    return { status: "replay", messages: this.#entries.filter((entry) => entry.seq > ack) };
  }

  /** ACK 推进后清理已确认条目，返回清理数量。 */
  pruneThrough(seq: bigint): number {
    const before = this.#entries.length;
    this.#entries = this.#entries.filter((entry) => entry.seq > seq);
    return before - this.#entries.length;
  }

  /** 窗口快照（按 Seq 升序），用于跨连接导出逻辑会话状态。 */
  snapshot(): readonly ReplayMessage[] {
    return [...this.#entries];
  }
}
