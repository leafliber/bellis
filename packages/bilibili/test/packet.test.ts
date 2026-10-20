import assert from 'node:assert/strict';
import { test } from 'node:test';
import { brotliCompressSync, deflateSync } from 'node:zlib';
import {
  decodePackets,
  encodePacket,
  MAX_INFLATED_BYTES,
  Operation,
  PacketError,
  Version,
} from '../src/index.ts';

test('包头：16 字节大端，PacketLen、HeaderLen、Version、Operation、Seq 依次排列', () => {
  const packet = encodePacket(Operation.Auth, '{"a":1}', 1, 7);
  assert.deepEqual([...packet.subarray(0, 16)], [0, 0, 0, 23, 0, 16, 0, 1, 0, 0, 0, 7, 0, 0, 0, 7]);
  assert.equal(packet.subarray(16).toString('utf8'), '{"a":1}');
  // 客户端发的包缺省写 Version 1，正文可以为空（心跳）。
  assert.deepEqual(
    [...encodePacket(Operation.Heartbeat)],
    [0, 0, 0, 16, 0, 16, 0, 1, 0, 0, 0, 2, 0, 0, 0, 1],
  );
});

test('解包：手写的字节按大端读出，一条消息里连着的多个包依次拆开', () => {
  const body = Buffer.from('{"cmd":"X"}');
  const header = Buffer.from([0, 0, 0, 16 + body.length, 0, 16, 0, 0, 0, 0, 0, 5, 0, 0, 0, 9]);
  const heartbeatReply = Buffer.from([
    0, 0, 0, 20, 0, 16, 0, 1, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 1,
  ]);
  const packets = decodePackets(Buffer.concat([header, body, heartbeatReply]));
  assert.equal(packets.length, 2);
  assert.deepEqual(
    { ...packets[0], body: packets[0]?.body.toString() },
    { version: 0, operation: 5, sequence: 9, body: '{"cmd":"X"}' },
  );
  assert.equal(packets[1]?.operation, Operation.HeartbeatReply);
  assert.equal(packets[1]?.body.readUInt32BE(0), 1);
});

test('解包：HeaderLen 大于 16 时按它切出正文', () => {
  const header = Buffer.alloc(20);
  header.writeUInt32BE(24, 0);
  header.writeUInt16BE(20, 4);
  header.writeUInt32BE(Operation.Message, 8);
  const [packet] = decodePackets(Buffer.concat([header, Buffer.from('abcd')]));
  assert.equal(packet?.body.toString(), 'abcd');
});

test('解包：zlib（Version 2）与 brotli（Version 3）的批量包解压后递归拆开，压缩里再套压缩也能拆', () => {
  const message = (n: number) =>
    encodePacket(Operation.Message, JSON.stringify({ cmd: 'C', data: n }), Version.Raw, 0);
  const inner = encodePacket(
    Operation.Message,
    deflateSync(Buffer.concat([message(3), message(4)])),
    Version.Zlib,
  );
  const zlib = encodePacket(
    Operation.Message,
    deflateSync(Buffer.concat([message(1), message(2), inner])),
    Version.Zlib,
  );
  const brotli = encodePacket(
    Operation.Message,
    brotliCompressSync(Buffer.concat([message(5), message(6)])),
    Version.Brotli,
  );
  const packets = decodePackets(Buffer.concat([zlib, brotli, message(7)]));
  assert.deepEqual(
    packets.map((p) => (JSON.parse(p.body.toString()) as { data: number }).data),
    [1, 2, 3, 4, 5, 6, 7],
  );
  assert.ok(packets.every((p) => p.version === Version.Raw && p.operation === Operation.Message));
});

test('解包：格式不对时抛 PacketError', () => {
  const ok = encodePacket(Operation.Message, '{}', 0);
  assert.throws(() => decodePackets(ok.subarray(0, 10)), PacketError);
  assert.throws(() => decodePackets(ok.subarray(0, ok.length - 1)), PacketError);
  const shortHeader = Buffer.from(ok);
  shortHeader.writeUInt16BE(8, 4);
  assert.throws(() => decodePackets(shortHeader), /包头长度/);
  const zeroLength = Buffer.from(ok);
  zeroLength.writeUInt32BE(0, 0);
  assert.throws(() => decodePackets(zeroLength), /小于包头长度/);
  const garbage = encodePacket(Operation.Message, Buffer.from('not zlib'), Version.Zlib);
  assert.throws(() => decodePackets(garbage), /zlib 解压失败/);
  const brokenBrotli = encodePacket(Operation.Message, Buffer.from([1, 2, 3, 4]), Version.Brotli);
  assert.throws(() => decodePackets(brokenBrotli), /brotli 解压失败/);
});

test('解包：解压结果超过上限、压缩嵌套过深都拒绝', () => {
  const bomb = encodePacket(
    Operation.Message,
    deflateSync(Buffer.alloc(MAX_INFLATED_BYTES + 1)),
    Version.Zlib,
  );
  assert.throws(() => decodePackets(bomb), PacketError);
  let nested = encodePacket(Operation.Message, '{}', Version.Raw);
  for (let i = 0; i < 6; i += 1) {
    nested = encodePacket(Operation.Message, deflateSync(nested), Version.Zlib);
  }
  assert.throws(() => decodePackets(nested), /嵌套过深/);
});
