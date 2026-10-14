import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * 只供模拟 OBS 使用的最小 WebSocket 服务端（RFC 6455）：文本帧、分片、ping/pong、关闭。
 * 不用于生产路径；Stage 服务的 WebSocket 服务端随 R-08 另行选型。
 */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE_BYTES = 1024 * 1024;

export class WsConnection extends EventEmitter<{ message: [text: string]; close: [] }> {
  readonly #socket: Duplex;
  #buffer = Buffer.alloc(0);
  #fragments: Buffer[] = [];
  #closed = false;

  constructor(socket: Duplex) {
    super();
    this.#socket = socket;
    socket.on('data', (chunk: Buffer) => this.#onData(chunk));
    socket.on('close', () => this.#finish());
    socket.on('error', () => this.#finish());
  }

  send(text: string): void {
    if (!this.#closed) this.#socket.write(frame(0x1, Buffer.from(text, 'utf8')));
  }

  close(code = 1000, reason = ''): void {
    if (this.#closed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this.#socket.write(frame(0x8, payload));
    this.#socket.end();
    this.#finish();
  }

  terminate(): void {
    this.#socket.destroy();
    this.#finish();
  }

  #finish(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.emit('close');
  }

  #onData(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const buffer = this.#buffer;
      if (buffer.length < 2) return;
      const fin = (buffer[0] as number) & 0x80;
      const opcode = (buffer[0] as number) & 0x0f;
      const masked = (buffer[1] as number) & 0x80;
      let length = (buffer[1] as number) & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (!masked || length > MAX_MESSAGE_BYTES) {
        this.terminate();
        return;
      }
      if (buffer.length < offset + 4 + length) return;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] = (payload[i] as number) ^ (mask[i % 4] as number);
      }
      this.#buffer = buffer.subarray(offset + 4 + length);
      this.#handle(opcode, fin !== 0, payload);
      if (this.#closed) return;
    }
  }

  #handle(opcode: number, fin: boolean, payload: Buffer): void {
    switch (opcode) {
      case 0x0:
      case 0x1:
        this.#fragments.push(payload);
        if (fin) {
          const text = Buffer.concat(this.#fragments).toString('utf8');
          this.#fragments = [];
          this.emit('message', text);
        }
        return;
      case 0x8:
        this.close();
        return;
      case 0x9:
        this.#socket.write(frame(0xa, payload));
        return;
      default:
        return;
    }
  }
}

function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  const header =
    length < 126
      ? Buffer.from([0x80 | opcode, length])
      : length < 65536
        ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
        : (() => {
            const h = Buffer.alloc(10);
            h[0] = 0x80 | opcode;
            h[1] = 127;
            h.writeBigUInt64BE(BigInt(length), 2);
            return h;
          })();
  return Buffer.concat([header, payload]);
}

/** 在 HTTP 服务上接受 WebSocket 升级；客户端请求的子协议在 `protocols` 中时回显第一个匹配项。 */
export function createWsServer(
  protocols: readonly string[],
  onConnection: (connection: WsConnection, request: IncomingMessage) => void,
): Server {
  const server = createServer((_request, response) => {
    response.writeHead(426).end();
  });
  server.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
    const key = request.headers['sec-websocket-key'];
    if (request.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const requested = String(request.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    const chosen = requested.find((p) => protocols.includes(p));
    const accept = createHash('sha1')
      .update(key + GUID)
      .digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        ...(chosen ? [`Sec-WebSocket-Protocol: ${chosen}`] : []),
        '',
        '',
      ].join('\r\n'),
    );
    onConnection(new WsConnection(socket), request);
  });
  return server;
}
