/**
 * 投票的规则、计票与口播模板。全部是确定性的纯函数：规则在开票时冻结，事实里原样记录，
 * 重算时用同一套函数得到同一个结果。弹幕正文永远只当数据比较，不解析成指令。
 */

/** 发起投票的参数范围：决策模型的输出 Schema 与投票插件用同一组。 */
export const VOTE_LIMITS = {
  minOptions: 2,
  maxOptions: 4,
  maxQuestionLength: 60,
  maxOptionLength: 20,
  minDurationSec: 10,
  maxDurationSec: 300,
} as const;

/**
 * 开票时冻结的规则，原样写进 `vote.started`。
 * - `ballot`：弹幕正文规范化后恰好是选项编号（1 起），或与某个选项的文本规范化后相同，才算一票；
 * - `perViewer`：每个观众（平台的稳定身份）只计第一张有效票，之后再投不改票；
 * - `tie`：票数最多的选项不止一个时不判胜者，结果为平票。
 */
export interface VoteRules {
  voteId: string;
  question: string;
  options: string[];
  /** 倒计时的时长：开票说明完整播出后才开始计时。 */
  durationMs: number;
  /** 游戏决策点编号（P3 用）；P2 原样带上、记进事实。 */
  decisionPoint: string | null;
  ballot: 'number-or-text';
  perViewer: 'first';
  tie: 'no-winner';
}

/** 不可见字符：控制、格式（零宽、双向控制等）、私用区、代理项。 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/gu;
/** 比较选票时忽略的部分：空白、标点、符号与组合附加符号（例如键帽 1️⃣ 的附加部分）。 */
const IGNORED = /[\p{P}\p{S}\p{M}\s]/gu;

/** 选票的规范化：NFKC（全角数字与字母变半角）、去掉不可见字符、小写、去掉空白、标点、符号与附加符号。 */
export function normalizeBallot(text: string): string {
  return text.normalize('NFKC').replace(INVISIBLE, '').toLowerCase().replace(IGNORED, '');
}

/**
 * 题目与选项的净化：去掉不可见字符、合并空白、截断。不做 NFKC：口播与字幕保留模型写的全角标点，
 * 比较选票时两边都会规范化。
 */
function clean(raw: string, maxLength: number): string {
  const visible = raw.replace(INVISIBLE, '').replace(/\s+/gu, ' ').trim();
  return [...visible].slice(0, maxLength).join('');
}

/**
 * 由选项生成选票的对照表：规范化后的编号与选项文本 → 选项下标。
 * 选项文本规范化后为空、或与别的选项（含编号）冲突时返回原因：这样的规则不能冻结。
 */
export function ballotKeys(options: readonly string[]): Map<string, number> | string {
  const keys = new Map<string, number>();
  const add = (key: string, index: number): string | undefined => {
    const existing = keys.get(key);
    if (existing !== undefined && existing !== index) {
      return `选项 ${existing + 1} 与选项 ${index + 1} 的投法相同（${key}）`;
    }
    keys.set(key, index);
    return undefined;
  };
  for (const [index] of options.entries()) {
    const conflict = add(String(index + 1), index);
    if (conflict) return conflict;
  }
  for (const [index, option] of options.entries()) {
    const key = normalizeBallot(option);
    if (key === '') return `选项 ${index + 1} 规范化后为空`;
    const conflict = add(key, index);
    if (conflict) return conflict;
  }
  return keys;
}

/** 一条弹幕投给哪个选项（下标）；不是有效票时为 undefined。 */
export function matchBallot(text: string, keys: ReadonlyMap<string, number>): number | undefined {
  return keys.get(normalizeBallot(text));
}

export interface VoteDraft {
  voteId: string;
  question: string;
  options: readonly string[];
  durationSec: number;
  decisionPoint?: string | undefined;
}

/** 冻结规则：净化题目与选项（去掉不可见字符、合并空白），核对范围与投法冲突。不合法时返回原因。 */
export function freezeRules(
  draft: VoteDraft,
): { ok: true; rules: VoteRules } | { ok: false; reason: string } {
  const question = clean(draft.question, VOTE_LIMITS.maxQuestionLength);
  if (question === '') return { ok: false, reason: '题目为空' };
  const count = draft.options.length;
  if (count < VOTE_LIMITS.minOptions || count > VOTE_LIMITS.maxOptions) {
    return {
      ok: false,
      reason: `选项要有 ${VOTE_LIMITS.minOptions}–${VOTE_LIMITS.maxOptions} 个，收到 ${count} 个`,
    };
  }
  const options = draft.options.map((option) => clean(option, VOTE_LIMITS.maxOptionLength));
  const keys = ballotKeys(options);
  if (typeof keys === 'string') return { ok: false, reason: keys };
  const { durationSec } = draft;
  if (
    !Number.isInteger(durationSec) ||
    durationSec < VOTE_LIMITS.minDurationSec ||
    durationSec > VOTE_LIMITS.maxDurationSec
  ) {
    return {
      ok: false,
      reason: `时长要在 ${VOTE_LIMITS.minDurationSec}–${VOTE_LIMITS.maxDurationSec} 秒之间`,
    };
  }
  return {
    ok: true,
    rules: {
      voteId: draft.voteId,
      question,
      options,
      durationMs: durationSec * 1000,
      decisionPoint: draft.decisionPoint ?? null,
      ballot: 'number-or-text',
      perViewer: 'first',
      tie: 'no-winner',
    },
  };
}

export type VoteOutcome = 'winner' | 'tie' | 'none';

/** 按冻结的平票规则判定：没有有效票为 none；票数最多的只有一个为 winner；不止一个为平票，不判胜者。 */
export function decide(counts: readonly number[]): { outcome: VoteOutcome; winners: number[] } {
  const valid = counts.reduce((sum, n) => sum + n, 0);
  if (valid === 0) return { outcome: 'none', winners: [] };
  const top = Math.max(...counts);
  const winners = counts.flatMap((n, index) => (n === top ? [index] : []));
  return { outcome: winners.length === 1 ? 'winner' : 'tie', winners };
}

const DIGITS = '零一二三四五六七八九';
const UNITS = ['', '十', '百', '千'];

/** 1–9999 的读法，不处理“一十”开头。 */
function section(n: number): string {
  const digits = [...String(n)].map(Number);
  let out = '';
  let zero = false;
  digits.forEach((digit, i) => {
    if (digit === 0) {
      zero = out !== '';
      return;
    }
    if (zero) out += '零';
    zero = false;
    out += `${DIGITS[digit]}${UNITS[digits.length - 1 - i]}`;
  });
  return out;
}

/**
 * 非负整数的中文读法（口播用：分句器把阿拉伯数字逐字读，“30 秒”会读成“三零秒”）。
 * 一亿及以上、不是非负整数时原样返回数字。
 */
export function chineseNumber(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= 1e8) return String(n);
  if (n === 0) return '零';
  const high = Math.floor(n / 10_000);
  const low = n % 10_000;
  let out = high > 0 ? `${section(high)}万` : '';
  if (low > 0) out += `${high > 0 && low < 1000 ? '零' : ''}${section(low)}`;
  return out.startsWith('一十') ? out.slice(1) : out;
}

/** 带量词时的读法：2 读“两”。 */
export function chineseCount(n: number): string {
  return n === 2 ? '两' : chineseNumber(n);
}

const SENTENCE_END = /[。！？!?；;]$/u;

/**
 * 开票说明（固定模板）：题目、选项、怎么投、多长时间。最后一句说完才开始倒计时，“几秒后截止”从观众听到时算起。
 */
export function openingText(rules: VoteRules): string {
  const question = SENTENCE_END.test(rules.question) ? rules.question : `${rules.question}？`;
  const options = rules.options.map((option, i) => `${i + 1}是「${option}」`).join('，');
  const seconds = chineseCount(Math.round(rules.durationMs / 1000));
  return `投票开始！${question}${options}。发弹幕打编号或者选项就算一票，每人只算第一票，${seconds}秒后截止。`;
}

export interface ResultSummary {
  outcome: VoteOutcome;
  /** 胜出或并列的选项下标。 */
  winners: readonly number[];
  counts: readonly number[];
  valid: number;
  /** 与投票时段重叠的平台缺口总时长（毫秒）；没有缺口为 0。 */
  gapMs: number;
}

/** 结果播报（固定模板）。有缺口时说明结果只算收到的票，不声称是平台全量。 */
export function resultText(rules: VoteRules, result: ResultSummary): string {
  const label = (index: number) => `「${rules.options[index] ?? ''}」`;
  const top = result.counts[result.winners[0] ?? 0] ?? 0;
  let text: string;
  if (result.outcome === 'none') {
    text = '投票结束！这次没有收到有效票。';
  } else if (result.outcome === 'winner') {
    text = `投票结束！${label(result.winners[0] ?? 0)}以${chineseCount(top)}票胜出，一共${chineseCount(result.valid)}票。`;
  } else {
    text = `投票结束！${result.winners.map(label).join('和')}都是${chineseCount(top)}票，平票，这次不分胜负。`;
  }
  if (result.gapMs > 0) {
    const seconds = Math.max(1, Math.round(result.gapMs / 1000));
    text += `投票期间弹幕接收中断过大约${chineseCount(seconds)}秒，结果只算收到的票。`;
  }
  return text;
}
