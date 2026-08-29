import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthRouteContext } from "./context.js";
import type { Phase3DecisionHost } from "../application/phase-3/host.js";

/**
 * Phase 3 开发信号输入路由（phase-3-development-guide.md §6.1/§9.2）。
 *
 * - 只在显式 phase3 开发配置启用时注册（生产默认不装配）；
 * - 输入仍是普通 JSON：Route 只做边界校验与转发，Signal 校验、
 *   优先级分类、去重与水位分配全部在 SignalPipeline；
 * - 鉴权沿用本地 Session（Exchange 后的 HttpOnly Cookie）；
 * - Route 不推进 Turn、不触发模型（不变量 12）。
 */
export function registerPhase3SignalRoutes(
  app: FastifyInstance,
  ctx: AuthRouteContext & { readonly phase3: Phase3DecisionHost },
): void {
  app.post("/api/v1/phase3/signals", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.status.ready) {
      await reply.code(503).send({
        code: "not_ready",
        message: "runtime is not ready",
        retryable: true,
        traceId: ctx.requestTraces.get(request).traceId,
      });
      return;
    }
    const cookieToken = request.cookies[ctx.config.sessionCookieName];
    const session = ctx.sessions.store.resolveByCookie(cookieToken);
    if (session === null) {
      await reply.code(401).send({
        code: "unauthorized",
        message: "valid local session required",
        retryable: false,
        traceId: ctx.requestTraces.get(request).traceId,
      });
      return;
    }
    const result = await ctx.phase3.ingest(request.body);
    await reply.code(200).send({
      result: result.result,
      ...(result.result === "rejected"
        ? { reason: result.reason }
        : { sequence: result.sequence.toString(10) }),
      ...(result.result === "accepted" || result.result === "deduplicated"
        ? { priorityClass: result.priorityClass }
        : {}),
    });
  });
}
