import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { formatDecimalString } from "@bellis/contracts";
import { MediaFrameParser, encodeMediaFrame, mediaKindToCode } from "../../src/index.js";
import type { MediaKindName } from "../../src/index.js";
import type { MediaFrameHeader } from "@bellis/contracts";
import { FRAME_ID_A, SESSION_ID, STREAM_ID, TRACE_ID } from "../helpers.js";

/**
 * 性质测试（docs/reference/phase-1.md）：
 * - 任意合法 Media Frame 编码再解析保持等价。
 * - 任意分片组合产生相同帧。
 * - 首字节损坏总是产生相同的稳定错误（bad_magic + failed 状态）。
 */

const uuidArb = fc.uuid();

const headerArb: fc.Arbitrary<MediaFrameHeader> = fc
  .record({
    frameId: uuidArb,
    sequence: fc.bigInt({ min: 0n, max: 10n ** 15n }).map((value) => formatDecimalString(value)),
    contentType: fc.constantFrom("application/octet-stream", "audio/pcm", "video/viseme-json"),
    withSceneId: fc.boolean(),
    withTarget: fc.boolean(),
    targetTimeUs: fc.bigInt({ min: 0n, max: 10n ** 15n }),
  })
  .map((fields) => {
    const header: Record<string, unknown> = {
      schemaVersion: 1,
      streamId: STREAM_ID,
      frameId: fields.frameId,
      sessionId: SESSION_ID,
      sequence: fields.sequence,
      contentType: fields.contentType,
      traceId: TRACE_ID,
    };
    if (fields.withSceneId) {
      header.sceneId = FRAME_ID_A;
    }
    if (fields.withTarget) {
      header.targetTimeUs = formatDecimalString(fields.targetTimeUs);
    }
    return header as unknown as MediaFrameHeader;
  });

const frameArb = fc
  .record({
    header: headerArb,
    mediaKind: fc.constantFrom<"audio" | "viseme" | "binary-test">(
      "audio",
      "viseme",
      "binary-test",
    ),
    payloadLength: fc.integer({ min: 0, max: 256 }),
    seed: fc.integer({ min: 0, max: 2 ** 30 }),
  })
  .map((fields) => {
    const payload = new Uint8Array(fields.payloadLength);
    let state = fields.seed;
    for (let index = 0; index < payload.length; index += 1) {
      state = (state * 48271) % (2 ** 31 - 1);
      payload[index] = state % 256;
    }
    return { header: fields.header, payload, mediaKind: fields.mediaKind as MediaKindName };
  });

/** 任意把字节切成非空分片。 */
const chunkingArb = fc.array(fc.integer({ min: 1, max: 32 }), { minLength: 0, maxLength: 64 });

function applyChunking(bytes: Uint8Array, sizes: number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let index = 0;
  while (offset < bytes.byteLength) {
    const size = sizes[index] ?? 1;
    chunks.push(bytes.subarray(offset, Math.min(offset + size, bytes.byteLength)));
    offset += size;
    index += 1;
  }
  return chunks;
}

describe("性质：Media Frame 编解码", () => {
  it("任意合法帧 + 任意分片：解析结果与原帧深度等价", () => {
    fc.assert(
      fc.property(frameArb, chunkingArb, (frame, chunking) => {
        const bytes = encodeMediaFrame(frame);
        const parser = new MediaFrameParser();
        for (const chunk of applyChunking(bytes, chunking)) {
          parser.push(chunk);
        }
        const parsed = parser.endMessage();
        expect(parsed.length).toBe(1);
        const result = parsed[0];
        expect(result).toBeDefined();
        if (result === undefined) {
          return;
        }
        expect(result.header).toEqual(frame.header);
        expect([...result.payload]).toEqual([...frame.payload]);
        expect(result.mediaKind).toBe(frame.mediaKind);
      }),
      { numRuns: 250 },
    );
  });

  it("任意帧首字节损坏：稳定 bad_magic 错误 + failed 状态（含任意后续输入）", () => {
    fc.assert(
      fc.property(frameArb, chunkingArb, (frame, chunking) => {
        const bytes = encodeMediaFrame(frame);
        bytes[0] = (bytes[0] ?? 0x42) ^ 0xff;
        const parser = new MediaFrameParser();
        const chunks = applyChunking(bytes, chunking);
        if (chunks.length > 0) {
          expect(() => parser.push(chunks[0] as Uint8Array)).toThrowError(/bad_magic/);
        }
        expect(parser.failed).toBe(true);
        for (const chunk of chunks.slice(1)) {
          expect(() => parser.push(chunk)).toThrowError(/parser_failed/);
        }
      }),
      { numRuns: 150 },
    );
  });

  it("media kind 字节编码确定性：同名 kind 总是同一字节，未知字节解析不出", () => {
    fc.assert(
      fc.property(frameArb, (frame) => {
        const bytes = encodeMediaFrame(frame);
        expect(bytes[5]).toBe(mediaKindToCode(frame.mediaKind));
      }),
      { numRuns: 100 },
    );
  });
});
