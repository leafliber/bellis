import { randomUUID } from "node:crypto";
import type { MonotonicClock } from "@bellis/contracts";
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
import type {
  ControlBroadcast,
  FakeSceneCommitInput,
  FakeSceneCommitResult,
} from "../application/commit-fake-scene.js";
import { createRecordingOutboxPublisher } from "../application/outbox-publisher.js";
import type { OutboxDeliveryRecord } from "../application/outbox-publisher.js";
import { LocalSessionService } from "../auth/local-session.js";
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
 * Runtime 生命周期（P4 文档 §6）。
 *
 * 启动：校验配置 → Logger/Metrics/InstanceID → Persistence Client →
 * migrate() → 装配 Service/Dispatcher → 注册 REST/WS → loopback Listen →
 * Dispatcher 启动 → ready=true。任一步失败逆序清理已创建资源，
 * ready 保持 false。
 *
 * 关闭（幂等）：ready=false → 停止接受新连接 → 通知 Control draining →
 * Abort Application → Dispatcher 停止 Claim（Grace 内结束批次）→
 * 关闭连接 → Persistence 关闭 → Fastify 关闭。
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
  /** 测试注入时钟；生产为 SystemMonotonicClock。 */
  readonly clock?: MonotonicClock;
  /** 日志输出口；生产默认 stdout。 */
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
  /** Fake Scene Commit Application Port（仅协议验证；无外部副作用）。 */
  commitFakeScene(
    input: FakeSceneCommitInput,
    signal?: AbortSignal,
  ): Promise<FakeSceneCommitResult>;
  /** 读取逻辑 Session 的恢复状态（Scene/Watermark/Server Seq）。 */
  readSessionRecovery(sessionId: string): Promise<RecoveryState>;
  /** Phase 1 发布者的脱敏交付记录（含允许的重复交付）。 */
  outboxDeliveries(): readonly OutboxDeliveryRecord[];
  /** 逻辑 Session 的媒体帧聚合计数（不含帧内容）。 */
  mediaFrameStats(sessionId: string): { accepted: number; rejected: number } | null;
  /** InMemory Metrics 快照（注入自定义 Metrics 时为 null）。 */
  metricsSnapshot(): ReturnType<InMemoryMetrics["snapshot"]> | null;
  close(): Promise<void>;
  /** 全部关闭资源后 resolve；重复 close 幂等。 */
  readonly closed: Promise<void>;
}

const DRAIN_WAIT_MS = 1_500;

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
  const logger: LoggerPort = createPinoLogger({
    service: "bellis-runtime",
    version: config.runtimeVersion,
    level: config.logLevel,
    ...(options.logDestination === undefined ? {} : { destination: options.logDestination }),
  });
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
  let systemClock: SystemMonotonicClock | undefined;
  let clock: MonotonicClock;
  if (options.clock === undefined) {
    systemClock = new SystemMonotonicClock();
    clock = systemClock;
  } else {
    clock = options.clock;
  }
  const instanceId = randomUUID();
  const status = new RuntimeStatusView();
  const requestTraces = new RequestTraceStore();
  const origins = createOriginAllowlist();
  const connections = new ConnectionMetrics(metrics);
  const tokens = new StartupTokenService({ ttlMs: config.startupTokenTtlMs });
  const store = new SessionStore({
    maxOpenStreams: config.limits.maxOpenStreams,
    maxTotalStreams: config.limits.maxTotalStreams,
    maxFramesPerStream: config.limits.maxFramesPerStream,
  });
  const publisher = createRecordingOutboxPublisher({ logger });
  const appAbort = new AbortController();
  const persistence: PersistenceClient = createPersistenceClient({
    dataDirectory: config.dataDirectory,
    defaultDeadlineMs: config.persistence.defaultDeadlineMs,
    logger,
    ...(options.checkpointObserver === undefined
      ? {}
      : { checkpointObserver: options.checkpointObserver }),
    ...(options.persistenceWorker === undefined ? {} : { worker: options.persistenceWorker }),
  });

  // —— 启动序列：任一步失败逆序清理已创建资源，ready 保持 false ——
  try {
    await persistence.migrate();
  } catch (error) {
    await persistence.close().catch(() => undefined);
    systemClock?.close();
    throw error;
  }

  const broadcast: ControlBroadcast = async (sessionId, message, broadcastOptions) => {
    const logical = store.resolveById(sessionId);
    const control = logical?.control;
    if (control === null || control === undefined || !(control instanceof ControlConnection)) {
      return "no_connection";
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
    await persistence.close().catch(() => undefined);
    systemClock?.close();
    status.markClosed();
    throw error;
  }

  let appInstance: NonNullable<typeof app> = app;
  let dispatcherInstance: OutboxDispatcher = dispatcher;
  let closeStarted = false;
  let closedResolve: (() => void) | null = null;
  const closed = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });

  const close = async (): Promise<void> => {
    if (closeStarted) {
      await closed;
      return;
    }
    closeStarted = true;
    status.markDraining();
    // 1. 停止接受新连接。注意：Node server.close() 的回调会等到现有连接
    // 全部结束才触发，因此这里只发起不等待——现有连接由后续步骤排空，
    // 最终由 fastify.close(forceCloseConnections) 兜底回收。
    appInstance.server.closeIdleConnections();
    appInstance.server.close();
    // 2. 通知 Control 连接 draining（4005），有界等待队列排空。
    store.drainAll("server_shutdown");
    const drainDeadline = Date.now() + DRAIN_WAIT_MS;
    while (Date.now() < drainDeadline && store.anyOpenConnections()) {
      await sleep(50);
    }
    store.forceCloseAll("server_shutdown");
    // 3. Abort Application 子任务。
    appAbort.abort();
    // 4. Dispatcher 停止 Claim，Grace 内结束当前批次。
    await dispatcherInstance.stop();
    // 5. 关闭 Persistence Client / DB Worker。
    await persistence.close();
    // 6. Flush Logger/Metrics（stdout 同步目标，无异步缓冲）。
    // 7. Fastify 关闭（forceCloseConnections 兜底销毁残余连接）。
    await appInstance.close().catch(() => undefined);
    systemClock?.close();
    status.markClosed();
    closedResolve?.();
  };

  return {
    config,
    instanceId,
    status,
    issueStartupToken: () => tokens.issue(),
    commitFakeScene: (input, signal) => appService.commit(input, signal),
    readSessionRecovery: (sessionId) => persistence.readRecoveryState(sessionId),
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
