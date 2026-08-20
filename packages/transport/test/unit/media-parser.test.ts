import { describe, expect, it } from "vitest";
import { MediaFrameError, MediaFrameParser, encodeMediaFrame } from "../../src/index.js";
import type { MediaFrame } from "../../src/index.js";
import { testHeader } from "./media-codec.test.js";
import { FRAME_ID_A, STREAM_ID } from "../helpers.js";

const PAYLOAD = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);

function validFrameBytes(): Uint8Array {
  return encodeMediaFrame({ header: testHeader(), payload: PAYLOAD, mediaKind: "binary-test" });
}

function chunkify(bytes: Uint8Array, sizes: number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let index = 0;
  while (offset < bytes.byteLength) {
    const size = sizes[index % sizes.length] ?? 1;
    chunks.push(bytes.subarray(offset, offset + size));
    offset += size;
    index += 1;
  }
  return chunks;
}

function parseChunks(chunks: readonly Uint8Array[]): MediaFrame[] {
  const parser = new MediaFrameParser();
  for (const chunk of chunks) {
    parser.push(chunk);
  }
  return [...parser.endMessage()];
}

describe("MediaFrameParser", () => {
  it("单次 push 完整消息 + endMessage → 完整帧", () => {
    const frame = parseChunks([validFrameBytes()])[0];
    expect(frame).toBeDefined();
    if (frame === undefined) {
      return;
    }
    expect(frame.header.streamId).toBe(STREAM_ID);
    expect(frame.header.frameId).toBe(FRAME_ID_A);
    expect(frame.mediaKind).toBe("binary-test");
    expect([...frame.payload]).toEqual([...PAYLOAD]);
  });

  it("任意分片方式产生相同帧（逐字节 / 固定块 / 前缀一刀）", () => {
    const bytes = validFrameBytes();
    const bytewise = parseChunks(chunkify(bytes, [1]));
    const blocks = parseChunks(chunkify(bytes, [3, 7, 2]));
    const half = parseChunks([bytes.subarray(0, 8), bytes.subarray(8)]);
    const expected = bytewise[0];
    expect(expected).toBeDefined();
    if (expected === undefined) {
      return;
    }
    for (const candidate of [blocks[0], half[0]]) {
      expect(candidate).toBeDefined();
      if (candidate === undefined) {
        continue;
      }
      expect(candidate.header).toEqual(expected.header);
      expect([...candidate.payload]).toEqual([...expected.payload]);
      expect(candidate.mediaKind).toBe(expected.mediaKind);
    }
  });

  it("空分片被忽略", () => {
    const bytes = validFrameBytes();
    const parser = new MediaFrameParser();
    parser.push(bytes.subarray(0, 5));
    parser.push(new Uint8Array(0));
    parser.push(bytes.subarray(5));
    const frames = parser.endMessage();
    expect(frames.length).toBe(1);
    expect(frames[0]?.header.streamId).toBe(STREAM_ID);
  });

  it("坏 magic 稳定拒绝并进入 failed 状态", () => {
    const bytes = validFrameBytes();
    bytes[0] = 0x58;
    const parser = new MediaFrameParser();
    expect(() => parser.push(bytes)).toThrowError(/bad_magic/);
    expect(parser.failed).toBe(true);
    expect(() => parser.push(new Uint8Array(1))).toThrowError(/parser_failed/);
    expect(() => parser.endMessage()).toThrowError(/parser_failed/);
    parser.reset();
    expect(parser.failed).toBe(false);
  });

  it("版本不匹配稳定拒绝", () => {
    const bytes = validFrameBytes();
    bytes[4] = 2;
    expect(() => parseChunks([bytes])).toThrowError(/unsupported_version/);
  });

  it("未知 kind 字节稳定拒绝", () => {
    const bytes = validFrameBytes();
    bytes[5] = 9;
    expect(() => parseChunks([bytes])).toThrowError(/invalid_media_kind/);
  });

  it("非零 flags 稳定拒绝", () => {
    const bytes = validFrameBytes();
    bytes[7] = 0x01;
    expect(() => parseChunks([bytes])).toThrowError(/bad_flags/);
  });

  it("Header 长度超限：读到长度字段立即拒绝，不缓冲内容", () => {
    const bytes = validFrameBytes();
    // 长度字段在第 8..11 字节；分片在长度字段到达时触发。
    const parser = new MediaFrameParser({ maxHeaderBytes: 4 });
    expect(() => parser.push(bytes.subarray(0, 12))).toThrowError(/header_too_large/);
  });

  it("Payload 超限：累积越界字节时立即拒绝", () => {
    const bytes = validFrameBytes();
    const parser = new MediaFrameParser({ maxPayloadBytes: 1 });
    expect(() => parser.push(bytes)).toThrowError(/payload_too_large/);
  });

  it("单个超限分片：不做完整复制即拒绝（上限检查先于累积）", () => {
    const bytes = validFrameBytes();
    // 4 MiB 单分片远超默认 1 MiB Payload 上限：解析器不得先缓冲完整输入。
    const huge = Buffer.concat([bytes, Buffer.alloc(4 * 1024 * 1024)]);
    const parser = new MediaFrameParser();
    expect(() => parser.push(huge)).toThrowError(/payload_too_large/);
    expect(parser.failed).toBe(true);
  });

  it("大 Header 上限配置下的超限分片：先补前缀取精确上限，零复制拒绝", () => {
    // 评审配置：maxHeaderBytes=1,000,000 使预检查上限很大，但帧实际
    // Header 很小；携带超限 Payload 的完整分片不得被整体复制后再拒绝。
    const header = testHeader();
    const headerJson = Buffer.from(JSON.stringify(header), "utf8");
    const frame = Buffer.alloc(12 + headerJson.byteLength);
    frame.set([0x42, 0x45, 0x4c, 0x4c, 1, 3, 0, 0], 0);
    frame.writeUInt32LE(headerJson.byteLength, 8);
    frame.set(headerJson, 12);
    const oversized = Buffer.concat([frame, Buffer.alloc(500_000)]);
    const parser = new MediaFrameParser({ maxHeaderBytes: 1_000_000, maxPayloadBytes: 1 });
    expect(() => parser.push(oversized)).toThrowError(/payload_too_large/);
    expect(parser.failed).toBe(true);
  });

  it("Header 超限的单个超限分片：错误分类仍以长度字段为准", () => {
    const bytes = validFrameBytes();
    // 前缀声明 16 KiB 级 Header（默认上限内）+ 超限 Payload。
    const header = testHeader();
    const headerJson = Buffer.from(JSON.stringify(header), "utf8");
    const frame = Buffer.alloc(12 + headerJson.byteLength);
    frame.set([0x42, 0x45, 0x4c, 0x4c, 1, 3, 0, 0], 0);
    frame.writeUInt32LE(headerJson.byteLength, 8);
    frame.set(headerJson, 12);
    const oversized = Buffer.alloc(2 * 1024 * 1024);
    const parser = new MediaFrameParser({ maxPayloadBytes: 1024, maxHeaderBytes: 4 });
    expect(() => parser.push(Buffer.concat([frame, oversized]))).toThrowError(/header_too_large/);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it("逐字节分片解析大帧保持线性可行（无逐分片全量拼接）", () => {
    const payload = Buffer.alloc(256 * 1024, 7);
    const bytes = encodeMediaFrame({
      header: testHeader(),
      payload,
      mediaKind: "binary-test",
    });
    const parser = new MediaFrameParser();
    for (const chunk of chunkify(bytes, [1])) {
      parser.push(chunk);
    }
    const frame = parser.endMessage()[0];
    expect(frame).toBeDefined();
    if (frame !== undefined) {
      expect(frame.payload.byteLength).toBe(payload.byteLength);
    }
  });

  it("非法 UTF-8 拒绝", () => {
    const header = testHeader();
    const jsonBytes = Buffer.from(JSON.stringify(header), "utf8");
    const frame = Buffer.alloc(12 + jsonBytes.byteLength + 0);
    frame.set([0x42, 0x45, 0x4c, 0x4c, 1, 3, 0, 0], 0);
    frame.writeUInt32LE(jsonBytes.byteLength, 8);
    frame.set(jsonBytes, 12);
    frame[12] = 0xff; // 破坏首字节 UTF-8
    expect(() => parseChunks([frame])).toThrowError(/invalid_utf8/);
  });

  it("非法 JSON 拒绝", () => {
    const garbage = Buffer.from("{not json", "utf8");
    const frame = Buffer.alloc(12 + garbage.byteLength);
    frame.set([0x42, 0x45, 0x4c, 0x4c, 1, 3, 0, 0], 0);
    frame.writeUInt32LE(garbage.byteLength, 8);
    frame.set(garbage, 12);
    expect(() => parseChunks([frame])).toThrowError(/invalid_json/);
  });

  it("Header Schema 不匹配拒绝", () => {
    const bad = Buffer.from(JSON.stringify({ schemaVersion: 1 }), "utf8");
    const frame = Buffer.alloc(12 + bad.byteLength);
    frame.set([0x42, 0x45, 0x4c, 0x4c, 1, 3, 0, 0], 0);
    frame.writeUInt32LE(bad.byteLength, 8);
    frame.set(bad, 12);
    expect(() => parseChunks([frame])).toThrowError(/invalid_header/);
  });

  it("消息在帧完成前结束 → truncated；之后 reset 可复用", () => {
    const bytes = validFrameBytes();
    const parser = new MediaFrameParser();
    parser.push(bytes.subarray(0, 10));
    expect(() => parser.endMessage()).toThrowError(/truncated/);
    parser.reset();
    parser.push(validFrameBytes());
    const frame = parser.endMessage()[0];
    expect(frame).toBeDefined();
    if (frame !== undefined) {
      expect(frame.header.streamId).toBe(STREAM_ID);
    }
  });

  it("错误信息不包含原始字节内容", () => {
    const bytes = validFrameBytes();
    bytes[0] = 0x00;
    try {
      parseChunks([bytes]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MediaFrameError);
      expect((error as Error).message).not.toContain(STREAM_ID);
    }
  });

  it("非法构造参数抛出 RangeError", () => {
    expect(() => new MediaFrameParser({ maxHeaderBytes: 0 })).toThrow(RangeError);
    expect(() => new MediaFrameParser({ maxPayloadBytes: 0 })).toThrow(RangeError);
  });
});
