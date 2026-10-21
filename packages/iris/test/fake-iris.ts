import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** 伪 Iris 收到的一次请求。 */
export interface IrisRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: unknown;
}

/** 存下的一条消息。 */
export interface StoredMessage {
  id: number;
  entryId: string;
  dedupeKey: string;
  body: Record<string, unknown>;
}

/** 下一次请求的应答（覆盖正常处理）：测试注入错误、延迟或不合约定的返回体。 */
export interface Override {
  status: number;
  body?: string;
  headers?: Record<string, string>;
  /** 先等这么久再应答（毫秒）。 */
  delayMs?: number;
}

const HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 存下的消息作为记忆：说话人为写入时的 sender，来源为那条消息。 */
function memoryOf(message: StoredMessage) {
  return {
    id: message.id,
    content: message.body.content,
    kind: '事件',
    stance: message.body.kind === 'self_output' ? '亲历' : '转述',
    revision: 1,
    lifecycle: 'active',
    reason: 'relevant',
    speaker_name: message.body.sender,
    about: [],
    tags: [],
    sources: [
      { message_id: message.id, entry_id: message.entryId, entry_name: null, occurred_at: null },
    ],
  };
}

type FakeMemory = ReturnType<typeof memoryOf>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 契约的统一错误体。 */
function errorBody(
  code: string,
  message: string,
  fields: Array<{ field: string; message: string }> = [],
  retryAfter?: number,
): string {
  return JSON.stringify({
    error: {
      code,
      message,
      fields,
      retry_after_seconds: retryAfter ?? null,
      retry_at:
        retryAfter === undefined ? null : new Date(Date.now() + retryAfter * 1000).toISOString(),
    },
  });
}

/**
 * 本机的伪 Iris（127.0.0.1，随机端口），按宿主接口 v1 契约（iris-core `docs/host-api.md`）实现 Bellis 用到的部分：
 * Host 检查先于鉴权（只认 127.0.0.1、localhost、[::1]，可带端口），每个请求核对 `Authorization: Bearer`；
 * 写入按入口与去重键去重（重复的键返回原消息 ID，不覆盖正文），数组整批原子；召回准备把存下的消息当作记忆返回；
 * 使用反馈核对召回标识与记忆 ID，同一召回与记忆只强化一次。不连外网。
 */
export class FakeIris {
  readonly requests: IrisRequest[] = [];
  readonly messages: StoredMessage[] = [];
  /** 依次用于下一次请求的应答（覆盖正常处理）。 */
  readonly overrides: Override[] = [];
  /** 正常应答前的延迟（毫秒）。 */
  delayMs = 0;
  /** `GET /status` 的服务状态。 */
  service = 'ready';
  readonly #token: string;
  readonly #server: Server;
  readonly #open = new Set<ServerResponse>();
  readonly #recalls = new Map<string, { ids: Set<number>; strengthened: Set<number> }>();
  readonly url: string;
  readonly port: number;

  private constructor(server: Server, port: number, token: string) {
    this.#server = server;
    this.port = port;
    this.url = `http://127.0.0.1:${port}`;
    this.#token = token;
  }

  static async start(token: string): Promise<FakeIris> {
    let fake: FakeIris | undefined;
    const server = createServer((req, res) => {
      void fake?.handle(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    fake = new FakeIris(server, port, token);
    return fake;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.#open.add(res);
    res.on('close', () => this.#open.delete(res));
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    let body: unknown;
    try {
      body = text === '' ? undefined : JSON.parse(text);
    } catch {
      body = text;
    }
    const request: IrisRequest = {
      method: req.method ?? '',
      path: req.url ?? '',
      headers: req.headers,
      body,
    };
    this.requests.push(request);
    const send = (status: number, payload: string, headers: Record<string, string> = {}) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        ...headers,
      });
      res.end(payload);
    };
    const override = this.overrides.shift();
    if (override) {
      if (override.delayMs) await sleep(override.delayMs);
      send(override.status, override.body ?? '', override.headers ?? {});
      return;
    }
    if (this.delayMs > 0) await sleep(this.delayMs);
    // Host 检查先于就绪检查与鉴权。
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (!HOSTS.includes(host)) {
      send(
        400,
        errorBody('invalid_host', 'Host 不被接受', [{ field: 'header.host', message: '' }]),
      );
      return;
    }
    if (req.headers.authorization !== `Bearer ${this.#token}`) {
      send(401, errorBody('unauthorized', '缺少或无效的宿主令牌'), {
        'www-authenticate': 'Bearer',
      });
      return;
    }
    const [path] = request.path.split('?');
    const entry = /^\/api\/v1\/entries\/([^/]+)\/(messages|prepare)$/.exec(path ?? '');
    if (req.method === 'POST' && entry?.[2] === 'messages') {
      this.#messages(decodeURIComponent(entry[1] ?? ''), body, send);
    } else if (req.method === 'POST' && entry?.[2] === 'prepare') {
      this.#prepare(decodeURIComponent(entry[1] ?? ''), body, send);
    } else if (req.method === 'POST' && path === '/api/v1/memories/search') {
      this.#search(body, send);
    } else if (req.method === 'POST' && path === '/api/v1/feedback') {
      this.#feedback(body, send);
    } else if (req.method === 'GET' && path === '/api/v1/status') {
      send(200, JSON.stringify({ service: this.service, models: [], backlog: [], entries: [] }));
    } else {
      send(404, errorBody('not_found', '没有这个接口'));
    }
  }

  #messages(entryId: string, body: unknown, send: (status: number, payload: string) => void): void {
    const list = Array.isArray(body) ? body : [body];
    if (list.length < 1 || list.length > 1000) {
      send(
        400,
        errorBody('invalid_request', '数组须为 1—1000 条', [{ field: 'body', message: '' }]),
      );
      return;
    }
    const fields: Array<{ field: string; message: string }> = [];
    list.forEach((item, i) => {
      if (!isRecord(item)) {
        fields.push({ field: `body.${i}`, message: '不是对象' });
        return;
      }
      for (const name of ['sender', 'content', 'occurred_at', 'dedupe_key']) {
        if (typeof item[name] !== 'string')
          fields.push({ field: `body.${i}.${name}`, message: '必填' });
      }
      if (typeof item.occurred_at === 'string' && !/(Z|[+-]\d\d:\d\d)$/.test(item.occurred_at)) {
        fields.push({ field: `body.${i}.occurred_at`, message: '需要带时区的 ISO 时间' });
      }
    });
    if (fields.length > 0) {
      send(400, errorBody('invalid_request', '请求格式或内容不合法', fields));
      return;
    }
    // 整批原子：先算好再一起存。
    const ids = (list as Record<string, unknown>[]).map((item) => {
      const key = String(item.dedupe_key);
      const existing = this.messages.find((m) => m.entryId === entryId && m.dedupeKey === key);
      if (existing) return existing.id;
      const stored = { id: this.messages.length + 1, entryId, dedupeKey: key, body: item };
      this.messages.push(stored);
      return stored.id;
    });
    const pending = this.messages.filter((m) => m.entryId === entryId).length;
    send(200, JSON.stringify({ message_ids: ids, pending_count: pending }));
  }

  #recall(memories: FakeMemory[]): string {
    const recallId = `recall-${this.#recalls.size + 1}`;
    this.#recalls.set(recallId, {
      ids: new Set(memories.map((m) => m.id)),
      strengthened: new Set(),
    });
    return recallId;
  }

  #prepare(entryId: string, body: unknown, send: (status: number, payload: string) => void): void {
    const request = isRecord(body) ? body : {};
    const limit = typeof request.memory_limit === 'number' ? request.memory_limit : 8;
    const memories = this.messages
      .filter((m) => m.entryId === entryId)
      .slice(-limit)
      .reverse()
      .map(memoryOf);
    send(
      200,
      JSON.stringify({
        persona: {
          version: null,
          content: '',
          generated_at: null,
          needs_update: false,
          stale_basis_count: 0,
        },
        memories,
        recent_messages: [],
        state: {},
        goals: [],
        hints: [],
        judgment: { status: request.judge === false ? 'disabled' : 'applied' },
        recall_id: this.#recall(memories),
        entry_profile: null,
        people: [],
      }),
    );
  }

  #search(body: unknown, send: (status: number, payload: string) => void): void {
    const request = isRecord(body) ? body : {};
    const text = typeof request.text === 'string' ? request.text : '';
    const limit = typeof request.limit === 'number' ? request.limit : 8;
    const memories = this.messages
      .filter((m) => String(m.body.content).includes(text))
      .filter((m) => request.entry_id === undefined || m.entryId === request.entry_id)
      .slice(-limit)
      .map(memoryOf);
    send(200, JSON.stringify({ memories, hints: [], recall_id: this.#recall(memories) }));
  }

  #feedback(body: unknown, send: (status: number, payload: string) => void): void {
    const request = isRecord(body) ? body : {};
    const recallId = request.recall_id;
    const ids = Array.isArray(request.memory_ids) ? (request.memory_ids as number[]) : [];
    const recall = typeof recallId === 'string' ? this.#recalls.get(recallId) : undefined;
    if (!recall) {
      send(404, errorBody('recall_not_found', '召回不存在或已过期'));
      return;
    }
    if (ids.some((id) => !recall.ids.has(id))) {
      send(
        400,
        errorBody('memory_not_in_recall', '记忆不属于这次召回', [
          { field: 'body.memory_ids', message: '' },
        ]),
      );
      return;
    }
    const strengthened = ids.filter((id) => !recall.strengthened.has(id));
    for (const id of strengthened) recall.strengthened.add(id);
    send(200, JSON.stringify({ recall_id: recallId, accepted: ids, strengthened }));
  }

  /** 契约的错误应答，供测试注入。 */
  static error(
    status: number,
    code: string,
    options: {
      fields?: string[];
      retryAfter?: number;
      message?: string;
      headers?: Record<string, string>;
    } = {},
  ): Override {
    return {
      status,
      body: errorBody(
        code,
        options.message ?? '错误',
        (options.fields ?? []).map((field) => ({ field, message: '' })),
        options.retryAfter,
      ),
      ...(options.headers ? { headers: options.headers } : {}),
    };
  }

  async close(): Promise<void> {
    for (const res of this.#open) res.destroy();
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}
