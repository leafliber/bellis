import type { Clock } from '@bellis/kernel';
import {
  entryIdBlocker,
  IrisError,
  type IrisErrorKind,
  type IrisFeedbackResult,
  type IrisMemory,
  type IrisMessage,
  type IrisPersona,
  type IrisPrepareRequest,
  type IrisRecall,
  type IrisStatus,
  type IrisWriteResult,
} from '@bellis/memory';

/**
 * Iris 宿主接口 v1 的 HTTP 薄客户端（R-19）：按 iris-core `docs/host-api.md` 自写，不引入 iris-core 的客户端
 * （AGPL-3.0）。只负责收发：请求体由调用方的参数确定，返回体只取 Bellis 用到的字段并核对类型，未知字段忽略。
 *
 * - 每个请求带 `Authorization: Bearer <宿主令牌>`；令牌只放请求头，不进 URL、日志与错误说明。不跟随重定向。
 * - 不做隐式重试：失败按 HTTP 状态与错误码归类（{@link IrisErrorKind}），由调用方决定是否、何时重试
 *   （写入重试沿用原去重键）。连接超时不能当作没写成。
 * - 每个请求有截止时间（`requestTimeoutMs`）；调用方的中止信号一到即中止 fetch。返回体至多读 `maxResponseBytes`。
 */

export interface IrisClientOptions {
  /** Iris 的地址，例如 `http://127.0.0.1:8080`（不含 `/api/v1`）。 */
  baseUrl: string;
  /** 宿主令牌：只用于请求头。 */
  token: string;
  clock: Clock;
  requestTimeoutMs: number;
  maxResponseBytes: number;
}

/** 定向查询（`POST /memories/search`）的参数。 */
export interface IrisSearchRequest {
  text: string;
  /** 查询入口；给出时检查令牌权限。 */
  entryId?: string;
  /** 1–100。 */
  limit: number;
}

export interface IrisSearchResult {
  recallId: string;
  memories: IrisMemory[];
}

const KIND_WORDS: Record<IrisErrorKind, string> = {
  auth: '鉴权失败',
  forbidden: '无权访问',
  not_found: '不存在',
  conflict: '冲突',
  too_large: '超过大小上限',
  invalid: '请求不合法',
  rate_limit: '限流',
  unavailable: '暂不可用',
  server: '服务端出错',
  timeout: '超时',
  network: '连接失败',
  protocol: '返回不合约定',
  aborted: '已取消',
};

/** Retry-After 的上限：不让一个异常的值把写入停太久。 */
const MAX_RETRY_AFTER_MS = 10 * 60_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isInt = (value: unknown): value is number => Number.isSafeInteger(value);

/** 只留可打印 ASCII（错误码、字段路径），截到 `max` 个字符。 */
function ascii(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const out = value.replace(/[^\x20-\x7e]/g, '').slice(0, max);
  return out === '' ? undefined : out;
}

/** 抹掉文本里出现的令牌，合并空白并截短。 */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text.replace(/\s+/g, ' ').trim();
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join('***');
  return out.length > 200 ? `${out.slice(0, 200)}…` : out;
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? `（${error.cause.message}）` : '';
  return `${error.message}${cause}`;
}

export function kindOfStatus(status: number): IrisErrorKind {
  switch (status) {
    case 401:
      return 'auth';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 413:
      return 'too_large';
    case 429:
      return 'rate_limit';
    case 503:
      return 'unavailable';
    default:
      return status >= 500 ? 'server' : 'invalid';
  }
}

/** 等多久再试（毫秒）：先看错误体的 `retry_after_seconds`，再看 `Retry-After` 头（整数秒）。 */
function retryAfter(error: Record<string, unknown>, headers: Headers): number | undefined {
  const fromBody = error.retry_after_seconds;
  const fromHeader = Number(headers.get('retry-after') ?? Number.NaN);
  const seconds = isInt(fromBody) && fromBody > 0 ? fromBody : fromHeader;
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.min(Math.round(seconds * 1000), MAX_RETRY_AFTER_MS);
}

/**
 * 非 2xx 的应答：按 HTTP 状态归类（不靠说明文字判断）。说明里只有类别、HTTP 状态、错误码与出错的字段路径，
 * 不含 Iris 的说明文字（可能复述了请求内容）。
 */
export function httpError(status: number, headers: Headers, text: string): IrisError {
  let error: Record<string, unknown> = {};
  try {
    const body: unknown = JSON.parse(text);
    if (isRecord(body) && isRecord(body.error)) error = body.error;
  } catch {
    // 不是 JSON：只按状态归类。
  }
  const kind = kindOfStatus(status);
  const code = ascii(error.code, 64);
  const fields = Array.isArray(error.fields)
    ? error.fields
        .map((field) => (isRecord(field) ? ascii(field.field, 80) : undefined))
        .filter((field): field is string => field !== undefined)
        .slice(0, 5)
    : [];
  const wait =
    kind === 'rate_limit' || kind === 'unavailable' ? retryAfter(error, headers) : undefined;
  return new IrisError(
    kind,
    `${KIND_WORDS[kind]}：HTTP ${status}${code ? `（${code}）` : ''}${fields.length > 0 ? `；字段 ${fields.join('、')}` : ''}`,
    {
      status,
      ...(code ? { code } : {}),
      ...(wait === undefined ? {} : { retryAfterMs: wait }),
    },
  );
}

/** 读返回体，至多 `maxBytes` 字节；超过即以 `protocol` 结束。 */
async function readBody(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new IrisError('protocol', `返回体超过 ${maxBytes} 字节`);
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

const protocol = (what: string) => new IrisError('protocol', `${KIND_WORDS.protocol}：${what}`);

function intArray(value: unknown, what: string): number[] {
  if (!Array.isArray(value) || !value.every(isInt)) throw protocol(`${what} 不是整数数组`);
  return value;
}

/** 契约的 memory 对象：取 Bellis 用到的字段并核对类型；其余字段忽略。 */
export function parseMemory(value: unknown): IrisMemory {
  if (!isRecord(value)) throw protocol('记忆不是对象');
  const { id, content, kind, stance, speaker_name, about, sources } = value;
  if (!isInt(id) || typeof content !== 'string') throw protocol('记忆缺少 id 或 content');
  if (!Array.isArray(sources)) throw protocol('记忆缺少 sources');
  const parsedSources = sources.map((source) => {
    if (!isRecord(source) || !isInt(source.message_id)) throw protocol('来源缺少 message_id');
    const entry = source.entry_id;
    if (entry !== null && entry !== undefined && typeof entry !== 'string')
      throw protocol('来源的 entry_id 类型不对');
    return { messageId: source.message_id, entryId: typeof entry === 'string' ? entry : null };
  });
  const parsedAbout = (Array.isArray(about) ? about : []).map((person) => {
    if (!isRecord(person) || typeof person.id !== 'string' || typeof person.name !== 'string')
      throw protocol('about 的项缺少 id 或 name');
    return { id: person.id, name: person.name };
  });
  return {
    id,
    content,
    ...(typeof kind === 'string' ? { kind } : {}),
    ...(typeof stance === 'string' ? { stance } : {}),
    ...(typeof speaker_name === 'string' ? { speakerName: speaker_name } : {}),
    about: parsedAbout,
    sources: parsedSources,
  };
}

/**
 * 召回准备的 `persona` 分区：只取正文与版本号，更新提示不取。分区缺失或类型不对时为 undefined
 * （不让整次召回失败）。
 */
export function parsePersona(value: unknown): IrisPersona | undefined {
  if (!isRecord(value) || typeof value.content !== 'string') return undefined;
  const version = value.version;
  return { content: value.content, version: isInt(version) ? version : null };
}

/** 写入的请求体（契约字段名）：可选字段没给就不发。 */
export function messageBody(message: IrisMessage): Record<string, unknown> {
  return {
    platform: message.platform,
    sender: message.sender,
    ...(message.accountId === undefined ? {} : { account_id: message.accountId }),
    content: message.content,
    occurred_at: message.occurredAt,
    dedupe_key: message.dedupeKey,
    kind: message.kind,
    ...(message.entryName === undefined ? {} : { entry_name: message.entryName }),
    ...(message.entryKind === undefined ? {} : { entry_kind: message.entryKind }),
    ...(message.pace === undefined ? {} : { pace: message.pace }),
  };
}

/**
 * 召回准备的请求体：只召回记忆。人物要点（`participants: []`）、人物摘要（`people_limit: 0`）、
 * 近期原始消息（`recent_limit: 0`）与目标（`goal_limit: 0`）都不取。
 */
export function prepareBody(request: IrisPrepareRequest): Record<string, unknown> {
  return {
    ...(request.text === undefined ? {} : { text: request.text }),
    judge: request.judge,
    ...(request.judgeBudgetSeconds === undefined
      ? {}
      : { judge_budget_seconds: request.judgeBudgetSeconds }),
    participants: [],
    people_limit: 0,
    recent_limit: 0,
    goal_limit: 0,
    memory_limit: request.memoryLimit,
    token_budget: request.tokenBudget,
  };
}

export class IrisClient {
  readonly #options: IrisClientOptions;
  readonly #base: string;

  constructor(options: IrisClientOptions) {
    this.#options = options;
    this.#base = `${options.baseUrl.replace(/\/+$/, '')}/api/v1`;
  }

  #entryPath(entryId: string, action: string): string {
    const blocked = entryIdBlocker(entryId);
    if (blocked) throw new IrisError('invalid', blocked);
    return `/entries/${encodeURIComponent(entryId)}/${action}`;
  }

  /** 发一个请求，返回解析后的 JSON。失败以 {@link IrisError} 结束，说明里不含令牌。 */
  async request(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const { clock, token, requestTimeoutMs, maxResponseBytes } = this.#options;
    if (signal.aborted) throw new IrisError('aborted', KIND_WORDS.aborted);
    const controller = new AbortController();
    let failure: IrisError | undefined;
    const fail = (error: IrisError) => {
      failure ??= error;
      controller.abort();
    };
    const onAbort = () => fail(new IrisError('aborted', KIND_WORDS.aborted));
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = clock.setTimeout(
      () =>
        fail(
          new IrisError('timeout', `${KIND_WORDS.timeout}：请求未在 ${requestTimeoutMs}ms 内完成`),
        ),
      requestTimeoutMs,
    );
    try {
      let response: Response;
      try {
        response = await fetch(`${this.#base}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
          redirect: 'error',
        });
      } catch (error) {
        throw (
          failure ??
          new IrisError('network', `${KIND_WORDS.network}：${scrub(describe(error), [token])}`)
        );
      }
      let text: string;
      try {
        text = await readBody(response, maxResponseBytes);
      } catch (error) {
        if (error instanceof IrisError) throw failure ?? error;
        throw failure ?? new IrisError('network', `读取中断：${scrub(describe(error), [token])}`);
      }
      if (failure) throw failure;
      if (response.status < 200 || response.status >= 300) {
        throw httpError(response.status, response.headers, text);
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw protocol('返回体不是 JSON');
      }
    } finally {
      clock.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  /** `POST /entries/{entry_id}/messages`：总以数组提交（1–1000 条，整批原子）。 */
  async writeMessages(
    entryId: string,
    messages: readonly IrisMessage[],
    signal: AbortSignal,
  ): Promise<IrisWriteResult> {
    if (messages.length < 1 || messages.length > 1000)
      throw new IrisError('invalid', '一次写入 1–1000 条');
    const value = await this.request(
      'POST',
      this.#entryPath(entryId, 'messages'),
      messages.map(messageBody),
      signal,
    );
    if (!isRecord(value)) throw protocol('写入的应答不是对象');
    const messageIds = intArray(value.message_ids, 'message_ids');
    if (messageIds.length !== messages.length) throw protocol('message_ids 与提交的条数不一致');
    if (!isInt(value.pending_count)) throw protocol('缺少 pending_count');
    return { messageIds, pendingCount: value.pending_count };
  }

  /** `POST /entries/{entry_id}/prepare`。 */
  async prepare(
    entryId: string,
    request: IrisPrepareRequest,
    signal: AbortSignal,
  ): Promise<IrisRecall> {
    const value = await this.request(
      'POST',
      this.#entryPath(entryId, 'prepare'),
      prepareBody(request),
      signal,
    );
    if (!isRecord(value)) throw protocol('召回准备的应答不是对象');
    if (typeof value.recall_id !== 'string') throw protocol('缺少 recall_id');
    if (!Array.isArray(value.memories)) throw protocol('缺少 memories');
    const judgment = isRecord(value.judgment) ? ascii(value.judgment.status, 32) : undefined;
    const persona = parsePersona(value.persona);
    return {
      recallId: value.recall_id,
      memories: value.memories.map(parseMemory),
      ...(persona === undefined ? {} : { persona }),
      ...(judgment === undefined ? {} : { judgment }),
    };
  }

  /** `POST /memories/search`（定向查询，不产生新经历）。 */
  async search(request: IrisSearchRequest, signal: AbortSignal): Promise<IrisSearchResult> {
    if (request.entryId !== undefined) {
      const blocked = entryIdBlocker(request.entryId);
      if (blocked) throw new IrisError('invalid', blocked);
    }
    const value = await this.request(
      'POST',
      '/memories/search',
      {
        text: request.text,
        ...(request.entryId === undefined ? {} : { entry_id: request.entryId }),
        limit: request.limit,
      },
      signal,
    );
    if (!isRecord(value)) throw protocol('定向查询的应答不是对象');
    if (typeof value.recall_id !== 'string') throw protocol('缺少 recall_id');
    if (!Array.isArray(value.memories)) throw protocol('缺少 memories');
    return { recallId: value.recall_id, memories: value.memories.map(parseMemory) };
  }

  /** `POST /feedback`：实际用到的记忆，没有用到就是空数组。 */
  async feedback(
    recallId: string,
    memoryIds: readonly number[],
    signal: AbortSignal,
  ): Promise<IrisFeedbackResult> {
    const value = await this.request(
      'POST',
      '/feedback',
      { recall_id: recallId, memory_ids: [...memoryIds] },
      signal,
    );
    if (!isRecord(value)) throw protocol('使用反馈的应答不是对象');
    return {
      accepted: intArray(value.accepted, 'accepted'),
      strengthened: intArray(value.strengthened, 'strengthened'),
    };
  }

  /** `GET /status`：服务状态（其余字段只给探针看，不进说明）。 */
  async status(signal: AbortSignal): Promise<IrisStatus & { raw: Record<string, unknown> }> {
    const value = await this.request('GET', '/status', undefined, signal);
    if (!isRecord(value) || typeof value.service !== 'string') throw protocol('缺少 service');
    return { service: ascii(value.service, 32) ?? '?', raw: value };
  }
}
