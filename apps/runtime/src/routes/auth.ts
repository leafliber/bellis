import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuthRouteContext } from "./context.js";

/**
 * Auth Exchange 路由（P4 文档 §7.4）。
 *
 * - Startup Token 从请求 Body 或 `Authorization` 头接收，绝不放 URL Query。
 * - Ready 前的业务请求返回稳定 `not_ready`（此时尚未消耗 Token）。
 * - 成功创建/确认本地 Session，设置 HttpOnly、SameSite=Strict、限定
 *   Path 的 Cookie；同一 Token 第二次交换失败。
 * - 过期、未知、错误 Host/Origin 的交换返回统一 `unauthorized`，
 *   不泄露 Token 状态；成功与失败都不记录 Token 原值。
 */

const ExchangeRequestSchema = z.object({
  startupToken: z.string().min(1).max(256).optional(),
});

function tokenFromRequest(request: FastifyRequest, body: unknown): string | null {
  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && authorization.length > 0) {
    const match = /^(?:Bearer|StartupToken)[ \t]+(\S+)$/i.exec(authorization.trim());
    if (match !== null) {
      return match[1] ?? null;
    }
    return null;
  }
  const parsed = ExchangeRequestSchema.safeParse(body);
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
    const body: unknown = request.body;
    const startupToken = tokenFromRequest(request, body);
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
    const session = await ctx.sessions.exchange(startupToken, trace);
    reply.setCookie(ctx.config.sessionCookieName, session.cookieToken, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
    });
    return { sessionId: session.sessionId, createdAtMs: session.createdAtMs };
  });
}
