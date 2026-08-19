import { z } from "zod";
import { UuidSchema } from "../common/ids.js";
import { JsonValueSchema, extensibleJsonObject } from "../common/json-value.js";

/**
 * Outbox Message：Scene Commit 事务内写入、事务提交后分发的消息。
 * 提供至少一次交付，不承诺恰好一次；消费者按 outboxId 或业务幂等键去重。
 * 跨重启调度时间（available_at_ms / lease_until_ms）由 DB Worker 维护，
 * 不进入本 Wire Schema。
 */
export const OutboxMessageSchema = extensibleJsonObject({
  schemaVersion: z.literal(1),
  outboxId: UuidSchema,
  topic: z.string().min(1).max(128),
  partitionKey: z.string().min(1).max(256),
  payload: JsonValueSchema,
  /** Unix epoch milliseconds，仅审计用途。 */
  createdAtMs: z.number().int().nonnegative(),
});

export type OutboxMessage = z.infer<typeof OutboxMessageSchema>;
