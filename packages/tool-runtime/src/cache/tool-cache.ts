import { createHash } from "node:crypto";
import type { JsonValue, ToolCacheSource } from "@bellis/contracts";
import type { ToolDeclaration } from "../registry/definition.js";

/**
 * Tool 缓存（phase-3-development-guide.md §8.5）：
 * - L0：单 Cycle Map 去重（相同归一化输入只执行一次）；
 * - L1：Runtime 有界 LRU（仅 pure/idempotent）；
 * - L2：SQLite TTL 缓存（Port；P4 装配），键含版本与 revision；
 * - 命中缓存仍生成 Tool Run 审计事实并标记来源；
 * - 过期、revision 不符或权限收紧（运行期权限检查在缓存查找之前）立即失效。
 */
export interface ToolCacheStore {
  get(key: string): Promise<{ value: JsonValue } | undefined>;
  set(key: string, value: JsonValue, ttlMs: number): Promise<void>;
}

interface LruEntry {
  readonly value: JsonValue;
  readonly expiresAtMs: number;
}

export class ToolCache {
  readonly #lru = new Map<string, LruEntry>();
  readonly #l1Capacity: number;
  readonly #l2: ToolCacheStore | null;
  readonly #wallClockMs: () => number;
  #hits = 0;
  #misses = 0;

  constructor(options: {
    readonly l1Capacity?: number;
    readonly l2?: ToolCacheStore | null;
    readonly wallClockMs: () => number;
  }) {
    this.#l1Capacity = options.l1Capacity ?? 256;
    this.#l2 = options.l2 ?? null;
    this.#wallClockMs = options.wallClockMs;
  }

  /** 稳定缓存键：Tool/版本/归一化输入/配置 revision。 */
  static keyOf(declaration: ToolDeclaration, args: Record<string, unknown>): string {
    const revision = declaration.cache?.revision ?? "";
    return createHash("sha256")
      .update(`${declaration.name}|v${declaration.version}|${revision}|${stableStringify(args)}`)
      .digest("hex");
  }

  static cacheable(declaration: ToolDeclaration): boolean {
    return declaration.cache !== null && declaration.semantic !== "non_idempotent";
  }

  async lookup(
    declaration: ToolDeclaration,
    args: Record<string, unknown>,
    sources: { readonly l0: Map<string, JsonValue> },
  ): Promise<{ value: JsonValue; source: ToolCacheSource } | null> {
    if (!ToolCache.cacheable(declaration)) {
      return null;
    }
    const key = ToolCache.keyOf(declaration, args);
    const l0 = sources.l0.get(key);
    if (l0 !== undefined) {
      this.#hits += 1;
      return { value: l0, source: "l0" };
    }
    const now = this.#wallClockMs();
    const lru = this.#lru.get(key);
    if (lru !== undefined) {
      this.#lru.delete(key);
      if (declaration.cache?.l1 && lru.expiresAtMs > now) {
        this.#lru.set(key, lru);
        this.#hits += 1;
        return { value: lru.value, source: "l1" };
      }
    }
    if (declaration.cache?.l2 && this.#l2 !== null) {
      const hit = await this.#l2.get(key);
      if (hit !== undefined) {
        this.#misses += 0;
        if (declaration.cache.l1) {
          this.#storeL1(key, hit.value, now + declaration.cache.ttlMs);
        }
        this.#hits += 1;
        return { value: hit.value, source: "l2" };
      }
    }
    this.#misses += 1;
    return null;
  }

  async store(
    declaration: ToolDeclaration,
    args: Record<string, unknown>,
    value: JsonValue,
    sources: { readonly l0: Map<string, JsonValue> },
  ): Promise<void> {
    if (!ToolCache.cacheable(declaration) || declaration.cache === null) {
      return;
    }
    const key = ToolCache.keyOf(declaration, args);
    sources.l0.set(key, value);
    const now = this.#wallClockMs();
    if (declaration.cache.l1) {
      this.#storeL1(key, value, now + declaration.cache.ttlMs);
    }
    if (declaration.cache.l2 && this.#l2 !== null) {
      await this.#l2.set(key, value, declaration.cache.ttlMs);
    }
  }

  get stats(): { readonly hits: number; readonly misses: number; readonly l1Size: number } {
    return { hits: this.#hits, misses: this.#misses, l1Size: this.#lru.size };
  }

  #storeL1(key: string, value: JsonValue, expiresAtMs: number): void {
    this.#lru.set(key, { value, expiresAtMs });
    while (this.#lru.size > this.#l1Capacity) {
      const oldest = this.#lru.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.#lru.delete(oldest);
    }
  }
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
