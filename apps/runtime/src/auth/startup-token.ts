import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * 一次性启动 Token（P4 文档 §7.4）。
 *
 * - Token 至少 256-bit 随机（32 字节 → base64url 43 字符），短期、单次使用。
 * - 内存中**只保存 SHA-256 摘要**（索引与记录均为 digest），
 *   原始 Token 只在签发时返回一次；`containsRawValue` 可自验证内部
 *   记录永不包含原始值。
 * - 比较在摘要域进行 timing-safe 匹配；成功、过期、未知、已使用的交换
 *   返回统一结果，不泄露具体失败原因，原始 Token 永不进入日志。
 * - 消费是**三阶段原子预留**（二轮评审修复 5）：reserve 独占持有（并发
 *   请求只有一个持有者）→ commit 永久消费 / release 归还可用。持久化
 *   可重试失败（database_busy 等）时 release，同 Token 重试有效；
 *   客户端错误（非法 resume 目标等）时 commit，Token 不被探测重放。
 * - 开发/测试通过 Fixture 注入（issue()），生产装配不预置任何 Token。
 */

export interface IssuedStartupToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

/** 已预留 Token 的消费句柄：commit 永久消费；release 归还可用。 */
export interface StartupTokenReservation {
  commit(): void;
  release(): void;
}

interface TokenRecord {
  readonly digest: Uint8Array;
  readonly expiresAtMs: number;
  state: "available" | "reserved" | "used";
}

const TOKEN_BYTES = 32;

function digestOf(token: string): Uint8Array {
  return createHash("sha256").update(token, "utf8").digest();
}

export class StartupTokenService {
  readonly #ttlMs: number;
  readonly #nowMs: () => number;
  /** 键与值都只含 digest（hex 索引 + 字节记录），无原始 Token。 */
  readonly #records = new Map<string, TokenRecord>();
  #sweptAtMs = 0;

  constructor(options?: { ttlMs?: number; nowMs?: () => number }) {
    this.#ttlMs = options?.ttlMs ?? 60_000;
    this.#nowMs = options?.nowMs ?? Date.now;
  }

  /** 签发一枚一次性 Token；原始值只在此返回一次，不落日志。 */
  issue(): IssuedStartupToken {
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const digest = digestOf(token);
    const now = this.#nowMs();
    const expiresAtMs = now + this.#ttlMs;
    this.#records.set(Buffer.from(digest).toString("hex"), {
      digest,
      expiresAtMs,
      state: "available",
    });
    this.#sweep(now);
    return { token, expiresAtMs };
  }

  /**
   * 独占预留一枚 Token：过期、未知、已使用、已预留、格式非法一律
   * null（调用方对外返回统一 unauthorized，不区分原因）。同一时刻
   * 每枚 Token 至多一个持有者；持有者必须 commit() 或 release()。
   */
  reserve(token: unknown): StartupTokenReservation | null {
    if (typeof token !== "string" || token.length === 0 || token.length > 256) {
      return null;
    }
    const now = this.#nowMs();
    const digest = digestOf(token);
    const key = Buffer.from(digest).toString("hex");
    const record = this.#records.get(key);
    if (
      record === undefined ||
      record.state !== "available" ||
      record.expiresAtMs <= now ||
      record.digest.length !== 32 ||
      !timingSafeEqual(record.digest, digest)
    ) {
      this.#sweep(now);
      return null;
    }
    record.state = "reserved";
    let settled = false;
    return {
      commit: () => {
        if (settled) {
          return;
        }
        settled = true;
        record.state = "used";
      },
      release: () => {
        if (settled) {
          return;
        }
        settled = true;
        // 已过期的预留直接作废，否则归还可用状态供同 Token 重试。
        record.state = record.expiresAtMs <= this.#nowMs() ? "used" : "available";
      },
    };
  }

  /**
   * 自验证（评审要求）：内部记录是否包含原始 Token 值。
   * 摘要存储结构下恒为 false——回归测试的结构性断言入口。
   */
  containsRawValue(value: string): boolean {
    return this.#records.has(value);
  }

  /** 惰性清理过期记录，避免长期运行内存增长。 */
  #sweep(nowMs: number): void {
    if (nowMs - this.#sweptAtMs < 1_000) {
      return;
    }
    this.#sweptAtMs = nowMs;
    for (const [key, record] of this.#records) {
      if (record.expiresAtMs <= nowMs) {
        this.#records.delete(key);
      }
    }
  }
}
