import { z } from "zod";
import { DecimalStringSchema } from "../common/decimal-string.js";
import { UuidSchema } from "../common/ids.js";
import { SignalSchema } from "./signal.js";

/**
 * 弹幕批次（architecture-plan.md §6.2）。
 * 水位使用非负十进制字符串，禁止 JSON number 以避免精度丢失；
 * Batcher 只整理事实并保留原始 Signal 游标，不代替 LLM 做角色决策。
 *
 * watermarkFrom ≤ watermarkTo 属于生产者不变量，由产生批次的组件在
 * bigint 域保证（P2 持久化层校验），不作为跨校验器的 Schema 约束，
 * 以保持 Zod 与 JSON Schema 双 dialect 的语义一致（ADR 0001 §4）。
 */
export const AudienceMessageSchema = z.looseObject({
  signalId: UuidSchema,
  userId: z.string().min(1).max(128),
  text: z.string().min(1).max(2000),
  /** 相同内容语义聚类后的权重，0–1。 */
  weight: z.number().min(0).max(1).optional(),
});

export const AudienceTopicSchema = z.looseObject({
  label: z.string().min(1).max(128),
  count: z.number().int().nonnegative(),
  participants: z.number().int().nonnegative(),
  examples: z.array(z.string().min(1).max(2000)).max(10),
});

export const AudienceBatchSchema = z.looseObject({
  schemaVersion: z.literal(1),
  id: UuidSchema,
  watermarkFrom: DecimalStringSchema,
  watermarkTo: DecimalStringSchema,
  highlights: z.array(AudienceMessageSchema).max(100),
  topics: z.array(AudienceTopicSchema).max(32),
  urgentSignals: z.array(SignalSchema).max(64),
  tokenEstimate: z.number().int().nonnegative(),
});

export type AudienceMessage = z.infer<typeof AudienceMessageSchema>;
export type AudienceTopic = z.infer<typeof AudienceTopicSchema>;
export type AudienceBatch = z.infer<typeof AudienceBatchSchema>;
