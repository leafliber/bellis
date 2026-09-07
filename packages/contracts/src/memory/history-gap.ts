import { z } from "zod";
import { DecimalStringSchema } from "../common/decimal-string.js";

/** Trusted lifecycle notification. Never accepted from a model or Stage. */
export const MemoryHistoryGapSchema = z.strictObject({
  schemaVersion: z.literal(1),
  providerId: z.string().min(1).max(128),
  agentId: z.string().min(1).max(256),
  gapId: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.enum(["history_unavailable", "checkpoint_missing"]),
  cursor: DecimalStringSchema,
  eventId: z
    .string()
    .regex(/^[!-~]{1,512}$/)
    .optional(),
});
export type MemoryHistoryGap = z.infer<typeof MemoryHistoryGapSchema>;
