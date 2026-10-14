import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import { ChannelError, encodeFrame, FrameDecoder, FrameKind } from '../src/index.ts';

const frameArb = fc.record({
  kind: fc.constantFrom(FrameKind.Handshake, FrameKind.Json, FrameKind.Binary),
  payload: fc.uint8Array({ maxLength: 64 }),
});

test('任意切分的字节流都能按序还原出原来的帧', () => {
  fc.assert(
    fc.property(
      fc.array(frameArb, { maxLength: 20 }),
      fc.array(fc.nat(), { maxLength: 30 }),
      (frames, cuts) => {
        const bytes = Buffer.concat(frames.map((f) => encodeFrame(f.kind, f.payload)));
        const points = [...new Set(cuts.map((c) => c % (bytes.length + 1)))].sort((a, b) => a - b);
        const decoder = new FrameDecoder(64);
        const decoded: Array<{ kind: number; payload: Buffer }> = [];
        let start = 0;
        for (const end of [...points, bytes.length]) {
          decoder.push(bytes.subarray(start, end));
          start = end;
          for (let frame = decoder.read(); frame; frame = decoder.read()) decoded.push(frame);
        }
        assert.deepEqual(
          decoded.map((f) => ({ kind: f.kind, payload: Buffer.from(f.payload) })),
          frames.map((f) => ({ kind: f.kind, payload: Buffer.from(f.payload) })),
        );
        assert.equal(decoder.bufferedBytes, 0);
      },
    ),
  );
});

test('只收到帧头就能判定超长，不必等负载到齐', () => {
  const decoder = new FrameDecoder(4);
  decoder.push(encodeFrame(FrameKind.Json, Buffer.alloc(5)).subarray(0, 5));
  assert.throws(
    () => decoder.read(),
    (error) => error instanceof ChannelError && error.code === 'frame-too-large',
  );
});

test('未知帧类型按协议错误处理', () => {
  const decoder = new FrameDecoder(64);
  decoder.push(Buffer.from([0, 0, 0, 0, 9]));
  assert.throws(
    () => decoder.read(),
    (error) => error instanceof ChannelError && error.code === 'protocol-error',
  );
});

test('两次读取之间可以放宽上限', () => {
  const decoder = new FrameDecoder(2);
  decoder.push(
    Buffer.concat([
      encodeFrame(FrameKind.Handshake, Buffer.alloc(2)),
      encodeFrame(FrameKind.Json, Buffer.alloc(10)),
    ]),
  );
  assert.equal(decoder.read()?.payload.length, 2);
  decoder.maxPayloadBytes = 10;
  assert.equal(decoder.read()?.payload.length, 10);
});
