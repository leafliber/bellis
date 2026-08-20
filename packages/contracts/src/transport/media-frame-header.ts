import { z } from "zod";
import { DecimalStringSchema } from "../common/decimal-string.js";
import { TraceIdSchema, UuidSchema } from "../common/ids.js";
import { extensibleJsonObject } from "../common/json-value.js";

/**
 * Binary Media WebSocket 的 JSON Header（phase-1-build-guide.md §8.4）。
 * 二进制帧布局：magic "BELL" + version 1 + media kind + flags(LE16)
 * + header length(LE32) + UTF-8 JSON header + payload。
 * 解析与编码由 @bellis/transport（P1）实现；本 Schema 约束 Header 语义。
 */
export const MediaFrameHeaderSchema = extensibleJsonObject({
  schemaVersion: z.literal(1),
  streamId: UuidSchema,
  frameId: UuidSchema,
  sessionId: UuidSchema,
  sceneId: UuidSchema.optional(),
  cueId: UuidSchema.optional(),
  /** Stream 内帧序号：非负十进制字符串，乱序与重复帧会被拒绝。 */
  sequence: DecimalStringSchema,
  targetTimeUs: DecimalStringSchema.optional(),
  durationUs: DecimalStringSchema.optional(),
  contentType: z.string().min(1).max(128),
  traceId: TraceIdSchema,
});

export type MediaFrameHeader = z.infer<typeof MediaFrameHeaderSchema>;
