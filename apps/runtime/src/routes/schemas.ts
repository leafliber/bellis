import { z } from "zod";

/**
 * REST 边界的唯一 Schema 源：Route Handler 的运行时校验与 OpenAPI 文档
 * 共用同一 Zod 定义，不允许在两处分别维护重复结构。
 * （Auth Exchange 属 Runtime 边界，不在 @bellis/contracts 内。）
 */

export const HealthLiveResponseSchema = z.object({
  status: z.literal("live"),
});

export const HealthReadyResponseSchema = z.object({
  status: z.literal("ready"),
});

export const VersionResponseSchema = z.object({
  version: z.string().min(1).max(64),
  protocol: z.object({
    control: z.literal(1),
    media: z.literal(1),
  }),
  buildInfo: z.object({
    commit: z.string().min(1).max(64).optional(),
    builtAtMs: z.number().int().nonnegative().optional(),
  }),
  runtimeInstanceId: z.string().min(1),
});

/**
 * Auth Exchange 请求：startupToken 缺省时从 Authorization 头读取。
 * `resumeSessionId` 是跨重启重新挂载旧逻辑 Session 的路径（P4 修复 1）：
 * 仅当该 Session 已存在于 P2 时生效；不存在则统一 unauthorized。
 */
export const AuthExchangeRequestSchema = z.object({
  startupToken: z.string().min(1).max(256).optional(),
  resumeSessionId: z.string().uuid().optional(),
});

export const AuthExchangeResponseSchema = z.object({
  sessionId: z.string().uuid(),
  resumed: z.boolean(),
  createdAtMs: z.number().int().nonnegative(),
});
