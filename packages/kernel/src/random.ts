/** 随机数。插件与仿真调度的随机性都经过它，`sim` profile 用种子驱动（R-07）。 */
export interface Random {
  /** [0, 1) 内的均匀分布。 */
  next(): number;
  /** [min, max] 内的整数。 */
  int(min: number, max: number): number;
}

/** 由种子决定的随机数（sfc32），同一种子总得到同一序列。 */
export function seededRandom(seed: number): Random {
  let a = 0x9e3779b9;
  let b = 0x243f6a88;
  let c = 0xb7e15162;
  let d = seed >>> 0;
  const next = () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i += 1) next();
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
  };
}

/** 真实运行用的随机数。 */
export function systemRandom(): Random {
  return {
    next: Math.random,
    int: (min, max) => min + Math.floor(Math.random() * (max - min + 1)),
  };
}
