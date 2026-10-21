/**
 * 属性的准入规则：模型与观众的内容（弹幕正文、昵称、模型的输入输出、字幕）默认不采集（R-21）。
 *
 * - 名字：只收 `bellis.*`、`gen_ai.*` 与 `error.type`；GenAI 语义约定里承载内容的属性（输入输出消息、
 *   系统指令、工具调用的参数与结果等）一律拒绝；名字的任何一段是表示内容或观众身份的词（text、content、
 *   message、nickname、subtitle、viewer 等）也拒绝。
 * - 值：只收有限的数值、布尔，以及只含可打印 ASCII、不超过 {@link MAX_STRING_LENGTH} 个字符的字符串，
 *   中文等内容因此进不来；超长的整条拒绝，不截断。`undefined` 视为没给，不计入拒绝。
 * - 拒绝的属性不写出，计入 OTLP 的 `droppedAttributesCount`。
 *
 * 同一套规则在 Python sidecar（`bellis_sidecar.telemetry`）里各实现一份，两边的测试对照。
 */

export type AttributeValue = string | number | boolean;
export type Attributes = Readonly<Record<string, AttributeValue | undefined>>;

export const MAX_STRING_LENGTH = 128;

const ALLOWED_PREFIXES = ['bellis.', 'gen_ai.'] as const;
const ALLOWED_NAMES = new Set(['error.type']);

/** GenAI 语义约定里承载内容的属性（及其下级）。 */
const CONTENT_ATTRIBUTES = [
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
  'gen_ai.prompt',
  'gen_ai.completion',
  'gen_ai.tool.definitions',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
] as const;

/** 名字里出现这些段就拒绝：它们表示内容或观众身份。 */
const CONTENT_WORDS = new Set([
  'text',
  'texts',
  'content',
  'contents',
  'message',
  'messages',
  'body',
  'prompt',
  'prompts',
  'completion',
  'completions',
  'instructions',
  'arguments',
  'result',
  'subtitle',
  'subtitles',
  'spoken',
  'transcript',
  'nickname',
  'nicknames',
  'uname',
  'viewer',
  'viewers',
  'user',
  'open_id',
  'question',
  'option',
  'options',
  'reason',
]);

const NAME = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/** 属性名是否允许写出。 */
export function attributeAllowed(key: string): boolean {
  if (key.length > 128 || !NAME.test(key)) return false;
  if (CONTENT_ATTRIBUTES.some((name) => key === name || key.startsWith(`${name}.`))) return false;
  if (key.split('.').some((segment) => CONTENT_WORDS.has(segment))) return false;
  return ALLOWED_NAMES.has(key) || ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** 属性值是否允许写出。 */
export function valueAllowed(value: unknown): value is AttributeValue {
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return (
    typeof value === 'string' && value.length <= MAX_STRING_LENGTH && PRINTABLE_ASCII.test(value)
  );
}

/** span、事件、直方图的名字：可打印 ASCII，1–128 个字符（GenAI 的 span 名带模型名，例如 `chat replay`）。 */
export function nameAllowed(name: string): boolean {
  return name.length >= 1 && name.length <= 128 && PRINTABLE_ASCII.test(name);
}

export interface Filtered {
  accepted: Array<[string, AttributeValue]>;
  dropped: number;
}

/** 按准入规则筛一组属性：返回留下的（按给出的顺序）与拒绝的个数。 */
export function filterAttributes(attributes: Attributes | undefined): Filtered {
  const accepted: Array<[string, AttributeValue]> = [];
  let dropped = 0;
  if (!attributes) return { accepted, dropped };
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    if (attributeAllowed(key) && valueAllowed(value)) accepted.push([key, value]);
    else dropped += 1;
  }
  return { accepted, dropped };
}
