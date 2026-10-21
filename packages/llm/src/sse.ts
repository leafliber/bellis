/**
 * Server-Sent Events 的解析（WHATWG HTML 的事件流格式，取模型流式输出用到的部分）：
 * - 行以 CRLF、LF 或单独的 CR 结束；CR 与 LF 分在两次输入里也算一个换行；开头的 BOM 由解码器去掉。
 * - 以冒号开头的行是注释（例如 `: keep-alive`），只计数。
 * - `data` 字段可以有多行，以 LF 连接；`event` 记下事件类型；`id`、`retry` 与未知字段忽略。
 *   字段名后的冒号之后若有一个空格，去掉这一个。
 * - 空行结束一个事件，data 非空才分发；流结束时还没结束的事件照样分发（有的服务最后一个事件后不带空行）。
 * - 单行或单个事件的 data 超过上限即抛 {@link SseError}。
 */

export interface SseEvent {
  /** 事件类型；没有 `event` 字段时为 `message`。 */
  type: string;
  data: string;
}

export class SseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SseError';
  }
}

const LF = 0x0a;
const CR = 0x0d;

export class SseParser {
  readonly #maxChars: number;
  readonly #onEvent: (event: SseEvent) => void;
  #line = '';
  #afterCR = false;
  #data: string[] = [];
  #dataChars = 0;
  #type = '';
  #comments = 0;

  /** `maxChars`：单行与单个事件的 data 的字符数上限。`onEvent` 抛出的错误原样抛给 {@link push} 的调用方。 */
  constructor(maxChars: number, onEvent: (event: SseEvent) => void) {
    this.#maxChars = maxChars;
    this.#onEvent = onEvent;
  }

  /** 收到的注释行数（保活）。 */
  get comments(): number {
    return this.#comments;
  }

  /** 送入一段已解码的文本（任意切分）。 */
  push(text: string): void {
    let start = 0;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text.charCodeAt(i);
      if (this.#afterCR) {
        this.#afterCR = false;
        if (ch === LF) {
          start = i + 1;
          continue;
        }
      }
      if (ch === LF || ch === CR) {
        this.#append(text.slice(start, i));
        this.#takeLine();
        start = i + 1;
        if (ch === CR) this.#afterCR = true;
      }
    }
    this.#append(text.slice(start));
  }

  /** 流结束：处理最后一行（没有换行也算），分发还没结束的事件。 */
  end(): void {
    this.#afterCR = false;
    if (this.#line !== '') this.#takeLine();
    this.#dispatch();
  }

  #append(part: string): void {
    if (part === '') return;
    this.#line += part;
    if (this.#line.length > this.#maxChars) {
      throw new SseError(`一行超过 ${this.#maxChars} 个字符`);
    }
  }

  #takeLine(): void {
    const line = this.#line;
    this.#line = '';
    if (line === '') {
      this.#dispatch();
      return;
    }
    if (line.charCodeAt(0) === 0x3a) {
      this.#comments += 1;
      return;
    }
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      this.#dataChars += value.length + (this.#data.length > 0 ? 1 : 0);
      if (this.#dataChars > this.#maxChars) {
        throw new SseError(`一个事件的数据超过 ${this.#maxChars} 个字符`);
      }
      this.#data.push(value);
    } else if (field === 'event') {
      this.#type = value;
    }
  }

  #dispatch(): void {
    const data = this.#data.join('\n');
    const type = this.#type || 'message';
    this.#data = [];
    this.#dataChars = 0;
    this.#type = '';
    if (data === '') return;
    this.#onEvent({ type, data });
  }
}
