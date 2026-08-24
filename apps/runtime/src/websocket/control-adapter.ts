import { MediaStreamClosedPayloadSchema, MediaStreamOpenPayloadSchema } from "@bellis/contracts";
import type {
  ClientControlEnvelope,
  MonotonicClock,
  Phase1SessionSnapshot,
  Phase2SessionSnapshot,
  TraceContext,
} from "@bellis/contracts";
import { parseDecimalString } from "@bellis/contracts";
import type { RecoveryState, PersistenceClient } from "@bellis/persistence";
import type { LoggerPort, MetricsPort } from "@bellis/observability";
import { CONTROL_CLOSE_CODES, ControlSession, decodeControlMessage } from "@bellis/transport";
import type { ControlEffect, ControlLogicalState, ServerEnqueueResult } from "@bellis/transport";
import type { WebSocket } from "ws";
import { buildSessionSnapshot } from "../application/recovery.js";
import type { BroadcastOutcome, BroadcastReceipt } from "../application/commit-fake-scene.js";
import type { ConnectionMetrics } from "./connection-metrics.js";
import type { ExportedControlClaim, LogicalSession } from "./session-store.js";

/**
 * Control WebSocket 适配器（docs/phase-1-reference.md；control-websocket.md §12）。
 *
 * 只负责 Socket 边界与 P1 Effect 映射：入站文本全部交给
 * `ControlSession.acceptClientMessage`（P1 完整校验，Route 中无
 * `JSON.parse as Type`）；出站 Effect 串行异步执行，顺序保证：
 *
 * - resume 对账（二轮评审修复 2）：恢复连接在**任何** Replay/新消息上线
 *   前，先把 `resume.nextSeq - 1` 与 P2 水位完成单调对账
 *   （advanceServerSeq 幂等接受相等、拒绝回退）。P1 的 Replay backlog
 *   只产生 send 不产生 seq_advanced——若 Socket 在上条连接
 *   `await advanceServerSeq` 期间关闭，导出状态里已分配但未落库的 Seq
 *   只能靠这次对账补齐，否则 Replay 会未经落库直接上线。
 * - 导出状态事务式消费（三轮评审修复 1）：claim → 恢复读取 → 对账 →
 *   ControlSession 构造全部成功才 commit；读取失败、对账失败、初始化
 *   期间连接关闭或意外异常一律 rollback 原样归还——一次瞬态失败绝不
 *   把同进程导出状态不可逆消费掉（否则 Session 在本进程内无法恢复）。
 * - `seq_advanced` → **先等待 P2 advanceServerSeq 成功落库**，才执行同一
 *   消息的 `send`（P4 修复 2）。落库失败不得发送，连接降级关闭（1011）。
 * - `send` → socket.send 的**成功回调**后才确认写出（P4 修复 11）；
 *   广播等待者据此得到真实写出结果与连接代际（二轮评审修复 4）。
 * - `snapshot_required` → Replay Gap 快照用**预加载**的恢复状态同步入队，
 *   保证 `session.snapshot` 严格先于 `server.ready` 与后续业务消息
 *   （P4 修复 3）。快照不可构造/不可入队，或 resume 连接未携带
 *   lastAck（二轮评审修复 3）时强制快照，失败一律 1011 关闭——
 *   绝不静默进入 active。
 * - `dropped` → 指标（类别+数量，不含 Payload）；`close` → socket.close。
 */

const TICK_INTERVAL_US = 50_000n;
/** Seq 水位落库失败/恢复对账失败/快照不可用时的降级关闭码。 */
const SEQ_PERSIST_FAILED_CLOSE = 1011;
const SNAPSHOT_UNAVAILABLE_CLOSE = 1011;

export interface ControlLimits {
  readonly heartbeatIntervalMs: number;
  readonly helloTimeoutMs: number;
  readonly replayWindowCapacity: number;
  readonly dedupCapacity: number;
  readonly maxControlTextBytes: number;
  readonly sendQueueMaxMessages: number;
  readonly sendQueueMaxBytes: number;
  readonly sendFlushTimeoutMs: number;
}

export interface ControlResumePlan {
  /** 同进程导出状态（优先）或跨重启从 P2 水位构造的 resume。 */
  readonly resume?: ControlLogicalState;
  /** 预加载的 P2 恢复状态（Replay Gap 快照内容；可能为 null）。 */
  readonly recoveryState: RecoveryState | null;
  /**
   * 导出状态的事务式消费句柄（三轮评审修复 1）：恢复读取、水位对账
   * 与 ControlSession 构造全部成功后 commit；任何失败或初始化期间连接
   * 关闭必须 rollback（原样归还，后续重连仍可恢复）。
   */
  readonly claim?: ExportedControlClaim;
}

export interface ControlConnectionOptions {
  readonly socket: WebSocket;
  readonly logical: LogicalSession;
  readonly runtimeVersion: string;
  readonly clock: MonotonicClock;
  readonly logger: LoggerPort;
  readonly metrics: MetricsPort;
  readonly connections: ConnectionMetrics;
  readonly persistence: PersistenceClient;
  readonly limits: ControlLimits;
  /**
   * resume/恢复状态加载器（P4 修复 1/3）：同步挂接 Socket 监听后异步
   * 解析；解析完成前入站消息进入有界缓冲，不丢失。**读取失败必须
   * 抛错**（连接以 1011 失败关闭），不得降级为全新 Session。
   */
  readonly loadResume: () => Promise<ControlResumePlan>;
  /**
   * Phase 2 演出消息回调（兼容新增）：stage.capabilities / scene.ready /
   * scene.started / scene.finished / scene.cancel.ack / media.stream.ready
   * 交给应用层（Phase2PerformanceService 的 StagePort 适配器）；未注册时
   * 这些消息按未知业务类型静默忽略（不影响 Phase 1 行为）。
   */
  readonly onStageMessage?: (envelope: ClientControlEnvelope, nowUs: bigint) => void;
  /**
   * client.hello 回调（Phase 2 连接归属）：hello 通过校验后以 payload 的
   * clientType 调用；应用层据此只把 clientType=stage 的连接绑定为演出
   * Stage（Phase 1 观察者连接不进入 Phase 2 装配）。
   */
  readonly onStageHello?: (clientType: unknown) => void;
  /**
   * Phase 2 快照装饰（同步）：v1 快照构造后调用，存在活动 Scene 对账
   * 视图时升级 schemaVersion 2；异常时回落 v1 形态（不丢快照事实）。
   */
  readonly snapshotDecorator?: (
    snapshot: Phase1SessionSnapshot,
    recoveryState: RecoveryState,
  ) => Phase1SessionSnapshot | Phase2SessionSnapshot;
}

type SendWaiter = (outcome: BroadcastOutcome) => void;

interface BufferedMessage {
  readonly data: unknown;
  readonly isBinary: boolean;
}

const RESUME_INBOX_LIMIT = 256;
const RESUME_FAILED_CLOSE = 1011;

export class ControlConnection {
  readonly #socket: WebSocket;
  readonly #logical: LogicalSession;
  readonly #clock: MonotonicClock;
  readonly #logger: LoggerPort;
  readonly #metrics: MetricsPort;
  readonly #connections: ConnectionMetrics;
  readonly #persistence: PersistenceClient;
  readonly #runtimeVersion: string;
  readonly #limits: ControlLimits;
  readonly #resumeLoader: () => Promise<ControlResumePlan>;
  readonly #stageMessageHandler: ((envelope: ClientControlEnvelope, nowUs: bigint) => void) | null;
  readonly #stageHelloHandler: ((clientType: unknown) => void) | null;
  readonly #snapshotDecorator:
    | ((
        snapshot: Phase1SessionSnapshot,
        recoveryState: RecoveryState,
      ) => Phase1SessionSnapshot | Phase2SessionSnapshot)
    | null;
  readonly #pumpAbort = new AbortController();
  readonly #sendWaiters = new Map<string, SendWaiter[]>();
  /** 连接代际标识（二轮评审修复 4）：prepared/committed 必须同代际送达。 */
  readonly connectionId = crypto.randomUUID();
  #session: ControlSession | null = null;
  #recoveryState: RecoveryState | null = null;
  /** 本连接是否以 resume 恢复（决定无 lastAck 时是否强制快照）。 */
  #resumedSession = false;
  /** resume 解析期间的入站缓冲（同步挂监听，零丢失）。 */
  readonly #inbox: BufferedMessage[] = [];
  #pumpRunning = false;
  #pumpAgain = false;
  #finished = false;
  #lastPersistedSeq = 0n;
  #helloHandled = false;
  #snapshotEnqueued = false;

  constructor(options: ControlConnectionOptions) {
    this.#socket = options.socket;
    this.#logical = options.logical;
    this.#clock = options.clock;
    this.#logger = options.logger;
    this.#metrics = options.metrics;
    this.#connections = options.connections;
    this.#persistence = options.persistence;
    this.#runtimeVersion = options.runtimeVersion;
    this.#limits = options.limits;
    this.#resumeLoader = options.loadResume;
    this.#stageMessageHandler = options.onStageMessage ?? null;
    this.#stageHelloHandler = options.onStageHello ?? null;
    this.#snapshotDecorator = options.snapshotDecorator ?? null;
    // 注意：不在构造器清空 exportedControlState——loader 稍后读取它
    // （构造先于异步加载执行，提前清空会丢失同进程 resume 状态）。
    options.logical.control = this;
  }

  /**
   * 同步挂接 Socket 监听（Upgrade 与异步 resume 解析之间的入站消息进入
   * 有界缓冲，不丢失），然后异步解析 resume → 恢复水位对账 → 构造 P1
   * ControlSession → 发送 server.hello → 按序回放入站缓冲。
   */
  start(): void {
    this.#connections.acquire("control");
    this.#socket.on("message", (data: unknown, isBinary: boolean) => {
      if (this.#finished) {
        return;
      }
      if (this.#session === null) {
        if (this.#inbox.length >= RESUME_INBOX_LIMIT) {
          this.#socket.terminate();
          this.#handleSocketClosed("inbox_overflow");
          return;
        }
        this.#inbox.push({ data, isBinary });
        return;
      }
      this.#handleSocketMessage(data, isBinary);
    });
    this.#socket.on("close", () => this.#handleSocketClosed("close"));
    this.#socket.on("error", (error: Error) => {
      this.#logger.log("warn", "runtime_control_socket_error", {
        sessionId: this.#logical.sessionId,
        error: error.message,
      });
      this.#handleSocketClosed("error");
    });
    void this.#initialize();
  }

  async #initialize(): Promise<void> {
    let plan: ControlResumePlan;
    try {
      plan = await this.#resumeLoader();
    } catch (error) {
      // 读取失败：loader 已回滚 claim，导出状态留给故障解除后的重连。
      this.#logger.log("warn", "runtime_control_resume_failed", {
        sessionId: this.#logical.sessionId,
        error: error instanceof Error ? error.message : "unknown",
      });
      this.#finish(RESUME_FAILED_CLOSE, "session resume failed");
      return;
    }
    try {
      if (this.#finished) {
        plan.claim?.rollback();
        return;
      }
      this.#recoveryState = plan.recoveryState;
      this.#resumedSession = plan.resume !== undefined;
      // 恢复水位对账（二轮评审修复 2）：任何 Replay/新消息上线前，先把
      // 上条连接已分配的最大 Seq 补落库。advanceServerSeq 幂等接受相等。
      if (plan.resume !== undefined && plan.resume.nextSeq > 1n) {
        const watermark = plan.resume.nextSeq - 1n;
        const reconciled = await this.#persistServerSeqAwait(watermark);
        if (this.#finished) {
          plan.claim?.rollback();
          return;
        }
        if (!reconciled) {
          plan.claim?.rollback();
          this.#logger.log("error", "runtime_seq_reconcile_failed_close", {
            sessionId: this.#logical.sessionId,
            watermark: watermark.toString(),
          });
          this.#finish(SEQ_PERSIST_FAILED_CLOSE, "resume watermark reconcile failed");
          return;
        }
        this.#lastPersistedSeq = watermark;
      }
      this.#session = new ControlSession({
        sessionId: this.#logical.sessionId,
        runtimeVersion: this.#runtimeVersion,
        clock: this.#clock,
        heartbeat: { intervalMs: this.#limits.heartbeatIntervalMs },
        helloTimeoutUs: BigInt(this.#limits.helloTimeoutMs) * 1000n,
        replayWindowCapacity: this.#limits.replayWindowCapacity,
        dedupCapacity: this.#limits.dedupCapacity,
        maxTextBytes: this.#limits.maxControlTextBytes,
        sendQueue: {
          maxMessages: this.#limits.sendQueueMaxMessages,
          maxBytes: this.#limits.sendQueueMaxBytes,
        },
        ...(plan.resume === undefined ? {} : { resume: plan.resume }),
        logger: this.#logger,
      });
      // 构造成功：导出状态已转移到活跃会话，claim 永久提交（此后关闭
      // 会重新导出更新后的状态，与本次 claim 无关）。
      plan.claim?.commit();
      const hello = this.#session.enqueueServerMessage({
        type: "server.hello",
        payload: this.#session.helloPayload(),
        sentAtUs: this.#clock.nowUs(),
      });
      if (hello.status !== "queued") {
        this.#logger.log("warn", "runtime_control_hello_rejected", {
          sessionId: this.#logical.sessionId,
          status: hello.status,
        });
      }
      void this.#pumpLoop();
      const buffered = this.#inbox.splice(0, this.#inbox.length);
      for (const message of buffered) {
        if (this.#finished) {
          return;
        }
        this.#handleSocketMessage(message.data, message.isBinary);
      }
    } catch (error) {
      // 兜底：claim 结算前的意外异常同样回滚（未结算的 claim 会阻塞
      // 后续重连的预留等待），并以 1011 失败关闭。
      plan.claim?.rollback();
      this.#logger.log("error", "runtime_control_init_failed", {
        sessionId: this.#logical.sessionId,
        error: error instanceof Error ? error.message : "unknown",
      });
      this.#finish(RESUME_FAILED_CLOSE, "session initialization failed");
    }
  }

  #handleSocketMessage(data: unknown, isBinary: boolean): void {
    if (isBinary) {
      // Control 通道只接受文本；二进制帧按协议错误关闭。
      this.#session?.enqueueServerMessage({
        type: "error",
        payload: {
          error: {
            code: "invalid_message",
            message: "control channel accepts text frames only",
            retryable: false,
            traceId: this.#newTraceId(),
          },
        },
        sentAtUs: this.#clock.nowUs(),
      });
      this.#session?.close("binary_frame_rejected", CONTROL_CLOSE_CODES.protocol_error);
      void this.#pump();
      return;
    }
    const text =
      typeof data === "string" ? data : Buffer.from(data as ArrayBufferLike).toString("utf8");
    void this.#acceptText(text);
  }

  /** 是否还能接收广播（活跃且未进入关闭）。 */
  acceptsBroadcast(): boolean {
    const session = this.#session;
    return (
      !this.#finished &&
      session !== null &&
      session.state !== "closed" &&
      this.#socket.readyState === 1
    );
  }

  /**
   * Application 广播入口：enqueue + pump；`awaitSent` 时等到 Socket 发送
   * 回调成功（P4 修复 11）。等待超时降级关闭连接——committed（P1）不允许
   * 在线上反超尚未写出的 prepared（P3）。返回写出结果与**本连接代际**；
   * `onlyConnectionId` 指定其它代际时拒绝发布（二轮评审修复 4）。
   */
  /**
   * Phase 2 演出命令发送（scene.prepare/commit/cancel/媒体声明，兼容新增）：
   * 同 broadcast 的入队路径，但同步返回是否入队成功（StagePort 适配器
   * 需要即时判定"确定性发送失败"）。仅由 Phase 2 装配使用。
   */
  sendPhase2Message(message: {
    readonly type: string;
    readonly payload: unknown;
    readonly traceId: string;
  }): boolean {
    const session = this.#session;
    if (session === null) {
      return false;
    }
    const result: ServerEnqueueResult = session.enqueueServerMessage({
      type: message.type,
      payload: message.payload,
      messageId: crypto.randomUUID(),
      trace: { traceId: message.traceId },
      sentAtUs: this.#clock.nowUs(),
    });
    if (result.status !== "queued") {
      return false;
    }
    void this.#pump();
    return true;
  }

  async broadcast(
    message: {
      readonly type: string;
      readonly payload: unknown;
      readonly traceId: string;
      readonly spanId?: string;
    },
    options?: { readonly awaitSent?: boolean; readonly onlyConnectionId?: string },
  ): Promise<BroadcastReceipt> {
    const session = this.#session;
    if (session === null || !this.acceptsBroadcast()) {
      return { outcome: "no_connection", connectionId: null };
    }
    if (options?.onlyConnectionId !== undefined && options.onlyConnectionId !== this.connectionId) {
      return { outcome: "no_connection", connectionId: null };
    }
    const messageId = crypto.randomUUID();
    const result: ServerEnqueueResult = session.enqueueServerMessage({
      type: message.type,
      payload: message.payload,
      messageId,
      trace:
        message.spanId === undefined
          ? { traceId: message.traceId }
          : { traceId: message.traceId, spanId: message.spanId },
      sentAtUs: this.#clock.nowUs(),
    });
    if (result.status !== "queued") {
      return { outcome: "unsent", connectionId: this.connectionId };
    }
    if (options?.awaitSent !== true) {
      void this.#pump();
      return { outcome: "sent", connectionId: this.connectionId };
    }
    // 先注册 waiter、立即 pump 触发发送，再等待写出结果（Gate 3 重开
    // 评审修复 2）：若先等待，本消息只能依赖 50ms 周期循环偶然发送——
    // VirtualClock 下 sleepUntil 永不触发，prepared 会一直未写出直到
    // flush 超时降级断连。waiter 注册先于任何 await，不存在发送先于
    // 注册的竞态（单线程内 enqueue 与注册之间无 interleaving）。
    const sent = this.#waitForSend(messageId);
    void this.#pump();
    const outcome = await sent;
    return { outcome, connectionId: this.connectionId };
  }

  /** 优雅排空：进入 draining，队列清空后按 4005 关闭。 */
  beginDrain(reason: string): void {
    if (this.#finished) {
      return;
    }
    this.#session?.close(reason, CONTROL_CLOSE_CODES.server_shutdown);
    void this.#pump();
  }

  forceClose(): void {
    if (this.#finished) {
      return;
    }
    this.#socket.terminate();
  }

  /**
   * client.hello 的快照决策（P4 修复 3 + 二轮评审修复 3）：
   * - lastAck 重放判定为 snapshot_required → Replay Gap 快照；
   * - resume 连接未携带 lastAck（客户端水位未知）→ 强制快照，
   *   绝不把空 Replay 当成已追平静默进入 active；
   * - （decodeControlMessage 是 P1 包根公开 API，非 Route 内裸 JSON.parse。）
   */
  #helloSnapshotDecision(text: string): { required: boolean; lastAckPresent: boolean } {
    const session = this.#session;
    if (session === null) {
      return { required: false, lastAckPresent: false };
    }
    const decoded = decodeControlMessage(text);
    if (!decoded.ok || decoded.value.type !== "client.hello") {
      return { required: false, lastAckPresent: false };
    }
    const lastAck = (decoded.value.payload as { lastAck?: unknown }).lastAck;
    if (typeof lastAck !== "string") {
      return { required: this.#resumedSession, lastAckPresent: false };
    }
    return {
      required: session.replayAfter(parseDecimalString(lastAck)).status === "snapshot_required",
      lastAckPresent: true,
    };
  }

  async #acceptText(text: string): Promise<void> {
    const session = this.#session;
    if (session === null || this.#finished) {
      return;
    }
    const nowUs = this.#clock.nowUs();
    let snapshotDecision: { required: boolean; lastAckPresent: boolean } | null = null;
    if (!this.#helloHandled) {
      snapshotDecision = this.#helloSnapshotDecision(text);
    }
    let accepted: ReturnType<ControlSession["acceptClientMessage"]>;
    try {
      accepted = session.acceptClientMessage(text, nowUs);
    } catch (error) {
      this.#logger.log("error", "runtime_control_accept_crashed", {
        sessionId: this.#logical.sessionId,
        error: error instanceof Error ? error.message : "unknown",
      });
      return;
    }
    if (accepted.status === "accepted") {
      try {
        if (accepted.envelope.type === "client.hello") {
          this.#helloHandled = true;
          // 连接归属（Phase 2）：hello 通过校验后按 clientType 交给应用层
          // 决定是否绑定为演出 Stage（观察者连接不进入 Phase 2）。
          this.#stageHelloHandler?.(
            (accepted.envelope.payload as { clientType?: unknown }).clientType,
          );
          // 先快照后 ready（快照内容来自预加载状态，同步可用）；快照必须
          // 成功入队，否则 1011 失败关闭（不得静默进入 active）。
          if (snapshotDecision !== null && snapshotDecision.required) {
            if (!this.#enqueueSnapshotFromPreloaded()) {
              this.#logger.log("error", "runtime_snapshot_required_unavailable", {
                sessionId: this.#logical.sessionId,
                lastAckPresent: snapshotDecision.lastAckPresent,
              });
              this.#finish(SNAPSHOT_UNAVAILABLE_CLOSE, "session snapshot unavailable");
              return;
            }
          }
          session.enqueueServerMessage({
            type: "server.ready",
            payload: {},
            trace: { traceId: accepted.envelope.trace.traceId },
            sentAtUs: nowUs,
          });
        } else {
          this.#handleAccepted(accepted.envelope, nowUs);
        }
      } catch (error) {
        this.#logger.log("error", "runtime_control_effect_failed", {
          sessionId: this.#logical.sessionId,
          type: accepted.envelope.type,
          error: error instanceof Error ? error.message : "unknown",
        });
      }
    } else if (accepted.status === "rejected" && !accepted.closeInitiated) {
      // P1 对普通拒绝只返回结果值；稳定错误响应由适配器入队
      // （closeInitiated=true 时 P1 已入队错误并进入关闭流程）。
      session.enqueueServerMessage({
        type: "error",
        payload: {
          error: {
            code: accepted.code,
            message: accepted.message,
            retryable: accepted.code === "backpressure" || accepted.code === "not_ready",
            traceId: accepted.traceId ?? this.#newTraceId(),
          },
        },
        ...(accepted.traceId === null ? {} : { trace: { traceId: accepted.traceId } }),
        sentAtUs: nowUs,
      });
    }
    await this.#pump();
  }

  #enqueueSnapshotFromPreloaded(): boolean {
    const session = this.#session;
    if (session === null || this.#snapshotEnqueued) {
      return this.#snapshotEnqueued;
    }
    if (this.#recoveryState === null) {
      return false;
    }
    let snapshot: Phase1SessionSnapshot | Phase2SessionSnapshot = buildSessionSnapshot(
      this.#recoveryState,
      {
        reason: "replay_gap",
        sessionStatus: "ready",
        runtimeVersion: this.#runtimeVersion,
        generatedAtMs: Date.now(),
      },
    );
    // Phase 2 装饰（同步，预加载恢复状态）：存在活动 Scene 对账视图时
    // 升级 v2 形态；快照必须成功入队的不变量不受装饰影响。
    if (this.#snapshotDecorator !== null) {
      try {
        snapshot = this.#snapshotDecorator(snapshot, this.#recoveryState);
      } catch (error) {
        this.#logger.log("warn", "runtime_snapshot_decorate_failed", {
          sessionId: this.#logical.sessionId,
          error: error instanceof Error ? error.message : "unknown",
        });
      }
    }
    const enqueued = session.enqueueServerMessage({
      type: "session.snapshot",
      payload: { snapshot },
      sentAtUs: this.#clock.nowUs(),
    });
    if (enqueued.status === "queued") {
      this.#snapshotEnqueued = true;
      return true;
    }
    return false;
  }

  /** 已通过 P1 全量校验的客户端消息 → Application Effect 映射。 */
  #handleAccepted(envelope: ClientControlEnvelope, nowUs: bigint): void {
    const session = this.#session;
    if (session === null) {
      return;
    }
    if (envelope.type === "media.stream.open") {
      const payload = MediaStreamOpenPayloadSchema.parse(envelope.payload);
      const opened = this.#logical.mediaStreams.open({
        streamId: payload.streamId,
        sessionId: this.#logical.sessionId,
        mediaKind: payload.mediaKind,
        contentType: payload.contentType,
      });
      if (opened.status === "rejected") {
        session.enqueueServerMessage({
          type: "error",
          payload: {
            error: {
              code: "invalid_message",
              message: `media stream open rejected (${opened.code})`,
              retryable: false,
              traceId: envelope.trace.traceId,
            },
          },
          trace: { traceId: envelope.trace.traceId },
          sentAtUs: nowUs,
        });
      }
      return;
    }
    if (envelope.type === "media.stream.closed") {
      const payload = MediaStreamClosedPayloadSchema.parse(envelope.payload);
      this.#logical.mediaStreams.close(payload.streamId);
      // 双向消息类型：服务端回执确认（Stream 关闭后不能复活）。
      session.enqueueServerMessage({
        type: "media.stream.closed",
        payload: { streamId: payload.streamId, reason: "closed_by_client" },
        trace: { traceId: envelope.trace.traceId },
        sentAtUs: nowUs,
      });
      return;
    }
    // Phase 2 演出回执（scene-execution.md）：Envelope 已通过全量校验，
    // 应用层按 type 分发；未知业务类型静默忽略。
    const STAGE_MESSAGE_TYPES: readonly string[] = [
      "stage.capabilities",
      "scene.ready",
      "scene.started",
      "scene.finished",
      "scene.cancel.ack",
      "media.stream.ready",
    ];
    if (STAGE_MESSAGE_TYPES.includes(envelope.type)) {
      this.#stageMessageHandler?.(envelope, nowUs);
    }
  }

  /**
   * Effect 串行执行（P4 修复 2/11）：seq_advanced 落库成功后才执行对应
   * send；send 以回调确认为准。任一 Seq 落库失败即停止发送并降级关闭。
   */
  async #pump(): Promise<void> {
    if (this.#finished || this.#session === null) {
      return;
    }
    if (this.#pumpRunning) {
      this.#pumpAgain = true;
      return;
    }
    this.#pumpRunning = true;
    try {
      do {
        this.#pumpAgain = false;
        const effects: readonly ControlEffect[] = this.#session.tick(this.#clock.nowUs());
        for (const effect of effects) {
          // 连接已关闭：立即停止处理（await 期间可能发生关闭）。已分配
          // 但未落库的 Seq 保留在导出状态/replay 窗口中，由重连连接的
          // 恢复水位对账在 Replay 上线前补齐（见 #initialize）。
          if (this.#finished) {
            return;
          }
          if (effect.kind === "seq_advanced") {
            if (effect.seq > this.#lastPersistedSeq) {
              const persisted = await this.#persistServerSeqAwait(effect.seq);
              if (this.#finished) {
                return;
              }
              if (!persisted) {
                this.#logger.log("error", "runtime_seq_persist_failed_close", {
                  sessionId: this.#logical.sessionId,
                  seq: effect.seq.toString(),
                });
                // 水位未落库：不得发送该消息（及后续），降级关闭连接。
                this.#finish(SEQ_PERSIST_FAILED_CLOSE, "seq persistence failed");
                return;
              }
              this.#lastPersistedSeq = effect.seq;
            }
            continue;
          }
          if (effect.kind === "send") {
            const outcome = await this.#sendAwait(effect.text, effect.envelope.messageId);
            this.#resolveWaiter(effect.envelope.messageId, outcome);
            if (this.#finished) {
              return;
            }
            continue;
          }
          if (effect.kind === "snapshot_required") {
            // 兜底路径：预判未覆盖时（不应发生）用预加载状态补发；
            // 不可构造/不可入队同样 1011 失败关闭（二轮评审修复 3）。
            if (!this.#enqueueSnapshotFromPreloaded()) {
              this.#logger.log("error", "runtime_snapshot_unavailable_close", {
                sessionId: this.#logical.sessionId,
              });
              this.#finish(SNAPSHOT_UNAVAILABLE_CLOSE, "session snapshot unavailable");
              return;
            }
            await this.#pump();
            continue;
          }
          if (effect.kind === "dropped") {
            this.#metrics
              .counter("bellis_ws_dropped_messages_total", {
                channel: "control",
                reason: effect.reason,
              })
              .inc(effect.count);
            continue;
          }
          // close：排空完成，按 Effect 的关闭码关闭 Socket。
          this.#finish(effect.code, effect.reason);
          return;
        }
      } while (this.#pumpAgain);
    } finally {
      this.#pumpRunning = false;
    }
  }

  /** Socket 写出：只在发送回调成功时确认（P4 修复 11）。 */
  #sendAwait(text: string, messageId: string): Promise<BroadcastOutcome> {
    return new Promise<BroadcastOutcome>((resolve) => {
      if (this.#socket.readyState !== 1) {
        resolve("unsent");
        return;
      }
      this.#socket.send(text, (error) => {
        if (error != null) {
          this.#logger.log("warn", "runtime_control_send_failed", {
            sessionId: this.#logical.sessionId,
            messageId,
            error: error.message,
          });
          this.#handleSocketClosed("send_error");
          resolve("unsent");
          return;
        }
        resolve("sent");
      });
    });
  }

  /** 周期 tick：Hello/心跳超时、Deadline 剪枝与队列排空。 */
  async #pumpLoop(): Promise<void> {
    try {
      for (;;) {
        await this.#clock.sleepUntil(
          this.#clock.nowUs() + TICK_INTERVAL_US,
          this.#pumpAbort.signal,
        );
        if (this.#finished) {
          return;
        }
        await this.#pump();
      }
    } catch {
      // Abort（连接关闭）— 退出循环。
    }
  }

  #waitForSend(messageId: string): Promise<BroadcastOutcome> {
    return new Promise<BroadcastOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.#removeWaiter(messageId, waiter);
        // 超时降级：关闭连接，防止高优先级后续消息反超未写出的本消息。
        this.#logger.log("warn", "runtime_control_flush_timeout", {
          sessionId: this.#logical.sessionId,
          messageId,
        });
        this.forceClose();
        resolve("unsent");
      }, this.#limits.sendFlushTimeoutMs);
      const waiter: SendWaiter = (outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      };
      const existing = this.#sendWaiters.get(messageId);
      if (existing === undefined) {
        this.#sendWaiters.set(messageId, [waiter]);
      } else {
        existing.push(waiter);
      }
    });
  }

  #resolveWaiter(messageId: string, outcome: BroadcastOutcome): void {
    const waiters = this.#sendWaiters.get(messageId);
    if (waiters === undefined) {
      return;
    }
    this.#sendWaiters.delete(messageId);
    for (const waiter of waiters) {
      waiter(outcome);
    }
  }

  #removeWaiter(messageId: string, waiter: SendWaiter): void {
    const waiters = this.#sendWaiters.get(messageId);
    if (waiters === undefined) {
      return;
    }
    const index = waiters.indexOf(waiter);
    if (index >= 0) {
      waiters.splice(index, 1);
    }
    if (waiters.length === 0) {
      this.#sendWaiters.delete(messageId);
    }
  }

  /** Seq 水位落库（await 版本，P4 修复 2）。 */
  async #persistServerSeqAwait(seq: bigint): Promise<boolean> {
    const trace: TraceContext = { traceId: this.#newTraceId(), sessionId: this.#logical.sessionId };
    try {
      await this.#persistence.advanceServerSeq({
        sessionId: this.#logical.sessionId,
        latestServerSeq: seq,
        trace,
      });
      return true;
    } catch {
      return false;
    }
  }

  #finish(code: number, reason: string): void {
    if (this.#finished) {
      return;
    }
    this.#socket.close(code, reason.length > 120 ? reason.slice(0, 120) : reason);
    this.#handleSocketClosed("effect_close");
  }

  #handleSocketClosed(trigger: string): void {
    if (this.#finished) {
      return;
    }
    this.#finished = true;
    this.#pumpAbort.abort();
    // 导出逻辑状态供同进程重连 resume；上条连接已分配但未落库的 Seq
    // 由重连连接的恢复水位对账补齐（#initialize），此处无需补偿写。
    if (this.#logical.control === this) {
      this.#logical.control = null;
      if (this.#session !== null) {
        this.#logical.exportedControlState = this.#session.exportLogicalState();
      }
    }
    // Stream 是连接级资源：Control 关闭即全部关闭，重连后重新注册。
    this.#logical.mediaStreams.closeAll();
    this.#connections.release("control");
    this.#logger.log("info", "runtime_control_closed", {
      sessionId: this.#logical.sessionId,
      trigger,
    });
    for (const waiters of this.#sendWaiters.values()) {
      for (const waiter of waiters) {
        waiter("unsent");
      }
    }
    this.#sendWaiters.clear();
    void trigger;
  }

  #newTraceId(): string {
    return crypto.randomUUID().replaceAll("-", "");
  }
}
