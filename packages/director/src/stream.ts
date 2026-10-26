/**
 * 增量解析（见决策模型“解析”）：模型的输出边到边扫描，说话的文本一开始就能交给发声。
 * - {@link IntentScanner} 只扫描顶层 JSON 对象，记下 `action`、`replyTo` 的取值，把 `text` 的字符串值逐段解码吐出；
 * - {@link TextQueue} 是交给发声仲裁的文本流。
 * 这里不做最终校验：流读完之后仍然只由 `parseIntent` 整段校验，决策插件据此决定这段发言正常结束还是以错误结束。
 */

/** 顶层键的取值：字符串、null，或别的类型（数、布尔、数组、对象）。 */
export type ScannedField = { kind: 'string'; value: string } | { kind: 'null' } | { kind: 'other' };

/**
 * 扫描顶层对象时吐出的事件：`text` 的字符串值开始（带上那一刻已经读完的 `action` 与 `replyTo`，没出现过的为
 * undefined）、一段解码后的增量、结束。
 */
export type ScanEvent =
  | { type: 'text-start'; action: ScannedField | undefined; replyTo: ScannedField | undefined }
  | { type: 'text'; delta: string }
  | { type: 'text-end' };

/** 记下取值的顶层键。 */
const CAPTURED: ReadonlySet<string> = new Set(['action', 'replyTo']);
/** 逐段吐出的顶层键：只吐第一次出现时的字符串值。 */
const STREAMED = 'text';

const WHITESPACE: ReadonlySet<string> = new Set([' ', '\t', '\n', '\r']);
const ESCAPES: ReadonlyMap<string, string> = new Map([
  ['"', '"'],
  ['\\', '\\'],
  ['/', '/'],
  ['b', '\b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
]);
const HEX = /^[0-9a-fA-F]$/u;
const DIGIT = /^[0-9]$/u;

type ObjectFrame = {
  kind: 'object';
  expect: 'keyOrEnd' | 'key' | 'colon' | 'value' | 'commaOrEnd';
};
type ArrayFrame = { kind: 'array'; expect: 'valueOrEnd' | 'value' | 'commaOrEnd' };

/** 字符串的用途：键名、记下的取值、逐段吐出的文本，其余只跳过。 */
type StringRole = 'key' | 'capture' | 'text' | 'skip';

interface StringToken {
  kind: 'string';
  role: StringRole;
  /** 转义的进度：没有、读到反斜杠、读到 `\u`（已读的十六进制位在 `hex`）。 */
  escape: 'none' | 'backslash' | 'unicode';
  hex: string;
  value: string;
}

interface NumberToken {
  kind: 'number';
  state: 'minus' | 'zero' | 'int' | 'dot' | 'frac' | 'exp' | 'expSign' | 'expDigits';
}

interface LiteralToken {
  kind: 'literal';
  word: 'true' | 'false' | 'null';
  matched: number;
}

/** 数字可以在这些状态下结束。 */
const NUMBER_END: ReadonlySet<NumberToken['state']> = new Set(['zero', 'int', 'frac', 'expDigits']);

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;

/**
 * 意图的增量扫描器：逐段喂入模型输出（{@link push}），按 JSON 语法扫描顶层对象。
 * - 认出顶层键：记下 `action`、`replyTo` 的取值，重复的键取最后一个（与 `JSON.parse` 相同）；顶层 `text` 第一次出现
 *   且是字符串时，吐出开始（带上那一刻的 `action` 与 `replyTo`：一段输出里 `text` 之后的键不算在内）、逐段解码的
 *   增量与结束（之后再出现的 `text` 不吐）。
 * - 转义（含 `\uXXXX` 与代理对）、空白与嵌套的数组和对象（其中的字符串可以含引号与括号）都可以在任意位置被切开；
 *   增量不会把一个代理对拆在两段里。
 * - 第一个非空白字符不是 `{`、或语法不合法时停止（{@link stopped}），之后不再吐出任何事件，交给整段解析去判。
 * 只按 JSON 语法扫描，不按意图的 schema 校验。
 */
export class IntentScanner {
  readonly #stack: Array<ObjectFrame | ArrayFrame> = [];
  #token: StringToken | NumberToken | LiteralToken | undefined;
  #started = false;
  #done = false;
  #stopped: string | undefined;
  /** 最近读到的顶层键（读顶层的值时就是它的键）。 */
  #key = '';
  readonly #fields = new Map<string, ScannedField>();
  #text: 'before' | 'inside' | 'after' = 'before';
  /** 解码了、还没吐出的文本。 */
  #pending = '';
  #events: ScanEvent[] = [];

  /** 停止的原因；没有停止时为 undefined。 */
  get stopped(): string | undefined {
    return this.#stopped;
  }

  /** 顶层对象已经读完。 */
  get done(): boolean {
    return this.#done;
  }

  /** 到目前为止顶层键 `action` 或 `replyTo` 的取值；还没出现、或值还没读完时为 undefined。 */
  field(name: 'action' | 'replyTo'): ScannedField | undefined {
    return this.#fields.get(name);
  }

  /** 喂入一段输出，返回这段带来的事件；已经停止时返回空数组。 */
  push(chunk: string): ScanEvent[] {
    if (this.#stopped !== undefined) return [];
    this.#events = [];
    for (let i = 0; i < chunk.length && this.#stopped === undefined; i += 1) {
      this.#step(chunk[i] as string);
    }
    this.#flush(false);
    return this.#events;
  }

  #stop(reason: string): void {
    this.#stopped = reason;
  }

  /** 吐出解码了的文本；还在字符串里时，末尾单独的高位代理留到下一段与低位代理一起吐出。 */
  #flush(final: boolean): void {
    let out = this.#pending;
    this.#pending = '';
    if (!final && out.length > 0 && isHighSurrogate(out.charCodeAt(out.length - 1))) {
      this.#pending = out.slice(-1);
      out = out.slice(0, -1);
    }
    if (out.length > 0) this.#events.push({ type: 'text', delta: out });
  }

  #step(c: string): void {
    const token = this.#token;
    if (token?.kind === 'string') {
      this.#stringChar(token, c);
      return;
    }
    if (token?.kind === 'literal') {
      this.#literalChar(token, c);
      return;
    }
    if (token?.kind === 'number') {
      if (this.#numberChar(token, c)) return;
      if (!NUMBER_END.has(token.state)) {
        this.#stop('不合法的数字');
        return;
      }
      // 数字到此结束，这个字符交给所在的容器。
      this.#token = undefined;
    }
    if (WHITESPACE.has(c)) return;
    if (this.#done) this.#stop('顶层对象之后还有内容');
    else if (!this.#started) this.#begin(c);
    else this.#structural(c);
  }

  #begin(c: string): void {
    if (c !== '{') {
      this.#stop('第一个非空白字符不是 {');
      return;
    }
    this.#started = true;
    this.#stack.push({ kind: 'object', expect: 'keyOrEnd' });
  }

  /** 容器里字符串、数字与字面量之外的字符：键、冒号、逗号、括号与值的开头。 */
  #structural(c: string): void {
    const frame = this.#stack.at(-1);
    if (!frame) this.#stop('不合法的结构');
    else if (frame.kind === 'object') this.#objectChar(frame, c);
    else this.#arrayChar(frame, c);
  }

  #objectChar(frame: ObjectFrame, c: string): void {
    switch (frame.expect) {
      case 'keyOrEnd':
      case 'key':
        if (c === '}' && frame.expect === 'keyOrEnd') {
          this.#close();
        } else if (c === '"') {
          frame.expect = 'colon';
          this.#startString('key');
        } else {
          this.#stop('对象里应当是键');
        }
        return;
      case 'colon':
        if (c === ':') frame.expect = 'value';
        else this.#stop('键之后应当是冒号');
        return;
      case 'value':
        frame.expect = 'commaOrEnd';
        this.#startValue(c);
        return;
      case 'commaOrEnd':
        if (c === ',') frame.expect = 'key';
        else if (c === '}') this.#close();
        else this.#stop('值之后应当是逗号或 }');
        return;
    }
  }

  #arrayChar(frame: ArrayFrame, c: string): void {
    switch (frame.expect) {
      case 'valueOrEnd':
      case 'value':
        if (c === ']' && frame.expect === 'valueOrEnd') {
          this.#close();
        } else {
          frame.expect = 'commaOrEnd';
          this.#startValue(c);
        }
        return;
      case 'commaOrEnd':
        if (c === ',') frame.expect = 'value';
        else if (c === ']') this.#close();
        else this.#stop('值之后应当是逗号或 ]');
        return;
    }
  }

  /** 正在读顶层的值（顶层对象是栈里唯一的容器）。 */
  #topLevel(): boolean {
    return this.#stack.length === 1;
  }

  /** 读到顶层的值（字符串与 null 读完时，别的类型认出时）：是要记的键就记下。 */
  #capture(value: ScannedField): void {
    if (this.#topLevel() && CAPTURED.has(this.#key)) this.#fields.set(this.#key, value);
  }

  #startValue(c: string): void {
    const top = this.#topLevel();
    if (c === '"') {
      if (top && this.#key === STREAMED && this.#text === 'before') {
        this.#text = 'inside';
        this.#events.push({
          type: 'text-start',
          action: this.#fields.get('action'),
          replyTo: this.#fields.get('replyTo'),
        });
        this.#startString('text');
      } else {
        this.#startString(top && CAPTURED.has(this.#key) ? 'capture' : 'skip');
      }
    } else if (c === '{' || c === '[') {
      this.#capture({ kind: 'other' });
      this.#stack.push(
        c === '{'
          ? { kind: 'object', expect: 'keyOrEnd' }
          : { kind: 'array', expect: 'valueOrEnd' },
      );
    } else if (c === '-' || DIGIT.test(c)) {
      this.#capture({ kind: 'other' });
      this.#token = { kind: 'number', state: c === '-' ? 'minus' : c === '0' ? 'zero' : 'int' };
    } else if (c === 't' || c === 'f' || c === 'n') {
      const word = c === 't' ? 'true' : c === 'f' ? 'false' : 'null';
      if (word !== 'null') this.#capture({ kind: 'other' });
      this.#token = { kind: 'literal', word, matched: 1 };
    } else {
      this.#stop('不合法的值');
    }
  }

  #close(): void {
    this.#stack.pop();
    if (this.#stack.length === 0) this.#done = true;
  }

  #literalChar(token: LiteralToken, c: string): void {
    if (c !== token.word[token.matched]) {
      this.#stop('不合法的字面量');
      return;
    }
    token.matched += 1;
    if (token.matched < token.word.length) return;
    this.#token = undefined;
    if (token.word === 'null') this.#capture({ kind: 'null' });
  }

  #startString(role: StringRole): void {
    this.#token = { kind: 'string', role, escape: 'none', hex: '', value: '' };
  }

  #stringChar(token: StringToken, c: string): void {
    const decoded = this.#decode(token, c);
    if (decoded === undefined) return;
    if (token.role === 'text') this.#pending += decoded;
    else if (token.role !== 'skip') token.value += decoded;
  }

  /** 字符串里的一个字符：返回解码出的内容；转义还没读完、字符串结束或停止时返回 undefined。 */
  #decode(token: StringToken, c: string): string | undefined {
    if (token.escape === 'backslash') {
      if (c === 'u') {
        token.escape = 'unicode';
        token.hex = '';
        return undefined;
      }
      const decoded = ESCAPES.get(c);
      if (decoded === undefined) this.#stop('不合法的转义');
      token.escape = 'none';
      return decoded;
    }
    if (token.escape === 'unicode') {
      if (!HEX.test(c)) {
        this.#stop('不合法的 \\u 转义');
        return undefined;
      }
      token.hex += c;
      if (token.hex.length < 4) return undefined;
      token.escape = 'none';
      return String.fromCharCode(Number.parseInt(token.hex, 16));
    }
    if (c === '\\') {
      token.escape = 'backslash';
      return undefined;
    }
    if (c === '"') {
      this.#endString(token);
      return undefined;
    }
    if (c.charCodeAt(0) < 0x20) {
      this.#stop('字符串里有未转义的控制字符');
      return undefined;
    }
    return c;
  }

  #endString(token: StringToken): void {
    this.#token = undefined;
    if (token.role === 'key') {
      if (this.#topLevel()) this.#key = token.value;
    } else if (token.role === 'capture') {
      this.#capture({ kind: 'string', value: token.value });
    } else if (token.role === 'text') {
      this.#flush(true);
      this.#text = 'after';
      this.#events.push({ type: 'text-end' });
    }
  }

  /** 数字里的一个字符；不属于这个数字时返回 false。 */
  #numberChar(token: NumberToken, c: string): boolean {
    const digit = DIGIT.test(c);
    const exp = c === 'e' || c === 'E';
    switch (token.state) {
      case 'minus':
        if (!digit) return false;
        token.state = c === '0' ? 'zero' : 'int';
        return true;
      case 'zero':
      case 'int':
      case 'frac':
        if (digit && token.state !== 'zero') return true;
        if (c === '.' && token.state !== 'frac') token.state = 'dot';
        else if (exp) token.state = 'exp';
        else return false;
        return true;
      case 'dot':
        if (!digit) return false;
        token.state = 'frac';
        return true;
      case 'exp':
        if (c === '+' || c === '-') token.state = 'expSign';
        else if (digit) token.state = 'expDigits';
        else return false;
        return true;
      case 'expSign':
        if (!digit) return false;
        token.state = 'expDigits';
        return true;
      case 'expDigits':
        return digit;
    }
  }
}

/**
 * 交给发声的文本流（`SpeechRequest.text`）：决策插件边扫描边送入，发声仲裁按送入的段逐段读出。仲裁要凑出下一句时
 * 才读下一段，所以不一次读出积压的全部：以错误结束时，还没凑成句子的部分都不会播出。
 * - 正常结束（{@link end}）：读完送入的部分后结束；
 * - 以错误结束（{@link fail}）：还没读出的部分丢弃，下一次读取即抛出这个错误，仲裁据此不再开始后续的句子；
 * - 读取方提前停止（`return`）之后，再送入的都忽略。
 * 已经结束（含出错、读取方停止）之后的送入、结束与出错都忽略。只给一个读取方用。
 */
export class TextQueue implements AsyncIterable<string> {
  #chunks: string[] = [];
  #state: 'open' | 'ended' | 'failed' | 'closed' = 'open';
  #error: Error | undefined;
  #waiting: PromiseWithResolvers<void> | undefined;

  /** 还在接收：没有结束、出错，读取方也没有停止。 */
  get open(): boolean {
    return this.#state === 'open';
  }

  push(delta: string): void {
    if (this.#state !== 'open' || delta === '') return;
    this.#chunks.push(delta);
    this.#wake();
  }

  end(): void {
    if (this.#state !== 'open') return;
    this.#state = 'ended';
    this.#wake();
  }

  fail(error: Error): void {
    if (this.#state !== 'open') return;
    this.#state = 'failed';
    this.#error = error;
    this.#chunks = [];
    this.#wake();
  }

  #wake(): void {
    const waiting = this.#waiting;
    this.#waiting = undefined;
    waiting?.resolve();
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: async (): Promise<IteratorResult<string>> => {
        for (;;) {
          if (this.#state === 'failed') throw this.#error;
          const chunk = this.#chunks.shift();
          if (chunk !== undefined) return { done: false, value: chunk };
          if (this.#state !== 'open') return { done: true, value: undefined };
          this.#waiting ??= Promise.withResolvers<void>();
          await this.#waiting.promise;
        }
      },
      return: async (): Promise<IteratorResult<string>> => {
        if (this.#state === 'open') this.#state = 'closed';
        this.#chunks = [];
        this.#wake();
        return { done: true, value: undefined };
      },
    };
  }
}
