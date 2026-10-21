/**
 * 人设漂移的最小确定性信号（见决策模型“人设漂移”）。只给信号，不判定内容是否合适：命中时写日志、
 * 记进模型调用的 span；连续命中由决策插件按安全核“内容重复或漂移”的规则请求降级。
 */

/** 信号的种类（写进遥测 `bellis.director.drift`，以逗号连接）。 */
export type DriftSignal = 'repeat' | 'phrase' | 'format';

export interface DriftOptions {
  /** 出戏用语：出现任何一个（NFKC、不分大小写、忽略空白后比较）即命中 `phrase`。 */
  phrases: readonly string[];
  /** 与近期发言的相似度（字符二元组的 Dice 系数）达到这个值即命中 `repeat`；1 表示只认相同。 */
  similarity: number;
  /** 超过这么多个字符即命中 `format`。 */
  maxChars: number;
}

/** 缺省的出戏用语：自称模型或助手、谈论提示词。 */
export const DEFAULT_DRIFT_PHRASES: readonly string[] = [
  '语言模型',
  'AI助手',
  '人工智能助手',
  '作为一个AI',
  '作为一个人工智能',
  '系统提示',
  '提示词',
  'system prompt',
  'ChatGPT',
  'OpenAI',
];

/** 比较用的规范化：NFKC、小写、去掉空白与标点符号。 */
export function normalizeForDrift(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

function bigrams(text: string): Map<string, number> {
  const chars = [...text];
  const out = new Map<string, number>();
  if (chars.length === 1) out.set(chars[0] as string, 1);
  for (let i = 0; i + 1 < chars.length; i += 1) {
    const gram = `${chars[i]}${chars[i + 1]}`;
    out.set(gram, (out.get(gram) ?? 0) + 1);
  }
  return out;
}

/** 两段文本的相似度：规范化后字符二元组的 Dice 系数（0–1）；规范化后相同为 1，有一段为空为 0。 */
export function similarity(a: string, b: string): number {
  const x = normalizeForDrift(a);
  const y = normalizeForDrift(b);
  if (x === '' || y === '') return 0;
  if (x === y) return 1;
  const left = bigrams(x);
  const right = bigrams(y);
  let shared = 0;
  let total = 0;
  for (const count of left.values()) total += count;
  for (const count of right.values()) total += count;
  for (const [gram, count] of left) shared += Math.min(count, right.get(gram) ?? 0);
  return total === 0 ? 0 : (2 * shared) / total;
}

/** 格式异常：Markdown 与代码标记、网址、花括号或尖括号、换行。 */
const FORMAT = /```|\*\*|__|^\s*#{1,6}\s|^\s*[-*]\s|https?:\/\/|www\.|[{}<>]|\r|\n/mu;

/**
 * 一段要说出口的文本命中的信号：
 * - `repeat`：与近期发言（观众听到的与本插件最近的输出）之一相同或高度相似；
 * - `phrase`：含配置的出戏用语；
 * - `format`：过长或格式异常（见 {@link FORMAT}）。
 */
export function driftSignals(
  text: string,
  recent: readonly string[],
  options: DriftOptions,
): DriftSignal[] {
  const signals: DriftSignal[] = [];
  if (recent.some((previous) => similarity(text, previous) >= options.similarity)) {
    signals.push('repeat');
  }
  const normalized = normalizeForDrift(text);
  if (
    options.phrases.some((phrase) => {
      const target = normalizeForDrift(phrase);
      return target !== '' && normalized.includes(target);
    })
  ) {
    signals.push('phrase');
  }
  if ([...text].length > options.maxChars || FORMAT.test(text)) signals.push('format');
  return signals;
}
