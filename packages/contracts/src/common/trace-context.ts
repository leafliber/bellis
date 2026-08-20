import { z } from "zod";
import { SpanIdSchema, TraceIdSchema, UuidSchema } from "./ids.js";
import { extensibleJsonObject } from "./json-value.js";

/**
 * 跨边界传播的统一 Trace 上下文（phase-1-build-guide.md §10.1）。
 * 业务标识（sessionId/turnId/cycleId/sceneId/cueId/toolRunId）按需携带；
 * spanId 是可选传播字段，不替代业务 ID。
 */
export const TraceContextSchema = extensibleJsonObject({
  traceId: TraceIdSchema,
  spanId: SpanIdSchema.optional(),
  sessionId: UuidSchema.optional(),
  turnId: UuidSchema.optional(),
  cycleId: UuidSchema.optional(),
  sceneId: UuidSchema.optional(),
  cueId: UuidSchema.optional(),
  toolRunId: UuidSchema.optional(),
});

export type TraceContext = z.infer<typeof TraceContextSchema>;
