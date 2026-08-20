import { describe, expect, it } from "vitest";
import {
  MEDIA_FRAME_PREFIX_BYTES,
  MEDIA_FRAME_PROTOCOL_VERSION,
  MEDIA_MAGIC,
  MediaFrameError,
  encodeMediaFrame,
  mediaKindFromCode,
  mediaKindToCode,
} from "../../src/index.js";
import type { MediaFrameHeader } from "@bellis/contracts";
import { FRAME_ID_A, SESSION_ID, STREAM_ID, TRACE_ID } from "../helpers.js";

export function testHeader(overrides: Partial<MediaFrameHeader> = {}): MediaFrameHeader {
  const header: MediaFrameHeader = {
    schemaVersion: 1,
    streamId: STREAM_ID,
    frameId: FRAME_ID_A,
    sessionId: SESSION_ID,
    sequence: "0",
    contentType: "application/octet-stream",
    traceId: TRACE_ID,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      header[key as keyof MediaFrameHeader] = value as MediaFrameHeader[keyof MediaFrameHeader];
    }
  }
  return header;
}

function readLe32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)
  );
}

function readLe16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

describe("encodeMediaFrame", () => {
  it("严格按冻结布局编码（magic/version/kind/flags/headerLen 全部小端）", () => {
    const payload = Uint8Array.from([1, 2, 3]);
    const frame = encodeMediaFrame({ header: testHeader(), payload, mediaKind: "binary-test" });
    const headerLength = readLe32(frame, 8);
    expect(frame.byteLength).toBe(MEDIA_FRAME_PREFIX_BYTES + headerLength + 3);
    expect([...frame.subarray(0, 4)]).toEqual([...MEDIA_MAGIC]);
    expect(frame[4]).toBe(MEDIA_FRAME_PROTOCOL_VERSION);
    expect(frame[5]).toBe(mediaKindToCode("binary-test"));
    expect(readLe16(frame, 6)).toBe(0);
    const headerJson = JSON.parse(
      Buffer.from(
        frame.subarray(MEDIA_FRAME_PREFIX_BYTES, MEDIA_FRAME_PREFIX_BYTES + headerLength),
      ).toString("utf8"),
    );
    expect(headerJson.streamId).toBe(STREAM_ID);
    expect([...frame.subarray(frame.byteLength - 3)]).toEqual([1, 2, 3]);
  });

  it("kind 字节映射 audio=1 / viseme=2 / binary-test=3", () => {
    expect(mediaKindToCode("audio")).toBe(1);
    expect(mediaKindToCode("viseme")).toBe(2);
    expect(mediaKindToCode("binary-test")).toBe(3);
    expect(mediaKindFromCode(1)).toBe("audio");
    expect(mediaKindFromCode(3)).toBe("binary-test");
    expect(mediaKindFromCode(0)).toBeNull();
    expect(mediaKindFromCode(4)).toBeNull();
    for (const kind of ["audio", "viseme", "binary-test"] as const) {
      const frame = encodeMediaFrame({
        header: testHeader(),
        payload: new Uint8Array(0),
        mediaKind: kind,
      });
      expect(mediaKindFromCode(frame[5] ?? 0)).toBe(kind);
    }
  });

  it("Header 非法 → MediaFrameError(invalid_header)", () => {
    expect(() =>
      encodeMediaFrame({
        header: testHeader({ sequence: "not-decimal" }),
        payload: new Uint8Array(0),
        mediaKind: "binary-test",
      }),
    ).toThrow(MediaFrameError);
    expect(() =>
      encodeMediaFrame({
        header: { schemaVersion: 2 } as unknown as MediaFrameHeader,
        payload: new Uint8Array(0),
        mediaKind: "binary-test",
      }),
    ).toThrow(MediaFrameError);
  });

  it("Header/Payload 超限 → 稳定错误", () => {
    // 合法但体积大的 Header（扩展键以填充字符放大编码体积）。
    const bigHeader = testHeader();
    (bigHeader as Record<string, unknown>).padding = "x".repeat(200);
    expect(() =>
      encodeMediaFrame(
        { header: bigHeader, payload: new Uint8Array(0), mediaKind: "binary-test" },
        { maxHeaderBytes: 16 },
      ),
    ).toThrowError(/header_too_large/);
    expect(() =>
      encodeMediaFrame(
        { header: testHeader(), payload: new Uint8Array(4), mediaKind: "binary-test" },
        { maxPayloadBytes: 2 },
      ),
    ).toThrowError(/payload_too_large/);
  });
});
