import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { test } from 'node:test';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { systemClock } from '@bellis/kernel';
import { VtsClient } from '../src/index.ts';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 服务端发出的一帧文本；compressed 时置 RSV1。 */
function frame(payload: Buffer, compressed: boolean): Buffer {
  const head = [0x80 | (compressed ? 0x40 : 0) | 0x1];
  if (payload.length < 126) head.push(payload.length);
  else head.push(126, payload.length >> 8, payload.length & 0xff);
  return Buffer.concat([Buffer.from(head), payload]);
}

/** 逐帧解出客户端发来的文本（客户端的帧带掩码；置 RSV1 的按 RFC 7692 解压）。 */
function reader(onText: (text: string) => void): (chunk: Buffer) => void {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const rsv1 = ((buffer[0] as number) & 0x40) !== 0;
      const opcode = (buffer[0] as number) & 0x0f;
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
      if (buffer.length < offset + 4 + length) return;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++)
        payload[i] = (payload[i] as number) ^ (mask[i % 4] as number);
      buffer = buffer.subarray(offset + 4 + length);
      if (opcode !== 0x1) continue;
      const text = rsv1
        ? inflateRawSync(Buffer.concat([payload, Buffer.from([0, 0, 0xff, 0xff])]))
        : payload;
      onText(text.toString('utf8'));
    }
  };
}

/**
 * 按真机 VTS（1.35.10）的方式说话的最小服务端：客户端请求 permessage-deflate 就接受，并且每条应答都编码成
 * 一个以结束块收尾的完整 deflate 流（不是 RFC 7692 的同步刷新）；客户端不请求就发明文。
 * 每收到一个请求，回一条带同一 requestID 的 APIStateResponse。
 */
async function vtsStyleServer(): Promise<{ url: string; offered: string[]; close(): void }> {
  const offered: string[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer();
  server.on('upgrade', (req, socket: Socket) => {
    // 升级后的连接不归 HTTP 服务器管，关闭时要自己销毁。
    sockets.add(socket);
    socket.on('error', () => {});
    const extensions = String(req.headers['sec-websocket-extensions'] ?? '');
    offered.push(extensions);
    const deflate = extensions.includes('permessage-deflate');
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}${GUID}`)
      .digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        ...(deflate
          ? [
              'Sec-WebSocket-Extensions: permessage-deflate; client_no_context_takeover; server_no_context_takeover',
            ]
          : []),
        '',
        '',
      ].join('\r\n'),
    );
    socket.on(
      'data',
      reader((text) => {
        const { requestID } = JSON.parse(text) as { requestID: string };
        const reply = Buffer.from(
          JSON.stringify({
            apiName: 'VTubeStudioPublicAPI',
            apiVersion: '1.0',
            requestID,
            messageType: 'APIStateResponse',
            data: { active: true, vTubeStudioVersion: '1.35.10' },
          }),
        );
        socket.write(deflate ? frame(deflateRawSync(reply), true) : frame(reply, false));
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    offered,
    close() {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

test('连续的应答都能收到：不请求压缩，VTS 式的压缩帧不会让后面的应答变空', async () => {
  const vts = await vtsStyleServer();
  const client = await VtsClient.connect(vts.url, systemClock(), 2000);
  try {
    for (let i = 0; i < 3; i++) {
      const response = await client.request('APIStateRequest', {}, 1000);
      assert.equal(response.ok, true);
      assert.equal(response.ok && response.messageType, 'APIStateResponse');
    }
    assert.deepEqual(vts.offered, ['']);
  } finally {
    client.close();
    vts.close();
  }
});
