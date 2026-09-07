import { z } from "zod";
import { MemoryRecallRequestSchema, type MemoryRecallRequest } from "./recall-request.js";

// Identity uniqueness is an application binding check, separate from structural
// JSON Schema validation (which cannot express uniqueness of one object field).
export const MemoryRecallVerificationRequestsSchema = z
  .array(MemoryRecallRequestSchema)
  .min(1)
  .max(16);
export const MemoryRecallVerificationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  checkedAt: z.string().regex(z.regexes.datetime({ offset: true })),
  results: z
    .array(
      z.strictObject({
        requestId: z.string().min(1).max(256),
        status: z.enum(["valid", "unavailable"]),
      }),
    )
    .min(1)
    .max(16),
});
export type MemoryRecallVerification = z.infer<typeof MemoryRecallVerificationSchema>;

/** Maintenance port, independent of a stopped or history-blocked MemoryProvider. */
export interface MemoryRecallVerifier {
  readonly id: string;
  verify(
    requests: readonly MemoryRecallRequest[],
    signal: AbortSignal,
  ): Promise<MemoryRecallVerification>;
}
