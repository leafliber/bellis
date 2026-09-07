import { z } from "zod";
import { UuidSchema } from "../common/ids.js";
import { JsonValueSchema } from "../common/json-value.js";
import { DecimalStringSchema } from "../common/decimal-string.js";
import { MemoryPolicyStampSchema } from "../memory/policy.js";

/** Trusted adapter output; never parsed as a model ToolCall or accepted from Stage. */
export const PreparedToolCallSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sessionId: UuidSchema,
  turnId: UuidSchema,
  cycleId: UuidSchema,
  toolRunId: UuidSchema,
  toolName: z.string().min(1).max(128),
  toolVersion: z.number().int().min(1),
  originalCallDigest: z.string().regex(/^[a-f0-9]{64}$/),
  providerId: z.string().min(1).max(128),
  /** Effective business key, owned by the trusted adapter rather than the model. */
  idempotencyKey: z.string().min(1).max(128).nullable(),
  request: JsonValueSchema,
  /** User-reviewable description of the actual operation, without credentials. */
  confirmation: JsonValueSchema,
  policy: MemoryPolicyStampSchema.optional(),
  resources: z
    .array(
      z.strictObject({
        ref: z.string().min(1).max(1024),
        revision: DecimalStringSchema,
      }),
    )
    .max(256),
});
export type PreparedToolCall = z.infer<typeof PreparedToolCallSchema>;
