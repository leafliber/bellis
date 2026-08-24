/**
 * 有界、分优先级的发送暂存队列（docs/phase-1-reference.md）。
 *
 * 队列持有的是**尚未分配 Seq** 的暂存消息：优先级只在此阶段起作用——
 * 调度（drain 按优先级升序）、准入淘汰、mergeKey 合并与 Deadline 剪枝
 * 都发生在 Seq 分配之前，被淘汰/合并/过期的消息不会产生线上 Seq 缺口。
 * ControlSession 在 drain 时按实际发送顺序分配 Seq。
 *
 * - 双门槛：消息数与估算字节数任一达到上限即触发淘汰；门槛必须配置化。
 * - 优先级 1（安全/取消/Scene Commit/协议错误）> 2（媒体与 Session 控制）>
 *   3（快照增量）> 4（调试遥测）。同优先级 FIFO。
 * - 淘汰顺序确定性：优先淘汰更低优先级（数字更大）中最旧的条目；
 *   永不淘汰优先级 1。
 * - 低优先级（3/4）可替代消息可按稳定 mergeKey 合并：同 Key 旧消息被替换；
 *   替换先做可行性计算，新消息放不下时**保留旧条目**，绝不先删后拒。
 * - 高优先级（1/2）在淘汰所有更低优先级后仍无法入队 → close_slow_consumer，
 *   绝不静默丢失。
 */
export type SendPriority = 1 | 2 | 3 | 4;

export interface QueuedSend {
  readonly priority: SendPriority;
  /** 估算的编码字节数（阈值记账用；最终编码在 Seq 分配时进行）。 */
  readonly byteSize: number;
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
  /** 最大估算字节数，默认 8 MiB。 */
  readonly maxBytes?: number;
}

export type EnqueueOutcome =
  | {
      readonly status: "queued";
      readonly evicted: readonly QueuedSend[];
      readonly merged: readonly QueuedSend[];
    }
  | {
      readonly status: "dropped";
      readonly reason: "capacity";
      readonly evicted: readonly QueuedSend[];
      readonly merged: readonly QueuedSend[];
    }
  | {
      readonly status: "close_slow_consumer";
      readonly evicted: readonly QueuedSend[];
      readonly merged: readonly QueuedSend[];
    };

const DEFAULT_MAX_MESSAGES = 512;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const LOWEST_DROPPABLE_PRIORITY: SendPriority = 3;

interface FreedBudget {
  bytes: number;
  count: number;
}

export class BoundedSendQueue<T extends QueuedSend = QueuedSend> {
  readonly #limits: SendQueueLimits;
  readonly #lanes: [T[], T[], T[], T[]] = [[], [], [], []];
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
   * 可替代消息先按 mergeKey 定位旧条目并计入替换预算，可行后才移除，
   * 新消息放不下时旧条目原样保留。返回被淘汰/被合并条目供记账。
   */
  enqueue(message: T): EnqueueOutcome {
    const evicted: QueuedSend[] = [];
    const merged: QueuedSend[] = [];
    // 合并目标只定位、不移除；后续任一失败路径都不触碰既有条目。
    const targets =
      message.replaceable && message.mergeKey !== null
        ? this.#collectReplaceable(message.mergeKey)
        : [];
    const pendingMerge = new Set(targets);
    const freed: FreedBudget = { bytes: 0, count: 0 };
    for (const target of targets) {
      freed.bytes += target.byteSize;
      freed.count += 1;
    }

    // 可行性预检：单条消息超过总字节上限时，清空队列也不可能容纳，
    // 不为它白白淘汰更低优先级条目，也不移除合并目标。
    if (message.byteSize > this.#limits.maxBytes) {
      return this.#refuse(message, evicted, merged);
    }
    if (!this.#canFit(message, freed)) {
      // 从最低优先级车道开始淘汰（数字大 = 优先级低），只淘汰严格更低优先级。
      for (let laneIndex = 3; laneIndex >= 0 && !this.#canFit(message, freed); laneIndex -= 1) {
        const priority = (laneIndex + 1) as SendPriority;
        if (priority <= message.priority) {
          break;
        }
        const lane = this.#lanes[laneIndex];
        if (lane === undefined) {
          break;
        }
        while (lane.length > 0 && !this.#canFit(message, freed)) {
          const removed = lane.shift();
          if (removed === undefined) {
            break;
          }
          this.#bytes -= removed.byteSize;
          if (pendingMerge.delete(removed)) {
            // 合并目标在容量淘汰中先被移出：撤销其替换预算，按容量记账。
            freed.bytes -= removed.byteSize;
            freed.count -= 1;
          }
          evicted.push(removed);
        }
      }
    }
    if (!this.#canFit(message, freed)) {
      if (message.priority < LOWEST_DROPPABLE_PRIORITY) {
        // 高优先级（1/2）无法入队：慢消费者，绝不静默丢失。
        // 已发生的淘汰保持有效（记账真实），连接将由 Session 关闭。
        return { status: "close_slow_consumer", evicted, merged };
      }
      return { status: "dropped", reason: "capacity", evicted, merged };
    }
    for (const target of targets) {
      if (!pendingMerge.has(target)) {
        continue;
      }
      this.#removeEntry(target);
      this.#bytes -= target.byteSize;
      merged.push(target);
    }
    const targetLane = this.#lanes[message.priority - 1];
    if (targetLane !== undefined) {
      targetLane.push(message);
    }
    this.#bytes += message.byteSize;
    return { status: "queued", evicted, merged };
  }

  /**
   * 排空：按优先级升序、同优先级 FIFO 返回全部待发消息并清空队列。
   * 消息一旦交付（返回给适配器）即离开队列，不再重复发送。
   */
  drain(): readonly T[] {
    const drained: T[] = [];
    for (const lane of this.#lanes) {
      drained.push(...lane);
      lane.length = 0;
    }
    this.#bytes = 0;
    return drained;
  }

  /** 非破坏性快照（drain 顺序，按优先级升序），供导出暂存消息。 */
  snapshot(): readonly T[] {
    const entries: T[] = [];
    for (const lane of this.#lanes) {
      entries.push(...lane);
    }
    return entries;
  }

  /** 丢弃 deadlineUs 已过的条目（帧不可再用时不发送），返回被丢弃条目。 */
  pruneExpired(nowUs: bigint): readonly T[] {
    const expired: T[] = [];
    for (const lane of this.#lanes) {
      const kept: T[] = [];
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

  clear(): readonly T[] {
    return this.drain();
  }

  #canFit(message: T, freed: FreedBudget): boolean {
    return (
      this.messageCount() - freed.count < this.#limits.maxMessages &&
      this.#bytes - freed.bytes + message.byteSize <= this.#limits.maxBytes
    );
  }

  #refuse(
    message: T,
    evicted: readonly QueuedSend[],
    merged: readonly QueuedSend[],
  ): EnqueueOutcome {
    return message.priority < LOWEST_DROPPABLE_PRIORITY
      ? { status: "close_slow_consumer", evicted, merged }
      : { status: "dropped", reason: "capacity", evicted, merged };
  }

  /** 定位同 mergeKey 且可被替换的全部条目（同 Key 至多一条，遍历防御）。 */
  #collectReplaceable(mergeKey: string): readonly T[] {
    const found: T[] = [];
    for (const lane of this.#lanes) {
      for (const candidate of lane) {
        if (candidate.mergeKey === mergeKey && candidate.replaceable) {
          found.push(candidate);
        }
      }
    }
    return found;
  }

  #removeEntry(target: T): void {
    const lane = this.#lanes[target.priority - 1];
    if (lane === undefined) {
      return;
    }
    const index = lane.indexOf(target);
    if (index >= 0) {
      lane.splice(index, 1);
    }
  }
}
