import { z } from "zod";
import { UuidSchema } from "../common/ids.js";
import { JsonValueSchema, extensibleJsonObject } from "../common/json-value.js";

/**
 * Tool Run 的跨包共享形态（phase-3-development-guide.md §8）。
 *
 * 本文件只放跨包 / 持久化 / 审计需要的对象：
 * - 执行模式与语义：Registry 注册期声明、Scheduler 与恢复逻辑共享；
 * - ToolResult：Tool Runtime 产出、进入下一 Cycle 与 Session Record；
 * - ToolRunState：持久化状态（含恢复专用的 uncertain——非幂等 Tool
 *   崩溃后无法证明结果，绝不自动重试）。
 * ToolDefinition 完整形态留在 @bellis/tool-runtime（注册期校验），
 * 不冻结为公共协议。
 */

/** 执行模式：无依赖只读并行 / 同资源互斥 / 同归一化键串行 / 后台不阻塞。 */
export const ToolExecutionModeSchema = z.enum([
  "parallel_read",
  "exclusive",
  "keyed",
  "background",
]);

/** 副作用语义：pure 可缓存可重放；idempotent 可显式恢复；non_idempotent 崩溃后 uncertain。 */
export const ToolSemanticSchema = z.enum(["pure", "idempotent", "non_idempotent"]);

/** 持久化 Tool Run 状态；uncertain 仅出现在恢复投影。 */
export const ToolRunStateSchema = z.enum([
  "planned",
  "running",
  "succeeded",
  "failed",
  "timeout",
  "cancelled",
  "denied",
  "dependency_failed",
  "uncertain",
]);

/** 缓存命中来源：L0 单 Cycle Map、L1 Runtime LRU、L2 SQLite TTL。 */
export const ToolCacheSourceSchema = z.enum(["l0", "l1", "l2"]);

/** Tool 执行的可观察终态（uncertain 不是执行结果，只是恢复投影）。 */
export const ToolOutcomeSchema = z.enum([
  "succeeded",
  "failed",
  "dependency_failed",
  "timeout",
  "cancelled",
  "denied",
]);

/**
 * ToolResult：一次 Tool Run 的有界、JSON-safe 结果。
 * - value 超限时以 truncated=true 的结构化截断形态进入模型，
 *   原始大结果不写入 Session Record（§8.5）；
 * - cacheSource 命中缓存时仍生成 Tool Run 审计事实并标记来源。
 */
export const ToolResultSchema = extensibleJsonObject({
  schemaVersion: z.literal(1),
  toolRunId: UuidSchema,
  toolName: z.string().min(1).max(128),
  outcome: ToolOutcomeSchema,
  value: JsonValueSchema.optional(),
  errorCode: z.string().min(1).max(64).optional(),
  truncated: z.boolean(),
  cacheSource: ToolCacheSourceSchema.optional(),
});

export type ToolExecutionMode = z.infer<typeof ToolExecutionModeSchema>;
export type ToolSemantic = z.infer<typeof ToolSemanticSchema>;
export type ToolRunState = z.infer<typeof ToolRunStateSchema>;
export type ToolCacheSource = z.infer<typeof ToolCacheSourceSchema>;
export type ToolOutcome = z.infer<typeof ToolOutcomeSchema>;
export type ToolResult = z.infer<typeof ToolResultSchema>;
