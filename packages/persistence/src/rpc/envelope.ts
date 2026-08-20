import {
  DecimalStringSchema,
  JsonValueSchema,
  TraceContextSchema,
  UuidSchema,
} from "@bellis/contracts";
import { PERSISTENCE_CHECKPOINTS } from "../checkpoints/observer.js";
import { PERSISTENCE_ERROR_CODES } from "../errors.js";
import { z } from "zod";

/**
 * Worker RPC Envelope（P2 文档 §5.1）。
 * Client 与 Worker 两侧都用这些 Schema 校验；Operation 是闭合集合，
 * 不接受任意方法名，更不存在 SQL 通道。
 */

export const PersistenceRpcRequestSchema = z.object({
  version: z.literal(1),
  requestId: UuidSchema,
  operation: z.string().min(1).max(64),
  deadlineUs: DecimalStringSchema.optional(),
  trace: TraceContextSchema,
  payload: JsonValueSchema,
});
export type PersistenceRpcRequest = z.infer<typeof PersistenceRpcRequestSchema>;

export const SafePersistenceErrorSchema = z.object({
  code: z.enum(PERSISTENCE_ERROR_CODES),
  message: z.string().min(1).max(512),
  retryable: z.boolean(),
});

export const PersistenceRpcResponseSchema = z.object({
  version: z.literal(1),
  requestId: UuidSchema,
  ok: z.boolean(),
  payload: JsonValueSchema.optional(),
  error: SafePersistenceErrorSchema.optional(),
});
export type PersistenceRpcResponse = z.infer<typeof PersistenceRpcResponseSchema>;

/** Worker → Client：检查点通知（到达，等待释放）。 */
export const PersistenceCheckpointNoticeSchema = z.object({
  type: z.literal("persistence_checkpoint"),
  version: z.literal(1),
  requestId: UuidSchema,
  checkpoint: z.enum(PERSISTENCE_CHECKPOINTS),
  context: z.object({
    traceId: z.string().min(1).max(64),
    sceneId: z.string().min(1).max(64).optional(),
    outboxId: z.string().min(1).max(64).optional(),
  }),
});
export type PersistenceCheckpointNotice = z.infer<typeof PersistenceCheckpointNoticeSchema>;

/** Client → Worker：检查点释放（继续或中止回滚）。 */
export const PersistenceCheckpointReleaseSchema = z.object({
  type: z.literal("persistence_checkpoint_release"),
  version: z.literal(1),
  requestId: UuidSchema,
  proceed: z.boolean(),
});
export type PersistenceCheckpointRelease = z.infer<typeof PersistenceCheckpointReleaseSchema>;

export function isRpcResponse(value: unknown): value is PersistenceRpcResponse {
  return PersistenceRpcResponseSchema.safeParse(value).success;
}

export function isCheckpointNotice(value: unknown): value is PersistenceCheckpointNotice {
  return PersistenceCheckpointNoticeSchema.safeParse(value).success;
}

export function isCheckpointRelease(value: unknown): value is PersistenceCheckpointRelease {
  return PersistenceCheckpointReleaseSchema.safeParse(value).success;
}
