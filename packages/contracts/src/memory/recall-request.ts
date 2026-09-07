import { z } from "zod";
import { UuidSchema } from "../common/ids.js";
import { JsonValueSchema } from "../common/json-value.js";

/** Trusted adapter request preparation. Not evidence of remote receipt or model use. */
export const MemoryRecallRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  attemptId: UuidSchema,
  requestId: z.string().min(1).max(256),
  agentId: z.string().min(1).max(256),
  spaceId: z.string().min(1).max(256),
  body: z.record(z.string(), JsonValueSchema),
});
export type MemoryRecallRequest = z.infer<typeof MemoryRecallRequestSchema>;
