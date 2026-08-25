import { randomUUID } from "node:crypto";
import type { MonotonicClock, SessionRecord } from "@bellis/contracts";
import type {
  OutboxDispatcher,
  PersistenceCheckpointObserver,
  PersistenceClient,
  PersistenceWorkerOptions,
  RecoveryState,
} from "@bellis/persistence";
import { createOutboxDispatcher, createPersistenceClient } from "@bellis/persistence";
import type {
  InMemoryMetrics,
  LoggerDestination,
  LoggerPort,
  MetricsPort,
} from "@bellis/observability";
import { createInMemoryMetrics, createPinoLogger } from "@bellis/observability";
import { SystemMonotonicClock } from "@bellis/transport";
import { FakeSceneCommitService } from "../application/commit-fake-scene.js";
import { PHASE_2_PCM_CONTENT_TYPE } from "@bellis/contracts";
import { Phase2RuntimeHost } from "../application/phase-2/host.js";
import { PersistenceSceneRepository } from "../application/phase-2/stage-port-adapter.js";
import type {
  ControlBroadcast,
  FakeSceneCommitInput,
  FakeSceneCommitResult,
} from "../application/commit-fake-scene.js";
import { createRecordingOutboxPublisher } from "../application/outbox-publisher.js";
import type { OutboxDeliveryRecord } from "../application/outbox-publisher.js";
import { LocalSessionService } from "../auth/local-session.js";
import {
  Phase2DecisionPacketPayloadSchema,
  Phase2ScenePlanCompiledPayloadSchema,
  Phase2SignalAcceptedPayloadSchema,
} from "@bellis/contracts";
import { StartupTokenService } from "../auth/startup-token.js";
import { ApplicationError } from "../errors/mapping.js";
import { RequestTraceStore, createOriginAllowlist } from "../routes/context.js";
import { ConnectionMetrics } from "../websocket/connection-metrics.js";
import { ControlConnection } from "../websocket/control-adapter.js";
import { SessionStore } from "../websocket/session-store.js";
import { parseRuntimeConfig, resolveAllowedOrigins } from "./config.js";
import type { RuntimeConfig } from "./config.js";
import { buildServer } from "./server.js";

/**
 * Runtime 生命周期（docs/phase-1-reference.md）。
 *
 * 启动：校验配置 → Logger/Metrics/InstanceID → Persistence Client →
 * migrate() → 装配 Service/Dispatcher → 注册 REST/WS → loopback Listen →
 * Dispatcher 启动 → ready=true。任一步失败逆序清理已创建资源，
 * ready 保持 false。
 *
 * 关闭（幂等，P4 修复 4）：ready=false → 停止接受新连接 → 通知 Control
 * draining → 停止接收新提交并 Abort/等待在途 Application 任务 →
 * Dispatcher 停止 Claim（Grace 内结束批次）→ 等待连接排空（Grace 上限）
 * → 强制关闭残余连接 → Persistence 关闭 → Fastify 关闭。每个步骤独立捕获
 * 错误并聚合：任一步抛错也保证剩余步骤执行、markClosed 与 closed 兑现；
 * deadline 使用配置的 shutdownGraceMs 与单调时钟。
 */

export type RuntimePhase = "starting" | "ready" | "draining" | "closed";

export interface RuntimeStatus {
  readonly phase: RuntimePhase;
  readonly ready: boolean;
  readonly port: number;
}

export class RuntimeStatusView implements RuntimeStatus {
  #phase: RuntimePhase = "starting";
  #port = 0;

  get phase(): RuntimePhase {
    return this.#phase;
  }

  get ready(): boolean {
    return this.#phase === "ready";
  }

  get port(): number {
    return this.#port;
  }

  markReady(port: number): void {
    this.#port = port;
    this.#phase = "ready";
  }

  markDraining(): void {
    if (this.#phase === "ready" || this.#phase === "starting") {
      this.#phase = "draining";
    }
  }

  markClosed(): void {
    this.#phase = "closed";
  }
}

/** 装配选项：config 为 unknown 输入；其余为测试注入（生产留空）。 */
export interface RuntimeOptions {
  readonly config: unknown;
  /** 受控检查点观察器；仅测试装配注入，生产留空（P2 §9）。 */
  readonly checkpointObserver?: PersistenceCheckpointObserver;
  /** 测试注入的持久化 Worker 装配（TS 源码 Worker）；生产留空。 */
  readonly persistenceWorker?: PersistenceWorkerOptions;
  /**
   * 测试注入的 PersistenceClient（包装延迟/失败注入用）；提供时不再
   * 内部创建客户端，migrate/close 语义由注入对象承担。生产留空。
   */
  readonly persistenceClient?: PersistenceClient;
  /** 测试注入 LoggerPort；生产默认 Pino(stdout)。 */
  readonly logger?: LoggerPort;
  /** 测试注入时钟；生产为 SystemMonotonicClock。 */
  readonly clock?: MonotonicClock;
  /** Pino 日志输出口（仅默认 Pino 装配时生效）。 */
  readonly logDestination?: LoggerDestination;
  /** Metrics 注入（测试）；生产为 InMemoryMetrics。 */
  readonly metrics?: MetricsPort;
}

export interface RuntimeHandle {
  readonly config: RuntimeConfig;
  readonly instanceId: string;
  readonly status: RuntimeStatus;
  /** 签发一次性启动 Token（测试/开发装配用；原值只在此返回，不落日志）。 */
  issueStartupToken(): { token: string; expiresAtMs: number };
  /** Phase 2 演出宿主（显式启用时非 null；开发/Demo 装配入口）。 */
  readonly phase2: Phase2RuntimeHost | null;
  /** Fake Scene Commit Application Port（仅协议验证；无外部副作用）。 */
  commitFakeScene(
    input: FakeSceneCommitInput,
    signal?: AbortSignal,
  ): Promise<FakeSceneCommitResult>;
  /** 读取逻辑 Session 的恢复状态（Scene/Watermark/Server Seq）。 */
  readSessionRecovery(sessionId: string): Promise<RecoveryState>;
  /** 按 trace 根查询 Session Record（Trace 连续性验证；不含帧内容）。 */
  listRecordsByTrace(traceId: string): Promise<readonly SessionRecord[]>;
  /** Phase 1 发布者的脱敏交付记录（含允许的重复交付）。 */
  outboxDeliveries(): readonly OutboxDeliveryRecord[];
  /** 逻辑 Session 的媒体帧聚合计数（不含帧内容）。 */
  mediaFrameStats(sessionId: string): { accepted: number; rejected: number } | null;
  /** InMemory Metrics 快照（注入自定义 Metrics 时为 null）。 */
  metricsSnapshot(): ReturnType<InMemoryMetrics["snapshot"]> | null;
  /**
   * 优雅关闭（幂等；可处理重复调用与启动中关闭）。某一步骤失败时其余
   * 步骤仍会执行，最终以聚合错误 reject；`closed` 仍然兑现。
   */
  close(): Promise<void>;
  /** 全部关闭资源后 resolve；即使 close() 本身抛错也会兑现。 */
  readonly closed: Promise<void>;
}

/**
 * 合并多个 AbortSignal（任一触发即触发）。返回信号与显式 disposer：
 * 正常完成的 Commit 必须调用 disposer 移除监听器——`{once:true}` 只在
 * 真正 Abort 后清理，长期存活的 appAbort.signal 上的残留闭包会造成
 * 无界增长（二轮评审修复 6）。
 */
function mergeSignals(signals: readonly AbortSignal[]): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  for (const source of signals) {
    if (source.aborted) {
      controller.abort(source.reason);
      continue;
    }
    const listener = (): void => {
      controller.abort(source.reason);
    };
    source.addEventListener("abort", listener, { once: true });
    listeners.push({ signal: source, listener });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const entry of listeners) {
        entry.signal.removeEventListener("abort", entry.listener);
      }
      listeners.length = 0;
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Phase 2 审计 Record 的版本化 payload Schema 注册表（recordType → Schema）。 */
const PHASE_2_AUDIT_PAYLOAD_SCHEMAS = {
  phase2_signal_accepted: Phase2SignalAcceptedPayloadSchema,
  phase2_decision_packet: Phase2DecisionPacketPayloadSchema,
  phase2_scene_plan_compiled: Phase2ScenePlanCompiledPayloadSchema,
} as const;

function phase2AuditPayloadSchemaFor(recordType: string) {
  const schema =
    PHASE_2_AUDIT_PAYLOAD_SCHEMAS[recordType as keyof typeof PHASE_2_AUDIT_PAYLOAD_SCHEMAS];
  if (schema === undefined) {
    throw new Error(`phase2_audit_payload_unknown_record_type:${recordType}`);
  }
  return schema;
}

export async function startRuntime(options: RuntimeOptions): Promise<RuntimeHandle> {
  const parsed = parseRuntimeConfig(options.config);
  if (!parsed.ok) {
    throw new ApplicationError(
      "invalid_message",
      `invalid runtime config: ${parsed.issues
        .slice(0, 5)
        .map((issue) => `${issue.path} ${issue.message}`)
        .join("; ")}`,
    );
  }
  const config = parsed.config;
  let systemClock: SystemMonotonicClock | undefined;
  let clock: MonotonicClock;
  if (options.clock === undefined) {
    systemClock = new SystemMonotonicClock();
    clock = systemClock;
  } else {
    clock = options.clock;
  }
  const logger: LoggerPort =
    options.logger ??
    createPinoLogger({
      service: "bellis-runtime",
      version: config.runtimeVersion,
      level: config.logLevel,
      ...(options.logDestination === undefined ? {} : { destination: options.logDestination }),
    });
  if (options.logger !== undefined && options.logDestination !== undefined) {
    logger.log("warn", "runtime_logger_options_conflict", {
      message: "both logger and logDestination provided; injected logger wins",
    });
  }
  const inMemoryMetrics =
    options.metrics === undefined
      ? createInMemoryMetrics({
          onError: (rejection) =>
            logger.log("warn", "runtime_metrics_rejected", {
              metric: rejection.metric,
              reason: rejection.reason,
            }),
        })
      : null;
  const metrics: MetricsPort = options.metrics ?? inMemoryMetrics ?? createInMemoryMetrics();
  const instanceId = randomUUID();
  const status = new RuntimeStatusView();
  const requestTraces = new RequestTraceStore();
  const origins = createOriginAllowlist();
  const connections = new ConnectionMetrics(metrics);
  const tokens = new StartupTokenService({ ttlMs: config.startupTokenTtlMs });
  const store = new SessionStore(
    {
      maxOpenStreams: config.limits.maxOpenStreams,
      maxTotalStreams: config.limits.maxTotalStreams,
      maxFramesPerStream: config.limits.maxFramesPerStream,
    },
    {
      ttlMs: config.limits.sessionTtlMs,
      maxSessions: config.limits.maxSessions,
    },
  );
  const publisher = createRecordingOutboxPublisher({ logger });
  const appAbort = new AbortController();
  const ownsPersistence = options.persistenceClient === undefined;
  const persistence: PersistenceClient =
    options.persistenceClient ??
    createPersistenceClient({
      dataDirectory: config.dataDirectory,
      defaultDeadlineMs: config.persistence.defaultDeadlineMs,
      logger,
      ...(options.checkpointObserver === undefined
        ? {}
        : { checkpointObserver: options.checkpointObserver }),
      ...(options.persistenceWorker === undefined ? {} : { worker: options.persistenceWorker }),
    });

  // —— 启动序列：任一步失败逆序清理已创建资源，ready 保持 false ——
  if (ownsPersistence) {
    try {
      await persistence.migrate();
    } catch (error) {
      await persistence.close().catch(() => undefined);
      systemClock?.close();
      throw error;
    }
  }

  const broadcast: ControlBroadcast = async (sessionId, message, broadcastOptions) => {
    const logical = store.resolveById(sessionId);
    const control = logical?.control;
    if (control === null || control === undefined || !(control instanceof ControlConnection)) {
      return { outcome: "no_connection", connectionId: null };
    }
    return control.broadcast(message, broadcastOptions);
  };
  const appService = new FakeSceneCommitService({
    client: persistence,
    broadcast,
    logger,
    metrics,
    clock,
  });
  const sessions = new LocalSessionService({ tokens, store, persistence, logger });

  // Phase 2 演出宿主（显式启用的开发/Demo 装配；生产默认不创建）。
  const startupTraceId = crypto.randomUUID().replaceAll("-", "").slice(0, 31) + "0";
  let phase2Host: Phase2RuntimeHost | null = null;
  // Phase 2 当前逻辑 Session（审计 Record 的 sessionId；Stage 连接后更新）。
  let phase2SessionId = config.phase2.sessionId ?? "00000000-0000-4000-8000-000000000000";
  if (config.phase2.enabled) {
    const phase2Repository = new PersistenceSceneRepository({
      client: {
        commitScene: async (input) => persistence.commitScene(input as never),
        appendRecord: async (input) => persistence.appendRecord(input as never),
      },
      traceId: startupTraceId,
      newRecordId: () => crypto.randomUUID(),
    });
    phase2Host = new Phase2RuntimeHost({
      sessionId: config.phase2.sessionId ?? "00000000-0000-4000-8000-000000000000",
      capabilities: {
        schemaVersion: 1,
        audio: {
          contentTypes: [PHASE_2_PCM_CONTENT_TYPE],
          maxBufferedUs: "2000000",
        },
        subtitle: { supported: true },
        avatar: { adapter: "fake-demo", motions: ["nod_agree"], expressions: ["happy"] },
      },
      clock,
      wallClockMs: () => Date.now(),
      compileIds: { nextId: () => crypto.randomUUID() },
      recordId: () => crypto.randomUUID(),
      repository: phase2Repository,
      logger,
      metrics,
      runtimeVersion: config.runtimeVersion,
      ...(config.phase2.faultPoint === undefined
        ? {}
        : {
            directorFaultHook: (point) => {
              if (point === config.phase2.faultPoint) {
                // 崩溃窗口注入：before/after durable 窗口必须同步死亡
                // （DB 写入竞态决定落库事实）；stage 出站窗口（commit/
                // cancel 已入队）延迟 50ms 让消息先写出到达 Stage，命中
                // 「已发出」语义；随后制造无清理路径的硬崩溃现场。
                logger.log("info", "phase2_fault_window_injected", { point });
                const flushDelayMs =
                  point === "after_stage_commit" || point === "after_cancel_sent" ? 50 : 0;
                if (flushDelayMs === 0) {
                  process.kill(process.pid, "SIGKILL");
                  return;
                }
                const timer = setTimeout(() => {
                  process.kill(process.pid, "SIGKILL");
                }, flushDelayMs);
                timer.unref?.();
              }
            },
          }),
      // 版本化审计 Record（Signal 接受/决策包/编译结果；不含发言全文）。
      // payload 必须通过对应 recordType 的版本化 Schema（SessionRecord 的
      // 闭合约定），非法 payload 显式失败而非落任意 JSON。
      // traceId：提交链根（Signal→决策→编译共用，由 Service 传入）；
      // 缺省回落装配级 startup 根。
      audit: {
        append: async (record) => {
          const payloadCheck = phase2AuditPayloadSchemaFor(record.recordType).safeParse(
            record.payload,
          );
          if (!payloadCheck.success) {
            throw new Error(
              `phase2_audit_payload_invalid:${record.recordType}:${payloadCheck.error.issues[0]?.code ?? "unknown"}`,
            );
          }
          const traceId = record.traceId ?? startupTraceId;
          await persistence.appendRecord({
            record: {
              schemaVersion: 1,
              recordId: crypto.randomUUID(),
              sessionId: phase2SessionId,
              recordType: record.recordType,
              aggregateId: record.aggregateId,
              traceId,
              occurredAtMs: Date.now(),
              payload: record.payload,
            },
            trace: { traceId },
          });
        },
      },
      // Stage 连接出现即绑定真实逻辑 Session：生命周期/审计 Record 携带
      // 真实 sessionId（Record Schema 要求 UUID，占位值会被持久化层拒绝）。
      onSessionIdResolved: (sessionId) => {
        phase2SessionId = sessionId;
        phase2Repository.bindSessionId(sessionId);
      },
    });
    if (config.phase2.sessionId !== undefined) {
      phase2Repository.bindSessionId(config.phase2.sessionId);
    }
  }

  let app: Awaited<ReturnType<typeof buildServer>> | null = null;
  let dispatcher: OutboxDispatcher | null = null;
  try {
    dispatcher = createOutboxDispatcher({
      client: persistence,
      publish: publisher.publish,
      ownerInstanceId: `bellis-runtime-${instanceId}`,
      clock,
      pollIntervalMs: config.outbox.pollIntervalMs,
      leaseMs: config.outbox.leaseMs,
      claimLimit: config.outbox.claimLimit,
      stopGraceMs: config.outbox.stopGraceMs,
      logger,
      metrics,
      ...(options.checkpointObserver === undefined
        ? {}
        : { checkpointObserver: options.checkpointObserver }),
    });
    app = await buildServer({
      config,
      logger,
      metrics,
      status,
      instanceId,
      clock,
      persistence,
      sessions,
      origins,
      requestTraces,
      connections,
      ...(phase2Host === null ? {} : { phase2: phase2Host }),
    });
    await app.listen({
      host: config.host === "localhost" ? "127.0.0.1" : config.host,
      port: config.port,
    });
    const address = app.server.address();
    const actualPort =
      typeof address === "object" && address !== null && "port" in address
        ? address.port
        : config.port;
    origins.replaceAll(resolveAllowedOrigins(config, actualPort));
    logger.log("info", "runtime_listening", {
      host: config.host,
      port: actualPort,
      instanceId,
    });
    dispatcher.start();
    status.markReady(actualPort);
  } catch (error) {
    if (app !== null) {
      await app.close().catch(() => undefined);
    }
    if (dispatcher !== null) {
      await dispatcher.stop().catch(() => undefined);
    }
    store.close();
    await persistence.close().catch(() => undefined);
    systemClock?.close();
    status.markClosed();
    throw error;
  }

  const appInstance: NonNullable<typeof app> = app;
  const dispatcherInstance: OutboxDispatcher = dispatcher;
  const graceUs = BigInt(Math.max(1, config.shutdownGraceMs)) * 1000n;
  const inflightCommits = new Set<Promise<unknown>>();
  let closeStarted = false;
  let closedResolve: (() => void) | null = null;
  const closed = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });

  /** 单步关闭：错误捕获并聚合，不阻断后续步骤（P4 修复 4）。
   *
   * 顺序与 docs/phase-1-reference.md 一致（Gate 3 重开评审修复 3）：停止接入与
   * draining 通知之后，**先** Abort 应用任务、停止 Outbox Claim，
   * **再**花时间等待/排空连接——连接排空最长可等满 shutdownGraceMs，
   * 期间既不得继续执行已有 Commit 任务，也不得继续领取/发布 Outbox。
   */
  const closeSteps: Array<{ name: string; run: () => Promise<void> | void }> = [
    {
      name: "phase2-host",
      run: () => phase2Host?.close() ?? Promise.resolve(),
    },
    {
      name: "stop-listen",
      run: () => {
        // 只发起不等待：server.close() 回调要等现有连接全部结束，
        // 现有连接由后续步骤排空，最终由 fastify.close 兜底回收。
        appInstance.server.closeIdleConnections();
        appInstance.server.close();
      },
    },
    {
      name: "notify-draining",
      run: () => {
        // 通知 Control 连接 draining（4005 优雅排空）；实际等待在
        // 应用任务与 Outbox 停止之后（drain-connections）。
        store.drainAll("server_shutdown");
      },
    },
    {
      name: "abort-app-tasks",
      run: async () => {
        // 停止接收新提交已在 commitFakeScene 包装层完成（draining 拒绝）。
        appAbort.abort();
        const deadline = clock.nowUs() + graceUs;
        while (inflightCommits.size > 0 && clock.nowUs() < deadline) {
          await sleep(25);
        }
        if (inflightCommits.size > 0) {
          logger.log("warn", "runtime_close_inflight_commits_timeout", {
            remaining: inflightCommits.size,
          });
        }
      },
    },
    {
      name: "dispatcher-stop",
      run: () => dispatcherInstance.stop(),
    },
    {
      name: "drain-connections",
      run: async () => {
        const deadline = clock.nowUs() + graceUs;
        while (store.anyOpenConnections() && clock.nowUs() < deadline) {
          await sleep(25);
        }
      },
    },
    {
      name: "force-close-connections",
      run: () => {
        store.forceCloseAll("server_shutdown");
      },
    },
    {
      // 取消 TTL 到期调度器（三轮评审修复 2）：不留任何调度句柄。
      name: "session-store-close",
      run: () => store.close(),
    },
    {
      name: "persistence-close",
      run: () => persistence.close(),
    },
    {
      name: "fastify-close",
      run: async () => {
        // Flush Logger/Metrics（stdout 同步目标，无异步缓冲）后关闭。
        await appInstance.close();
      },
    },
  ];

  const close = async (): Promise<void> => {
    if (closeStarted) {
      await closed;
      return;
    }
    closeStarted = true;
    status.markDraining();
    const failures: Array<{ name: string; error: unknown }> = [];
    try {
      for (const step of closeSteps) {
        try {
          await step.run();
        } catch (error) {
          failures.push({ name: step.name, error });
          logger.log("warn", "runtime_close_step_failed", {
            step: step.name,
            error: error instanceof Error ? error.message : "unknown",
          });
        }
      }
      systemClock?.close();
    } finally {
      status.markClosed();
      closedResolve?.();
    }
    if (failures.length > 0) {
      const first = failures[0];
      if (first === undefined) {
        throw new ApplicationError("internal_error", "runtime close failed");
      }
      throw new ApplicationError("internal_error", `runtime close failed at step ${first.name}`, {
        cause: first.error,
      });
    }
  };

  return {
    config,
    instanceId,
    status,
    issueStartupToken: () => tokens.issue(),
    phase2: phase2Host,
    commitFakeScene: (input, signal) => {
      if (closeStarted || status.phase !== "ready") {
        return Promise.reject(new ApplicationError("not_ready", "runtime is shutting down"));
      }
      const merged = mergeSignals([appAbort.signal, ...(signal === undefined ? [] : [signal])]);
      const run = appService.commit(input, merged.signal);
      const tracked = run.finally(() => {
        // 正常完成也要移除合并监听器（二轮评审修复 6：防长期泄漏）。
        merged.dispose();
        inflightCommits.delete(tracked);
      });
      inflightCommits.add(tracked);
      return tracked;
    },
    readSessionRecovery: (sessionId) => persistence.readRecoveryState(sessionId),
    listRecordsByTrace: (traceId) =>
      persistence.listRecords({ traceId, limit: 64 }).then((records) => [...records]),
    outboxDeliveries: () => publisher.records(),
    mediaFrameStats: (sessionId) => {
      const logical = store.resolveById(sessionId);
      return logical === null ? null : { ...logical.mediaFrames };
    },
    metricsSnapshot: () => inMemoryMetrics?.snapshot() ?? null,
    close,
    closed,
  };
}
