import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * 一次性启动 Token（P4 文档 §7.4）。
 *
 * - Token 至少 256-bit 随机（32 字节 → base64url 43 字符），短期、单次使用。
 * - 内存中只保存 SHA-256 摘要与过期时间；原始 Token 只在签发时返回一次。
 * - 比较在摘要域进行 timing-safe 匹配；成功、过期、未知、已使用的交换
 *   返回统一结果，不泄露具体失败原因，原始 Token 永不进入日志。
 * - 开发/测试通过 Fixture 注入（issue()），生产装配不预置任何 Token。
 */

export interface IssuedStartupToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

export type StartupTokenExchange = { readonly ok: true } | { readonly ok: false };

interface TokenRecord {
  readonly digest: Uint8Array;
  readonly expiresAtMs: number;
  used: boolean;
}

const TOKEN_BYTES = 32;

function digestOf(token: string): Uint8Array {
  return createHash("sha256").update(token, "utf8").digest();
}

export class StartupTokenService {
  readonly #ttlMs: number;
  readonly #nowMs: () => number;
  readonly #records = new Map<string, TokenRecord>();
  #sweptAtMs = 0;

  constructor(options?: { ttlMs?: number; nowMs?: () => number }) {
    this.#ttlMs = options?.ttlMs ?? 60_000;
    this.#nowMs = options?.nowMs ?? Date.now;
  }

  /** 签发一枚一次性 Token；原始值只在此返回一次，不落日志。 */
  issue(): IssuedStartupToken {
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const now = this.#nowMs();
    const expiresAtMs = now + this.#ttlMs;
    this.#records.set(token, { digest: digestOf(token), expiresAtMs, used: false });
    this.#sweep(now);
    return { token, expiresAtMs };
  }

  /**
   * 交换校验：过期、未知、已使用、格式非法一律 `{ ok: false }`，
   * 调用方对外返回统一 unauthorized，不区分原因。
   * 成功立即标记已使用（同一 Token 第二次交换失败）。
   */
  exchange(token: unknown): StartupTokenExchange {
    if (typeof token !== "string" || token.length === 0 || token.length > 256) {
      return { ok: false };
    }
    const now = this.#nowMs();
    const record = this.#records.get(token);
    if (record === undefined || record.used || record.expiresAtMs <= now) {
      this.#sweep(now);
      return { ok: false };
    }
    const matches = record.digest.length === 32 && timingSafeEqual(record.digest, digestOf(token));
    if (!matches) {
      return { ok: false };
    }
    record.used = true;
    return { ok: true };
  }

  /** 惰性清理过期记录，避免长期运行内存增长。 */
  #sweep(nowMs: number): void {
    if (nowMs - this.#sweptAtMs < 1_000) {
      return;
    }
    this.#sweptAtMs = nowMs;
    for (const [token, record] of this.#records) {
      if (record.expiresAtMs <= nowMs) {
        this.#records.delete(token);
      }
    }
  }
}
