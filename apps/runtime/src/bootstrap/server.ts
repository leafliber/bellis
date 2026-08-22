import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import fastify from "fastify";
import type { MonotonicClock } from "@bellis/contracts";
import type { PersistenceClient } from "@bellis/persistence";
import type { LoggerPort, MetricsPort } from "@bellis/observability";
import { ApplicationError } from "../errors/mapping.js";
import { registerAuthRoute } from "../routes/auth.js";
import type { OriginAllowlist, RequestTraceStore } from "../routes/context.js";
import { registerHealthRoutes } from "../routes/health.js";
import { registerOpenApiRoute } from "../routes/openapi.js";
import { registerVersionRoute } from "../routes/version.js";
import type { LocalSessionService } from "../auth/local-session.js";
import type { RuntimeStatus } from "./lifecycle.js";
import type { RuntimeConfig } from "./config.js";
import { normalizeHostHeader } from "./config.js";
import type { ConnectionMetrics } from "../websocket/connection-metrics.js";
import { ControlConnection } from "../websocket/control-adapter.js";
import { MediaConnection } from "../websocket/media-adapter.js";
import type { LogicalSession } from "../websocket/session-store.js";

/**
 * Fastify 装配（P4 文档 §6/§7/§9/§10）：只承担 Host/Origin/Session/Schema
 * 边界、协议转换、调用 Application Service 与响应映射；领域事务顺序
 * 全部在 application/**。
 */

export interface ServerContext {
  readonly config: RuntimeConfig;
  readonly logger: LoggerPort;
  readonly metrics: MetricsPort;
  readonly status: RuntimeStatus;
  readonly instanceId: string;
  readonly clock: MonotonicClock;
  readonly persistence: PersistenceClient;
  readonly sessions: LocalSessionService;
  readonly origins: OriginAllowlist;
  readonly requestTraces: RequestTraceStore;
  readonly connections: ConnectionMetrics;
}

const UNAUTHORIZED_CLOSE = 1008;
const NOT_READY_CLOSE = 1013;

export async function buildServer(ctx: ServerContext): Promise<FastifyInstance> {
  const maxWsPayload =
    12 + ctx.config.limits.maxMediaHeaderBytes + ctx.config.limits.maxMediaPayloadBytes;
  const app = fastify({
    logger: false,
    forceCloseConnections: true,
    bodyLimit: 65_536,
  });

  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: maxWsPayload } });

  const allowedHosts = new Set<string>(ctx.config.allowedHosts);

  // Host / Origin 边界：REST 与 WS Upgrade 一律执行（P4 文档 §8）。
  // 注意：放行路径必须返回 undefined（未发送响应时返回 reply 会让
  // Fastify 等待一个永远不会发生的发送）。
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    ctx.requestTraces.capture(request);
    const hostHeader = request.headers.host;
    const hostname = typeof hostHeader === "string" ? normalizeHostHeader(hostHeader) : null;
    if (hostname === null || !allowedHosts.has(hostname)) {
      await reply.code(403).send({
        code: "unauthorized",
        message: "host is not allowed",
        retryable: false,
        traceId: ctx.requestTraces.get(request).traceId,
      });
      return reply;
    }
    const origin = request.headers.origin;
    if (origin === undefined) {
      if (!ctx.config.allowMissingOrigin) {
        await reply.code(403).send({
          code: "unauthorized",
          message: "origin header is required",
          retryable: false,
          traceId: ctx.requestTraces.get(request).traceId,
        });
        return reply;
      }
      return;
    }
    if (typeof origin !== "string" || !ctx.origins.allows(origin)) {
      await reply.code(403).send({
        code: "unauthorized",
        message: "origin is not allowed",
        retryable: false,
        traceId: ctx.requestTraces.get(request).traceId,
      });
      return reply;
    }
    return;
  });

  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const traceId = ctx.requestTraces.get(request).traceId;
    if (reply.sent) {
      ctx.logger.log("warn", "runtime_request_error_after_sent", {
        traceId,
        error: error instanceof Error ? error.message : "unknown",
      });
      return;
    }
    if (error instanceof ApplicationError) {
      void reply.code(error.status).send({
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        traceId,
      });
      return;
    }
    const fastifyStatus =
      typeof error === "object" && error !== null && "statusCode" in error
        ? Number((error as { statusCode: unknown }).statusCode)
        : Number.NaN;
    if (Number.isInteger(fastifyStatus) && fastifyStatus >= 400 && fastifyStatus < 500) {
      // Fastify 边界错误（JSON 解析、body 限制等）：客户端可修复输入。
      ctx.logger.log("info", "runtime_request_boundary_rejected", {
        traceId,
        status: fastifyStatus,
      });
      void reply.code(fastifyStatus).send({
        code: "invalid_message",
        message: "request failed boundary validation",
        retryable: false,
        traceId,
      });
      return;
    }
    ctx.logger.log("warn", "runtime_request_failed", {
      traceId,
      error: error instanceof Error ? error.message : "unknown",
    });
    void reply.code(500).send({
      code: "internal_error",
      message: "internal runtime error",
      retryable: false,
      traceId,
    });
  });

  app.setNotFoundHandler(async (request: FastifyRequest, reply: FastifyReply) => {
    await reply.code(404).send({
      code: "invalid_message",
      message: "unknown route",
      retryable: false,
      traceId: ctx.requestTraces.get(request).traceId,
    });
    return reply;
  });

  const baseRoutes = {
    config: ctx.config,
    logger: ctx.logger,
    status: ctx.status,
    instanceId: ctx.instanceId,
    origins: ctx.origins,
    requestTraces: ctx.requestTraces,
  };
  registerHealthRoutes(app, baseRoutes);
  registerVersionRoute(app, baseRoutes);
  registerOpenApiRoute(app, baseRoutes);
  registerAuthRoute(app, { ...baseRoutes, sessions: ctx.sessions });

  registerWebSocketRoutes(app, ctx);
  return app;
}

function resolveWsSession(ctx: ServerContext, request: FastifyRequest): LogicalSession | null {
  const cookieToken = request.cookies[ctx.config.sessionCookieName];
  return ctx.sessions.store.resolveByCookie(cookieToken);
}

function registerWebSocketRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get("/ws/v1/control", { websocket: true }, (socket, request) => {
    if (!ctx.status.ready) {
      socket.close(NOT_READY_CLOSE, "not_ready");
      return;
    }
    const logical = resolveWsSession(ctx, request);
    if (logical === null) {
      socket.close(UNAUTHORIZED_CLOSE, "unauthorized");
      return;
    }
    if (logical.control !== null) {
      socket.close(UNAUTHORIZED_CLOSE, "session already has a control connection");
      return;
    }
    const connection = new ControlConnection({
      socket,
      logical,
      runtimeVersion: ctx.config.runtimeVersion,
      clock: ctx.clock,
      logger: ctx.logger,
      metrics: ctx.metrics,
      connections: ctx.connections,
      persistence: ctx.persistence,
      limits: {
        heartbeatIntervalMs: ctx.config.limits.heartbeatIntervalMs,
        helloTimeoutMs: ctx.config.limits.helloTimeoutMs,
        replayWindowCapacity: ctx.config.limits.replayWindowCapacity,
        dedupCapacity: ctx.config.limits.dedupCapacity,
        maxControlTextBytes: ctx.config.limits.maxControlTextBytes,
        sendQueueMaxMessages: ctx.config.limits.sendQueue.maxMessages,
        sendQueueMaxBytes: ctx.config.limits.sendQueue.maxBytes,
      },
    });
    connection.start();
  });

  app.get("/ws/v1/media", { websocket: true }, (socket, request) => {
    if (!ctx.status.ready) {
      socket.close(NOT_READY_CLOSE, "not_ready");
      return;
    }
    const logical = resolveWsSession(ctx, request);
    if (logical === null) {
      socket.close(UNAUTHORIZED_CLOSE, "unauthorized");
      return;
    }
    const connection = new MediaConnection({
      socket,
      logical,
      clock: ctx.clock,
      logger: ctx.logger,
      connections: ctx.connections,
      limits: {
        maxHeaderBytes: ctx.config.limits.maxMediaHeaderBytes,
        maxPayloadBytes: ctx.config.limits.maxMediaPayloadBytes,
      },
    });
    connection.start();
  });
}
