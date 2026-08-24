/**
 * 确定性随机源（docs/phase-1-reference.md）。
 *
 * 通过实例注入的最小随机接口（Outbox 抖动、性质测试），
 * 不引入全局 Math.random Mock；同一种子产生同一序列。
 */

const MASK_64 = 0xffff_ffff_ffff_ffffn;
const TWO_POW_53 = 2 ** 53;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf2_9ce4_8422_2325n;
  const bytes = new TextEncoder().encode(text);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * 0x0000_0100_0000_01b3n) & MASK_64;
  }
  return hash;
}

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

export interface DeterministicRandom {
  /** [0, 1) 内的确定性浮点数（53 位精度）。 */
  next(): number;
  /** [0, maxExclusive) 内的确定性整数。 */
  int(maxExclusive: number): number;
  /** 确定性布尔值。 */
  bool(): boolean;
  /** 从非空数组中按确定性选取一个元素。 */
  pick<T>(items: readonly T[]): T;
}

export function createDeterministicRandom(seed: string): DeterministicRandom {
  if (typeof seed !== "string" || seed.length === 0) {
    throw new RangeError("seed must be a non-empty string");
  }
  const nextU64 = createSplitmix64(fnv1a64(seed));
  const next = (): number => Number(nextU64() >> 11n) / TWO_POW_53;
  return {
    next,
    int: (maxExclusive) => {
      if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
        throw new RangeError("maxExclusive must be a positive integer");
      }
      return Math.floor(next() * maxExclusive);
    },
    bool: () => next() < 0.5,
    pick: <T>(items: readonly T[]) => {
      if (items.length === 0) {
        throw new RangeError("pick requires a non-empty array");
      }
      return items[Math.floor(next() * items.length)] as T;
    },
  };
}
