/**
 * 确定性 ID 源（docs/reference/phase-1.md）。
 *
 * - 同一种子 + 同一命名空间 + 相同调用顺序 ⇒ 完全相同的 ID 序列；
 * - 不同命名空间拥有独立随机流（种子按命名空间散列），互不串扰；
 * - 形态满足 Contracts：UUID v4、W3C Trace ID（32 位小写十六进制，非全零）、
 *   Span ID（16 位，非全零）。
 *
 * 仅限测试使用：生产代码禁止依赖本包生成 ID。
 */

const MASK_64 = 0xffff_ffff_ffff_ffffn;

/** FNV-1a 64 位散列，用于把「种子 + 命名空间」映射为独立随机流种子。 */
function fnv1a64(text: string): bigint {
  let hash = 0xcbf2_9ce4_8422_2325n;
  const bytes = new TextEncoder().encode(text);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * 0x0000_0100_0000_01b3n) & MASK_64;
  }
  return hash;
}

/** SplitMix64：小而确定的 64 位 PRNG 步进函数。 */
function createSplitmix64(seed: bigint): () => bigint {
  let state = seed & MASK_64;
  return () => {
    state = (state + 0x9e37_79b9_7f4a_7c15n) & MASK_64;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58_476d_1ce4_e5b9n) & MASK_64;
    z = ((z ^ (z >> 27n)) * 0x94d0_49bb_1331_11ebn) & MASK_64;
    return z ^ (z >> 31n);
  };
}

function toHex64(value: bigint): string {
  return value.toString(16).padStart(16, "0");
}

export interface DeterministicIdSource {
  /** UUID v4 形态 ID（messageId/recordId/outboxId 等测试 ID 通用）。 */
  uuid(namespace?: string): string;
  /** W3C Trace ID：32 位小写十六进制，非全零。 */
  traceId(namespace?: string): string;
  /** W3C Span ID：16 位小写十六进制，非全零。 */
  spanId(namespace?: string): string;
}

const DEFAULT_NAMESPACE = "default";

export function createDeterministicIdSource(seed: string): DeterministicIdSource {
  if (typeof seed !== "string" || seed.length === 0) {
    throw new RangeError("seed must be a non-empty string");
  }
  const streams = new Map<string, () => bigint>();
  function nextU64(namespace: string | undefined): bigint {
    const key = namespace ?? DEFAULT_NAMESPACE;
    let stream = streams.get(key);
    if (stream === undefined) {
      stream = createSplitmix64(fnv1a64(`${seed}\u0000${key}`));
      streams.set(key, stream);
    }
    return stream();
  }
  return {
    uuid: (namespace) => {
      const hex = `${toHex64(nextU64(namespace))}${toHex64(nextU64(namespace))}`;
      // 设置 v4 版本位（index 12）与 RFC 4122 变体位（index 16），
      // 输出 Contracts 要求的带连字符规范形式，同时保证永不全零。
      const canonical = `${hex.slice(0, 12)}4${hex.slice(13, 16)}8${hex.slice(17)}`;
      return `${canonical.slice(0, 8)}-${canonical.slice(8, 12)}-${canonical.slice(12, 16)}-${canonical.slice(16, 20)}-${canonical.slice(20)}`;
    },
    traceId: (namespace) => {
      let hex = `${toHex64(nextU64(namespace))}${toHex64(nextU64(namespace))}`;
      if (/^[0]+$/.test(hex)) {
        hex = `${hex.slice(0, 31)}1`;
      }
      return hex;
    },
    spanId: (namespace) => {
      let hex = toHex64(nextU64(namespace));
      if (/^[0]+$/.test(hex)) {
        hex = `${hex.slice(0, 15)}1`;
      }
      return hex;
    },
  };
}
