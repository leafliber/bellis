import {
  type LlmCallOptions,
  LlmError,
  type LlmErrorKind,
  type LlmMessage,
  type LlmOutputFormat,
  type LlmUsage,
} from '@bellis/director';
import type { Clock, TimerHandle } from '@bellis/kernel';
import { SseError, type SseEvent, SseParser } from './sse.ts';

/**
 * OpenAI 兼容的 Chat Completions 薄客户端（R-17）：fetch 发请求，自己解析 SSE。只负责收发：
 * 请求体由配置与决策插件给的消息、输出格式确定；返回正文（函数调用方式下为函数参数）的字符串，不解析意图。
 * 不做隐式重试；中止信号一到即中止 fetch；超时（连接、首块、块间停顿）由本客户端计时，整体截止时间由调用方给。
 */

/** 意图的输出方式。 */
export const OUTPUT_MODES = ['json_schema', 'json_object', 'tool', 'prompt'] as const;
export type OutputMode = (typeof OUTPUT_MODES)[number];

export const THINKING = ['enabled', 'disabled'] as const;
export type Thinking = (typeof THINKING)[number];

export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** 请求的形状：没有配置的字段不发。 */
export interface ChatSettings {
  endpoint: string;
  model: string;
  outputMode: OutputMode;
  thinking?: Thinking | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
}

export interface ChatLimits {
  /** 发出请求到收到响应头。 */
  connectTimeoutMs: number;
  /** 收到响应头到第一个数据块（含只有思考内容的块；保活注释不算）。 */
  firstChunkTimeoutMs: number;
  /** 相邻两个数据块之间（保活注释不算）。 */
  stallTimeoutMs: number;
  /** 单行与单个 SSE 事件的字符数上限。 */
  maxEventChars: number;
  /** 正文（或函数参数）的总字符数上限。 */
  maxOutputChars: number;
}

export interface ChatRequest {
  messages: readonly LlmMessage[];
  output: LlmOutputFormat;
}

export interface ChatObserver extends LlmCallOptions {
  /** 每段正文（函数调用方式下为函数参数）的增量，思考内容不在其中。探针用来测意图完整的时刻。 */
  onOutput?(delta: string): void;
}

export interface ChatResult {
  /** 正文；函数调用方式下为函数参数。 */
  output: string;
  finishReason: string;
  usage: LlmUsage | undefined;
  responseModel: string | undefined;
  /** 收到的数据块数（不含 `[DONE]`）与保活注释数。 */
  chunks: number;
  comments: number;
}

export interface ChatClientOptions {
  settings: ChatSettings;
  limits: ChatLimits;
  /** 鉴权头 `Authorization: Bearer <apiKey>` 的值；只用于请求头，不写进任何说明。 */
  apiKey: string;
  clock: Clock;
}

const KIND_WORDS: Record<LlmErrorKind, string> = {
  auth: '鉴权失败',
  rate_limit: '限流',
  server: '服务端出错',
  request: '请求被拒',
  timeout: '超时',
  network: '连接失败',
  protocol: '返回不合约定',
  incomplete: '输出没有正常结束',
  aborted: '已取消',
};

/** 错误说明里摘录的返回体：至多读这么多字节，说明至多这么多字符。 */
const EXCERPT_BYTES = 4096;
const EXCERPT_CHARS = 200;

/** 请求体：没有配置的字段不发；`traceparent` 只用于本机遥测，不发给模型服务。 */
export function requestBody(settings: ChatSettings, request: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: settings.model,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (settings.thinking !== undefined) body.thinking = { type: settings.thinking };
  if (settings.reasoningEffort !== undefined) body.reasoning_effort = settings.reasoningEffort;
  if (settings.temperature !== undefined) body.temperature = settings.temperature;
  if (settings.maxTokens !== undefined) body.max_tokens = settings.maxTokens;
  const { name, description, schema } = request.output;
  switch (settings.outputMode) {
    case 'json_schema':
      body.response_format = {
        type: 'json_schema',
        json_schema: { name, description, schema, strict: true },
      };
      break;
    case 'json_object':
      body.response_format = { type: 'json_object' };
      break;
    case 'tool':
      body.tools = [{ type: 'function', function: { name, description, parameters: schema } }];
      body.tool_choice = { type: 'function', function: { name } };
      break;
    case 'prompt':
      break;
  }
  return body;
}

/** 抹掉文本里出现的凭据，合并空白并截短。服务端给的说明只在这样处理后才写进错误。 */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text.replace(/\s+/g, ' ').trim();
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join('***');
  return out.length > EXCERPT_CHARS ? `${out.slice(0, EXCERPT_CHARS)}…` : out;
}

/** 只留可打印 ASCII（错误码、型号、结束原因），截到 `max` 个字符。 */
function ascii(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const out = String(value)
    .replace(/[^\x20-\x7e]/g, '')
    .slice(0, max);
  return out === '' ? undefined : out;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // fetch 把底层原因（拒绝连接、DNS 失败等）放在 cause 里。
  const cause = error.cause instanceof Error ? `（${error.cause.message}）` : '';
  return `${error.message}${cause}`;
}

function kindOfStatus(status: number): LlmErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  return 'request';
}

/** 流中途的错误对象按错误码与类型归类（没有可用的 HTTP 状态时）。 */
function kindOfCode(code: string): LlmErrorKind {
  if (/auth|unauthori[sz]ed|forbidden|api.?key|permission|access.?denied/i.test(code))
    return 'auth';
  if (/rate.?limit|too.?many|throttl|quota/i.test(code)) return 'rate_limit';
  if (/invalid|bad.?request|parameter|unsupported|not.?supported/i.test(code)) return 'request';
  return 'server';
}

/** 错误对象（`{"error": {...}}` 或其本身）里的错误码、类型、HTTP 状态与说明。 */
function errorDetail(value: unknown, secrets: readonly string[]) {
  const outer = isObject(value) ? value : {};
  const error = isObject(outer.error) ? outer.error : outer;
  const code = ascii(error.code, 64);
  const type = ascii(error.type, 64);
  const status =
    typeof error.status === 'number'
      ? error.status
      : typeof error.code === 'number'
        ? error.code
        : undefined;
  const said = typeof error.message === 'string' ? scrub(error.message, secrets) : '';
  return { code, type, status, said };
}

/** 读返回体的开头至多 `maxBytes` 字节（读完或出错就停），其余丢弃。 */
async function excerpt(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    // 读不完就用读到的部分。
  } finally {
    reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(Math.min(size, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, bytes.byteLength - offset);
    bytes.set(part, offset);
    offset += part.byteLength;
    if (offset >= bytes.byteLength) break;
  }
  return new TextDecoder().decode(bytes);
}

/** 非 200 的响应：按状态归类，说明里只有状态、错误码与截短的服务端说明（已抹掉凭据）。 */
async function httpError(response: Response, secrets: readonly string[]): Promise<LlmError> {
  const status = response.status;
  const text = await excerpt(response, EXCERPT_BYTES);
  let detail: ReturnType<typeof errorDetail>;
  try {
    detail = errorDetail(JSON.parse(text), secrets);
  } catch {
    detail = { code: undefined, type: undefined, status: undefined, said: scrub(text, secrets) };
  }
  const code = detail.code ?? detail.type;
  const kind = kindOfStatus(status);
  return new LlmError(
    kind,
    `${KIND_WORDS[kind]}：HTTP ${status}${code ? `（${code}）` : ''}${detail.said ? `：${detail.said}` : ''}`,
    { status, ...(code ? { code } : {}) },
  );
}

/** 流中途的错误对象。 */
function streamError(value: unknown, secrets: readonly string[]): LlmError {
  const detail = errorDetail(value, secrets);
  const status =
    detail.status !== undefined && detail.status >= 400 && detail.status < 600
      ? detail.status
      : undefined;
  const kind =
    status !== undefined ? kindOfStatus(status) : kindOfCode(`${detail.code} ${detail.type}`);
  const code = detail.code ?? detail.type;
  return new LlmError(
    kind,
    `流中途出错（${KIND_WORDS[kind]}）${code ? `：${code}` : ''}${detail.said ? `：${detail.said}` : ''}`,
    { ...(status !== undefined ? { status } : {}), ...(code ? { code } : {}) },
  );
}

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;

function usageOf(value: Record<string, unknown>, responseModel: string | undefined): LlmUsage {
  const details = isObject(value.completion_tokens_details) ? value.completion_tokens_details : {};
  const usage: LlmUsage = {};
  const input = count(value.prompt_tokens);
  const output = count(value.completion_tokens);
  const reasoning = count(details.reasoning_tokens);
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  if (reasoning !== undefined) usage.reasoningOutputTokens = reasoning;
  if (responseModel !== undefined) usage.responseModel = responseModel;
  return usage;
}

interface StreamState {
  done: boolean;
  chunks: number;
  content: string;
  calls: Map<number, { name: string; args: string }>;
  outputChars: number;
  firstOutput: boolean;
  finishReason: string | undefined;
  usage: LlmUsage | undefined;
  responseModel: string | undefined;
}

export class ChatClient {
  readonly #options: ChatClientOptions;
  readonly #secrets: readonly string[];

  constructor(options: ChatClientOptions) {
    this.#options = options;
    this.#secrets = [options.apiKey];
  }

  /**
   * 调用一次模型（流式）。`signal` 中止即中止 fetch、断开连接，以 `aborted` 结束；之后不再调用 `observer`。
   * 思考内容（`reasoning_content`）一律丢弃，只经用量报它的 token 数。失败按 {@link LlmErrorKind} 归类。
   */
  async complete(
    request: ChatRequest,
    signal: AbortSignal,
    observer: ChatObserver = {},
  ): Promise<ChatResult> {
    const { settings, limits, clock, apiKey } = this.#options;
    if (signal.aborted) throw new LlmError('aborted', KIND_WORDS.aborted);
    const controller = new AbortController();
    /** 第一个让这次调用结束的原因（取消、超时，或处理中发现的错误）；之后一切回调都不再调用。 */
    let failure: LlmError | undefined;
    const fail = (error: LlmError) => {
      failure ??= error;
      controller.abort();
    };
    const onAbort = () => fail(new LlmError('aborted', KIND_WORDS.aborted));
    signal.addEventListener('abort', onAbort, { once: true });
    let timer: TimerHandle | undefined;
    const disarm = () => {
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
    };
    const arm = (ms: number, what: string) => {
      disarm();
      timer = clock.setTimeout(() => {
        timer = undefined;
        fail(new LlmError('timeout', `${KIND_WORDS.timeout}：${what}未在 ${ms}ms 内到达`));
      }, ms);
    };
    /** 回调观察者：调用已结束就不调；观察者自己出错不影响调用。 */
    const notify = (call: () => void) => {
      if (failure !== undefined) return;
      try {
        call();
      } catch {
        // 观察者只用于遥测与测量。
      }
    };
    const state: StreamState = {
      done: false,
      chunks: 0,
      content: '',
      calls: new Map(),
      outputChars: 0,
      firstOutput: false,
      finishReason: undefined,
      usage: undefined,
      responseModel: undefined,
    };
    const tool = settings.outputMode === 'tool';
    const addOutput = (delta: string) => {
      state.outputChars += delta.length;
      if (state.outputChars > limits.maxOutputChars) {
        throw new LlmError('protocol', `输出超过 ${limits.maxOutputChars} 个字符`);
      }
      if (!state.firstOutput) {
        state.firstOutput = true;
        notify(() => observer.onFirstOutput?.());
      }
      notify(() => observer.onOutput?.(delta));
    };
    const handle = ({ type, data }: SseEvent) => {
      if (state.done || failure !== undefined) return;
      if (data === '[DONE]') {
        state.done = true;
        return;
      }
      state.chunks += 1;
      if (state.chunks === 1) notify(() => observer.onFirstChunk?.());
      arm(limits.stallTimeoutMs, '下一块');
      let chunk: unknown;
      try {
        chunk = JSON.parse(data);
      } catch {
        throw new LlmError('protocol', '数据块不是 JSON');
      }
      if (!isObject(chunk)) throw new LlmError('protocol', '数据块不是 JSON 对象');
      if (type === 'error') throw streamError(chunk, this.#secrets);
      if (chunk.error !== undefined && chunk.error !== null)
        throw streamError(chunk, this.#secrets);
      const model = ascii(chunk.model, 128);
      if (model !== undefined) state.responseModel = model;
      if (isObject(chunk.usage)) {
        const usage = usageOf(chunk.usage, state.responseModel);
        state.usage = usage;
        notify(() => observer.onUsage?.(usage));
      }
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      for (const choice of choices) {
        if (!isObject(choice) || (choice.index !== undefined && choice.index !== 0)) continue;
        const delta = isObject(choice.delta) ? choice.delta : {};
        // 思考内容（reasoning_content）一律丢弃：不进返回值、日志、事件与遥测。
        if (!tool && typeof delta.content === 'string' && delta.content !== '') {
          state.content += delta.content;
          addOutput(delta.content);
        }
        if (tool && Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls) {
            if (!isObject(call)) continue;
            const index = typeof call.index === 'number' ? call.index : 0;
            const entry = state.calls.get(index) ?? { name: '', args: '' };
            state.calls.set(index, entry);
            const fn = isObject(call.function) ? call.function : {};
            if (typeof fn.name === 'string') entry.name += fn.name;
            if (typeof fn.arguments === 'string' && fn.arguments !== '') {
              entry.args += fn.arguments;
              addOutput(fn.arguments);
            }
          }
        }
        if (typeof choice.finish_reason === 'string') state.finishReason = choice.finish_reason;
      }
    };
    try {
      arm(limits.connectTimeoutMs, '响应头');
      let response: Response;
      try {
        response = await fetch(settings.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(requestBody(settings, request)),
          signal: controller.signal,
          redirect: 'error',
        });
      } catch (error) {
        throw (
          failure ??
          new LlmError('network', `${KIND_WORDS.network}：${scrub(describe(error), this.#secrets)}`)
        );
      }
      if (failure !== undefined) throw failure;
      if (response.status !== 200) {
        arm(limits.stallTimeoutMs, '错误返回体');
        throw await httpError(response, this.#secrets);
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (!/text\/event-stream/i.test(contentType) || !response.body) {
        arm(limits.stallTimeoutMs, '返回体');
        let said = '';
        try {
          const detail = errorDetail(
            JSON.parse(await excerpt(response, EXCERPT_BYTES)),
            this.#secrets,
          );
          said = [detail.code ?? detail.type, detail.said].filter(Boolean).join('：');
        } catch {
          // 不是 JSON：不摘录。
        }
        throw new LlmError(
          'protocol',
          `返回的不是 SSE（content-type：${ascii(contentType, 64) ?? '无'}）${said ? `：${said}` : ''}`,
        );
      }
      arm(limits.firstChunkTimeoutMs, '首块');
      const parser = new SseParser(limits.maxEventChars, handle);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        let read: Awaited<ReturnType<typeof reader.read>>;
        try {
          read = await reader.read();
        } catch (error) {
          throw (
            failure ?? new LlmError('network', `读取中断：${scrub(describe(error), this.#secrets)}`)
          );
        }
        if (failure !== undefined) throw failure;
        if (read.done) break;
        parser.push(decoder.decode(read.value, { stream: true }));
        if (state.done) break;
      }
      if (!state.done) {
        parser.push(decoder.decode());
        parser.end();
      }
      if (failure !== undefined) throw failure;
      disarm();
      if (state.finishReason === undefined) {
        throw new LlmError('protocol', '流在给出结束原因之前就结束了');
      }
      if (state.finishReason !== 'stop' && state.finishReason !== 'tool_calls') {
        throw new LlmError(
          'incomplete',
          `${KIND_WORDS.incomplete}（finish_reason：${ascii(state.finishReason, 32) ?? '?'}）`,
        );
      }
      let output = state.content;
      if (tool) {
        const calls = [...state.calls.values()];
        if (calls.length === 0) throw new LlmError('protocol', '模型没有调用指定的函数');
        if (calls.length > 1) throw new LlmError('protocol', `模型调用了 ${calls.length} 个函数`);
        if (calls[0]?.name !== request.output.name) {
          throw new LlmError('protocol', '模型调用的不是指定的函数');
        }
        output = calls[0].args;
      }
      return {
        output,
        finishReason: state.finishReason,
        usage: state.usage,
        responseModel: state.responseModel,
        chunks: state.chunks,
        comments: parser.comments,
      };
    } catch (error) {
      const reported =
        failure ??
        (error instanceof LlmError
          ? error
          : error instanceof SseError
            ? new LlmError('protocol', error.message)
            : new LlmError('protocol', `处理返回失败：${scrub(describe(error), this.#secrets)}`));
      failure ??= reported;
      throw reported;
    } finally {
      disarm();
      signal.removeEventListener('abort', onAbort);
      // 读完或出错都断开：之后到达的数据不再接收。
      controller.abort();
    }
  }
}
