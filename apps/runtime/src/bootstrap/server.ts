import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import fastify from "fastify";
import type { MonotonicClock } from "@bellis/contracts";
import type { PersistenceClient } from "@bellis/persistence";
import type { LoggerPort, MetricsPort } from "@bellis/observability";
import { mapErrorToEnvelope, toErrorEnvelopeJson } from "../errors/mapping.js";
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
import type { ControlResumePlan } from "../websocket/control-adapter.js";
import type { LogicalSession } from "../websocket/session-store.js";

/**
 * Fastify 装配（P4 文档 §6/§7/§9/§10）：只承担 Host/Origin/Session/Schema
 * 边界、协议转换、调用 Application Service 与响应映射；领域事务顺序
 * 全部在 application/**。
 *
 * Control Upgrade 的 resume 加载（P4 修复 1）：同进程导出状态优先；
 * `restorable` Session（resumeSessionId 挂载）从 P2 latestServerSeq 构造
 * resume，跨重启不复用 Seq。加载期间同步挂接缓冲收集器，不丢入站消息。
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
  // WS 层总 maxPayload 必须同时覆盖 Media 帧上限与 Control 文本上限
  // （二轮评审修复 7）：若可配置的 maxControlTextBytes 大于 Media 组合
  // 上限，配置宣称允许的 Control 消息会先被 WS 层以 1009 拒绝。
  const maxWsPayload = Math.max(
    ctx.config.limits.maxControlTextBytes,
    12 + ctx.config.limits.maxMediaHeaderBytes + ctx.config.limits.maxMediaPayloadBytes,
  );
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
    // Fastify 自身 4xx（JSON 解析、body 限制等）：客户端可修复输入。
    const fastifyStatus =
      typeof error === "object" && error !== null && "statusCode" in error
        ? Number((error as { statusCode: unknown }).statusCode)
        : Number.NaN;
    if (Number.isInteger(fastifyStatus) && fastifyStatus >= 400 && fastifyStatus < 500) {
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
    // 集中错误映射（P4 修复 9）：Application/Zod/Persistence/未知错误统一
    // 折叠为 ErrorEnvelope（database_busy → backpressure/503 等），
    // 原始错误保留在本地日志。
    const mapped = mapErrorToEnvelope(error, traceId, ctx.logger);
    void reply.code(mapped.status).send(toErrorEnvelopeJson(mapped, traceId));
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

/**
 * 解析 Control 连接的 resume 与预加载恢复状态（P4 修复 1/3 +
 * 二轮评审修复 3）：
 * - 同进程导出状态优先（完整 Replay 内容）；
 * - `restorable` Session 从 P2 latestServerSeq 构造跨重启 resume
 *   （Replay 内容不持久化，缺口走 Snapshot）；
 * - 新建 Session 无需 resume，也不会有 Replay Gap。
 *
 * 恢复读取失败必须**抛错**（调用方以 1011 失败关闭连接）：跨重启吞错
 * 会退化为全新 Seq（复用已持久化 Seq），进程内吞错会让快照不可构造。
 */
async function loadControlResume(
  ctx: ServerContext,
  logical: LogicalSession,
): Promise<ControlResumePlan> {
  if (logical.exportedControlState !== null) {
    // 原子消费：读取即清空，避免并发连接重复消费同一导出状态。
    const resume = logical.exportedControlState;
    logical.exportedControlState = null;
    const recoveryState = await ctx.persistence.readRecoveryState(logical.sessionId);
    return { resume, recoveryState };
  }
  if (logical.restorable) {
    const state = await ctx.persistence.readRecoveryState(logical.sessionId);
    if (state.latestServerSeq <= 0n) {
      return { recoveryState: state };
    }
    const resume: ControlResumePlan["resume"] = {
      nextSeq: state.latestServerSeq + 1n,
      confirmedAck: state.latestServerSeq,
      replay: [],
    };
    return { resume, recoveryState: state };
  }
  return { recoveryState: null };
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
    // ControlConnection 同步挂接 Socket 监听并内部缓冲 resume 解析期间的
    // 入站消息（Upgrade 与异步加载之间零丢失）。
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
        sendFlushTimeoutMs: ctx.config.limits.sendFlushTimeoutMs,
      },
      loadResume: () => loadControlResume(ctx, logical),
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
    // 同一 Session 同时只允许一条 Media 连接（P4 修复 7）：Registry 的
    // 所有权与该连接绑定，避免多条连接互相 closeAll 串扰。
    if (logical.mediaConnections.size > 0) {
      socket.close(UNAUTHORIZED_CLOSE, "session already has a media connection");
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
