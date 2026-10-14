/** 称呼与弹幕文本的净化，以及提示注入检测。观众输入永远只是数据。 */

const NEUTRAL_NAME = '观众';

/** 控制字符、格式字符（零宽、双向控制等）、私用区、代理项。 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/gu;
/** 称呼里只保留字母、数字、CJK 与少量连接符。 */
const NAME_ALLOWED = /[\p{L}\p{N}_\-·]/u;

export interface SanitizeOptions {
  maxNameLength: number;
  maxTextLength: number;
  /** 称呼中出现即改用中性称呼的词。 */
  blockedNameWords: readonly string[];
}

/** 净化称呼：去掉不可见字符与符号，截断长度；净化后为空或命中屏蔽词时用中性称呼。 */
export function sanitizeName(raw: string, options: SanitizeOptions): string {
  const visible = raw.normalize('NFKC').replace(INVISIBLE, '');
  const kept = [...visible]
    .filter((c) => NAME_ALLOWED.test(c))
    .slice(0, options.maxNameLength)
    .join('');
  if (!kept) return NEUTRAL_NAME;
  const lower = kept.toLowerCase();
  if (options.blockedNameWords.some((word) => lower.includes(word.toLowerCase())))
    return NEUTRAL_NAME;
  return kept;
}

/** 净化弹幕文本：去掉不可见字符，合并空白，截断长度。 */
export function sanitizeText(raw: string, maxLength: number): string {
  const visible = raw.normalize('NFKC').replace(INVISIBLE, '').replace(/\s+/gu, ' ').trim();
  return [...visible].slice(0, maxLength).join('');
}

const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore (all |the )?(previous|above|prior) (instructions|prompts?)/iu,
  /disregard (all |the )?(previous|above|prior)/iu,
  /system prompt/iu,
  /\b(you are now|act as|pretend to be)\b/iu,
  /<\|[^>]*\|>/u,
  /\[(system|assistant|developer)\]/iu,
  /忽略(之前|以上|前面|上面)(的)?(所有)?(指令|提示|设定)/u,
  /(无视|忘记|忘掉)(之前|以上|前面)?(的)?(所有)?(指令|设定|规则)/u,
  /(系统|开发者)(提示词|指令|模式)/u,
  /你现在(是|扮演|变成)/u,
  /(扮演|假装你是)/u,
];

/** 提示注入检测：命中的弹幕降权或丢弃，不触发停止，也不升级为全场事件。 */
export function looksLikeInjection(text: string): boolean {
  const normalized = text.normalize('NFKC');
  return INJECTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** 判断同质内容用的归一化文本：去掉标点、空白与大小写差异。 */
export function contentKey(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]/gu, '');
}
