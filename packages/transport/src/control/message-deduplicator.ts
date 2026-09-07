/**
 * 单连接内的 messageId 去重集合（docs/reference/phase-1.md）。
 *
 * - 只做连接内短期去重；跨连接/跨重启幂等由 idempotencyKey + P2 持久化负责。
 * - 集合有界：容量满时按 FIFO 淘汰最旧 messageId。
 * - 重复瞬时消息不重复执行；调用方返回稳定的重复结果。
 */
export interface MessageDeduplicatorOptions {
  /** 集合容量，默认 1024，必须 ≥ 1。 */
  readonly capacity?: number;
}

const DEFAULT_DEDUP_CAPACITY = 1024;

export class MessageDeduplicator {
  readonly #capacity: number;
  readonly #seen = new Map<string, true>();

  constructor(options: MessageDeduplicatorOptions = {}) {
    const capacity = options.capacity ?? DEFAULT_DEDUP_CAPACITY;
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("dedup capacity must be a positive integer");
    }
    this.#capacity = capacity;
  }

  /**
   * 记录 messageId。返回 true 表示首次出现；false 表示重复（不重复记录，
   * 内部状态不变）。
   */
  add(messageId: string): boolean {
    if (this.#seen.has(messageId)) {
      return false;
    }
    if (this.#seen.size >= this.#capacity) {
      const oldest = this.#seen.keys().next();
      if (!oldest.done && oldest.value !== undefined) {
        this.#seen.delete(oldest.value);
      }
    }
    this.#seen.set(messageId, true);
    return true;
  }

  has(messageId: string): boolean {
    return this.#seen.has(messageId);
  }

  size(): number {
    return this.#seen.size;
  }

  clear(): void {
    this.#seen.clear();
  }
}
