import { DecimalStringSchema } from "../common/decimal-string.js";
import { z } from "zod";
import { UuidSchema } from "../common/ids.js";
import { MemoryPolicyStampSchema } from "./policy.js";

const Visibility = z.enum(["included", "unbound", "stale_policy", "tombstone"]);
/** Trusted DB lookup; external Signal/ToolResult JSON never supplies its own authorization. */
export const LocalInputVisibilityRequestSchema = z.strictObject({
  sessionId: UuidSchema,
  policy: MemoryPolicyStampSchema,
  batchRange: z.strictObject({ from: DecimalStringSchema, to: DecimalStringSchema }).optional(),
  signalIds: z.array(UuidSchema).max(164),
  toolRuns: z
    .array(z.strictObject({ toolRunId: UuidSchema, toolName: z.string().min(1).max(128) }))
    .max(8),
});
export const LocalInputVisibilitySchema = z.strictObject({
  /** Present only when a batch range was checked; all its source sequences must be current. */
  aggregatesVisible: z.boolean().optional(),
  signals: z.array(z.strictObject({ signalId: UuidSchema, result: Visibility })).max(164),
  tools: z.array(z.strictObject({ toolRunId: UuidSchema, result: Visibility })).max(8),
});
export type LocalInputVisibilityRequest = z.infer<typeof LocalInputVisibilityRequestSchema>;
export type LocalInputVisibility = z.infer<typeof LocalInputVisibilitySchema>;
