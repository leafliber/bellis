import type { FastifyInstance } from "fastify";
import { createTraceContext } from "@bellis/observability";
import { HealthLiveResponseSchema, HealthReadyResponseSchema } from "./schemas.js";
import type { RouteContext } from "./context.js";

/**
 * Health 路由（docs/phase-1-reference.md）。
 *
 * - `live` 只证明进程可响应：不访问数据库、不执行昂贵检查。
 * - `ready` 只在 Migration、DB Worker、恢复与协议注册完成后返回 200；
 *   未完成或 Draining 返回 503 + 安全 `not_ready`。
 * - 两者都不返回数据库路径、异常 Stack 或内部拓扑。
 * - 响应结构经共享 Schema（schemas.ts）运行时校验，与 OpenAPI 同源。
 */
export function registerHealthRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get("/api/v1/health/live", async () => {
    return HealthLiveResponseSchema.parse({ status: "live" });
  });

  app.get("/api/v1/health/ready", async (_request, reply) => {
    if (ctx.status.ready) {
      return HealthReadyResponseSchema.parse({ status: "ready" });
    }
    await reply.code(503).send({
      code: "not_ready",
      message: "runtime is not ready",
      retryable: true,
      traceId: createTraceContext().traceId,
    });
    return reply;
  });
}
