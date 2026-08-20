import type { ServerControlEnvelope } from "@bellis/contracts";

/**
 * 有界、分优先级的发送队列（phase-1-build-guide.md §8.3）。
 *
 * - 双门槛：消息数与编码后字节数任一达到上限即触发淘汰；门槛必须配置化。
 * - 优先级 1（安全/取消/Scene Commit/协议错误）> 2（媒体与 Session 控制）>
 *   3（快照增量）> 4（调试遥测）。同优先级 FIFO。
 * - 淘汰顺序确定性：优先淘汰更低优先级（数字更大）中最旧的条目；
 *   永不淘汰优先级 1。
 * - 低优先级（3/4）可替代消息可按稳定 mergeKey 合并：同 Key 旧消息被替换。
 * - 高优先级（1/2）在淘汰所有更低优先级后仍无法入队 → close_slow_consumer，
 *   绝不静默丢失。
 */
export type SendPriority = 1 | 2 | 3 | 4;

export interface QueuedSend {
  readonly priority: SendPriority;
  readonly text: string;
  readonly byteSize: number;
  readonly envelope: ServerControlEnvelope;
  /** 淘汰记账用的消息类别（消息 type），不含 Payload。 */
  readonly category: string;
  readonly deadlineUs: bigint | null;
  readonly mergeKey: string | null;
  readonly replaceable: boolean;
}

export interface SendQueueLimits {
  readonly maxMessages: number;
  readonly maxBytes: number;
}

export interface SendQueueOptions {
  /** 最大消息条数，默认 512。 */
  readonly maxMessages?: number;
  /** 最大编码字节数，默认 8 MiB。 */
  readonly maxBytes?: number;
}

export type EnqueueOutcome =
  | { readonly status: "queued"; readonly evicted: readonly QueuedSend[] }
  | {
      readonly status: "dropped";
      readonly reason: "capacity";
      readonly evicted: readonly QueuedSend[];
    }
  | { readonly status: "close_slow_consumer"; readonly evicted: readonly QueuedSend[] };

const DEFAULT_MAX_MESSAGES = 512;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const LOWEST_DROPPABLE_PRIORITY: SendPriority = 3;

export class BoundedSendQueue {
  readonly #limits: SendQueueLimits;
  readonly #lanes: [QueuedSend[], QueuedSend[], QueuedSend[], QueuedSend[]] = [[], [], [], []];
  #bytes = 0;

  constructor(options: SendQueueOptions = {}) {
    const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isInteger(maxMessages) || maxMessages < 1) {
      throw new RangeError("maxMessages must be a positive integer");
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError("maxBytes must be a positive integer");
    }
    this.#limits = { maxMessages, maxBytes };
  }

  get limits(): SendQueueLimits {
    return this.#limits;
  }

  messageCount(): number {
    return (
      this.#lanes[0].length + this.#lanes[1].length + this.#lanes[2].length + this.#lanes[3].length
    );
  }

  byteCount(): number {
    return this.#bytes;
  }

  /**
   * 入队。容量不足时按确定性顺序淘汰更低优先级中最旧的条目；
   * 可替代消息先按 mergeKey 替换同 Key 旧条目。返回被淘汰条目供记账。
   */
  enqueue(message: QueuedSend): EnqueueOutcome {
    const evicted: QueuedSend[] = [];
    if (message.replaceable && message.mergeKey !== null) {
      this.#takeByMergeKey(message.mergeKey, evicted);
    }
    // 可行性预检：单条消息超过总字节上限时，清空队列也不可能容纳，
    // 不为它白白淘汰更低优先级条目。
    if (message.byteSize > this.#limits.maxBytes) {
      return message.priority < LOWEST_DROPPABLE_PRIORITY
        ? { status: "close_slow_consumer", evicted }
        : { status: "dropped", reason: "capacity", evicted };
    }
    if (!this.#canFit(message)) {
      // 从最低优先级车道开始淘汰（数字大 = 优先级低），只淘汰严格更低优先级。
      for (let laneIndex = 3; laneIndex >= 0 && !this.#canFit(message); laneIndex -= 1) {
        const priority = (laneIndex + 1) as SendPriority;
        if (priority <= message.priority) {
          break;
        }
        const lane = this.#lanes[laneIndex];
        if (lane === undefined) {
          break;
        }
        while (lane.length > 0 && !this.#canFit(message)) {
          const removed = lane.shift();
          if (removed === undefined) {
            break;
          }
          this.#bytes -= removed.byteSize;
          evicted.push(removed);
        }
      }
    }
    if (!this.#canFit(message)) {
      if (message.priority < LOWEST_DROPPABLE_PRIORITY) {
        // 高优先级（1/2）无法入队：慢消费者，绝不静默丢失。
        // 已发生的淘汰保持有效（记账真实），连接将由 Session 关闭。
        return { status: "close_slow_consumer", evicted };
      }
      return { status: "dropped", reason: "capacity", evicted };
    }
    const targetLane = this.#lanes[message.priority - 1];
    if (targetLane !== undefined) {
      targetLane.push(message);
    }
    this.#bytes += message.byteSize;
    return { status: "queued", evicted };
  }

  /**
   * 排空：按优先级升序、同优先级 FIFO 返回全部待发消息并清空队列。
   * 消息一旦交付（返回给适配器）即离开队列，不再重复发送。
   */
  drain(): readonly QueuedSend[] {
    const drained: QueuedSend[] = [];
    for (const lane of this.#lanes) {
      drained.push(...lane);
      lane.length = 0;
    }
    this.#bytes = 0;
    return drained;
  }

  /** 丢弃 deadlineUs 已过的条目（帧不可再用时不发送），返回被丢弃条目。 */
  pruneExpired(nowUs: bigint): readonly QueuedSend[] {
    const expired: QueuedSend[] = [];
    for (const lane of this.#lanes) {
      const kept: QueuedSend[] = [];
      for (const message of lane) {
        if (message.deadlineUs !== null && message.deadlineUs <= nowUs) {
          expired.push(message);
          this.#bytes -= message.byteSize;
        } else {
          kept.push(message);
        }
      }
      lane.length = 0;
      lane.push(...kept);
    }
    return expired;
  }

  clear(): readonly QueuedSend[] {
    return this.drain();
  }

  #canFit(message: QueuedSend): boolean {
    return (
      this.messageCount() < this.#limits.maxMessages &&
      this.#bytes + message.byteSize <= this.#limits.maxBytes
    );
  }

  #takeByMergeKey(mergeKey: string, evicted: QueuedSend[]): void {
    for (const lane of this.#lanes) {
      for (let index = lane.length - 1; index >= 0; index -= 1) {
        const candidate = lane[index];
        if (candidate !== undefined && candidate.mergeKey === mergeKey && candidate.replaceable) {
          lane.splice(index, 1);
          this.#bytes -= candidate.byteSize;
          evicted.push(candidate);
        }
      }
    }
  }
}
