import { z } from "zod";
import { UuidSchema } from "../common/ids.js";
import type { MemoryPolicySnapshot } from "./policy.js";

const Count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const MemoryForgetReceiptSchema = z.strictObject({
  requestId: z.string().min(1).max(512),
  targetCount: Count,
  erasedCount: Count,
  protectedSkipped: Count,
  heldSkipped: Count,
});
export type MemoryForgetReceipt = z.infer<typeof MemoryForgetReceiptSchema>;

export const MemoryForgetOperationSchema = z.strictObject({
  sessionId: UuidSchema,
  toolRunId: UuidSchema,
  scopeKey: z.string().regex(/^[a-f0-9]{64}$/),
  preparedDigest: z.string().regex(/^[a-f0-9]{64}$/),
  barrierGeneration: Count,
  state: z.enum(["blocked", "resolved", "retained"]),
  receipt: MemoryForgetReceiptSchema.nullable(),
});
export type MemoryForgetOperation = z.infer<typeof MemoryForgetOperationSchema>;
export interface MemoryForgetTransition {
  readonly operation: MemoryForgetOperation;
  readonly policy: MemoryPolicySnapshot;
}
