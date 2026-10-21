import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** 伪端点收到的一次请求。 */
export interface Recorded {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

/** 测试脚本：决定这次请求怎么应答。 */
export interface Exchange {
  request: Recorded;
  res: ServerResponse;
  /** 客户端是否已断开。 */
  closed(): boolean;
  /** 依次写出片段（每片之间等 `delayMs`），客户端断开后停写；返回实际写出的片数。 */
  stream(pieces: readonly (string | Uint8Array)[], delayMs?: number): Promise<number>;
}

export type Script = (exchange: Exchange) => void | Promise<void>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 本机的伪 Chat Completions 端点（127.0.0.1，随机端口）：记下请求，按测试给的脚本应答，记下客户端何时断开、
 * 断开后服务端还想写多少片。不连外网。
 */
export class FakeChat {
  readonly requests: Recorded[] = [];
  /** 客户端在应答结束前断开的次数。 */
  disconnects = 0;
  /** 客户端断开之后脚本还试图写出的片数（客户端收不到）。 */
  writesAfterClose = 0;
  script: Script = (exchange) => {
    exchange.res.writeHead(500).end();
  };
  readonly #server: Server;
  readonly #open = new Set<ServerResponse>();
  readonly url: string;

  private constructor(server: Server, url: string) {
    this.#server = server;
    this.url = url;
  }

  static async start(): Promise<FakeChat> {
    let fake: FakeChat | undefined;
    const server = createServer((req, res) => {
      void fake?.handle(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    fake = new FakeChat(server, `http://127.0.0.1:${port}/api/v3/chat/completions`);
    return fake;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    } catch {
      // 不是 JSON：记成空对象。
    }
    const request: Recorded = {
      method: req.method ?? '',
      path: req.url ?? '',
      headers: req.headers,
      body,
    };
    this.requests.push(request);
    let closed = false;
    this.#open.add(res);
    res.on('close', () => {
      this.#open.delete(res);
      if (!res.writableEnded) this.disconnects += 1;
      closed = true;
    });
    const exchange: Exchange = {
      request,
      res,
      closed: () => closed,
      stream: async (pieces, delayMs = 0) => {
        if (!res.headersSent) {
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
          });
        }
        let written = 0;
        for (const piece of pieces) {
          if (delayMs > 0) await sleep(delayMs);
          if (closed) {
            this.writesAfterClose += 1;
            continue;
          }
          res.write(piece);
          written += 1;
        }
        return written;
      },
    };
    try {
      await this.script(exchange);
    } catch {
      if (!res.headersSent) res.writeHead(500);
    }
  }

  /** 等客户端断开（或超时）。 */
  async waitDisconnect(count = 1, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.disconnects < count) {
      if (Date.now() > deadline)
        throw new Error(`等待客户端断开超时（已断开 ${this.disconnects} 次）`);
      await sleep(5);
    }
  }

  async close(): Promise<void> {
    for (const res of this.#open) res.destroy();
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}

/** 一次写完：SSE 头加全部片段，然后结束应答。 */
export function respond(pieces: readonly (string | Uint8Array)[], delayMs = 0): Script {
  return async (exchange) => {
    await exchange.stream(pieces, delayMs);
    if (!exchange.closed()) exchange.res.end();
  };
}

/** 非 200 的应答。 */
export function status(code: number, body: string, contentType = 'application/json'): Script {
  return (exchange) => {
    exchange.res.writeHead(code, { 'content-type': contentType }).end(body);
  };
}
