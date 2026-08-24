import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AuthExchangeRequestSchema, AuthExchangeResponseSchema } from "./schemas.js";
import type { AuthRouteContext } from "./context.js";

/**
 * Auth Exchange 路由（docs/phase-1-reference.md）。
 *
 * - Startup Token 从请求 Body 或 `Authorization` 头接收，绝不放 URL Query。
 * - Ready 前的业务请求返回稳定 `not_ready`（此时尚未消耗 Token）。
 * - 成功创建/挂载本地 Session，设置 HttpOnly、SameSite=Strict、限定
 *   Path 的 Cookie；同一 Token 第二次交换失败。
 * - `resumeSessionId`（可选）：跨重启重新挂载旧逻辑 Session（P4 修复 1）；
 *   目标不存在时与其它失败统一 `unauthorized`。
 * - 请求/响应 Schema 与 OpenAPI 共用 schemas.ts 单一来源。
 */

function tokenFromRequest(request: FastifyRequest, body: unknown): string | null {
  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && authorization.length > 0) {
    const match = /^(?:Bearer|StartupToken)[ \t]+(\S+)$/i.exec(authorization.trim());
    if (match !== null) {
      return match[1] ?? null;
    }
    return null;
  }
  const parsed = AuthExchangeRequestSchema.safeParse(body);
  if (parsed.success && typeof parsed.data.startupToken === "string") {
    return parsed.data.startupToken;
  }
  return null;
}

export function registerAuthRoute(app: FastifyInstance, ctx: AuthRouteContext): void {
  app.post("/api/v1/auth/exchange", async (request, reply: FastifyReply) => {
    if (!ctx.status.ready) {
      await reply.code(503).send({
        code: "not_ready",
        message: "runtime is not ready",
        retryable: true,
        traceId: ctx.requestTraces.get(request).traceId,
      });
      return reply;
    }
    const parsed = AuthExchangeRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      await reply.code(400).send({
        code: "invalid_message",
        message: "request body failed schema validation",
        retryable: false,
        traceId: ctx.requestTraces.get(request).traceId,
      });
      return reply;
    }
    const startupToken = tokenFromRequest(request, parsed.success ? parsed.data : {}) ?? null;
    if (startupToken === null) {
      await reply.code(400).send({
        code: "invalid_message",
        message: "startup token is required in the request body or authorization header",
        retryable: false,
        traceId: ctx.requestTraces.get(request).traceId,
      });
      return reply;
    }
    const trace = ctx.requestTraces.get(request);
    const session = await ctx.sessions.exchange(startupToken, trace, parsed.data.resumeSessionId);
    reply.setCookie(ctx.config.sessionCookieName, session.cookieToken, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
    });
    return AuthExchangeResponseSchema.parse({
      sessionId: session.sessionId,
      resumed: session.resumed,
      createdAtMs: session.createdAtMs,
    });
  });
}
