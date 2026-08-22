import { MediaStreamClosedPayloadSchema, MediaStreamOpenPayloadSchema } from "@bellis/contracts";
import type { ClientControlEnvelope, MonotonicClock, TraceContext } from "@bellis/contracts";
import type { RecoveryState, PersistenceClient } from "@bellis/persistence";
import type { LoggerPort, MetricsPort } from "@bellis/observability";
import { CONTROL_CLOSE_CODES, ControlSession } from "@bellis/transport";
import type { ControlEffect, ServerEnqueueResult } from "@bellis/transport";
import type { WebSocket } from "ws";
import { buildSessionSnapshot } from "../application/recovery.js";
import type { BroadcastOutcome } from "../application/commit-fake-scene.js";
import type { ConnectionMetrics } from "./connection-metrics.js";
import type { LogicalSession } from "./session-store.js";

/**
 * Control WebSocket 适配器（P4 文档 §9；control-websocket.md §12）。
 *
 * 只负责 Socket 边界与 P1 Effect 映射：入站文本全部交给
 * `ControlSession.acceptClientMessage`（P1 完整校验，Route 中无
 * `JSON.parse as Type`）；出站全部来自 `tick()` 的 Effect：
 *
 * - `send` → socket.write(text)
 * - `seq_advanced` → P2 `advanceServerSeq` 持久化最新分配水位
 *   （含瞬时消息；进程重启后不复用 Seq）
 * - `snapshot_required` → P2 `readRecoveryState` 构造 Phase1SessionSnapshot
 *   （activeScene 恒 null、openMediaStreams 恒空）
 * - `dropped` → 指标（类别+数量，不含 Payload）
 * - `close` → socket.close(code, reason)
 */

const TICK_INTERVAL_US = 50_000n;
const SEND_FLUSH_TIMEOUT_MS = 2_000;

export interface ControlLimits {
  readonly heartbeatIntervalMs: number;
  readonly helloTimeoutMs: number;
  readonly replayWindowCapacity: number;
  readonly dedupCapacity: number;
  readonly maxControlTextBytes: number;
  readonly sendQueueMaxMessages: number;
  readonly sendQueueMaxBytes: number;
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
}

type SendWaiter = (outcome: BroadcastOutcome) => void;

export class ControlConnection {
  readonly #socket: WebSocket;
  readonly #logical: LogicalSession;
  readonly #session: ControlSession;
  readonly #clock: MonotonicClock;
  readonly #logger: LoggerPort;
  readonly #metrics: MetricsPort;
  readonly #connections: ConnectionMetrics;
  readonly #persistence: PersistenceClient;
  readonly #runtimeVersion: string;
  readonly #pumpAbort = new AbortController();
  readonly #sendWaiters = new Map<string, SendWaiter[]>();
  #pumpRunning = false;
  #pumpAgain = false;
  #finished = false;
  #lastPersistedSeq = 0n;

  constructor(options: ControlConnectionOptions) {
    this.#socket = options.socket;
    this.#logical = options.logical;
    this.#clock = options.clock;
    this.#logger = options.logger;
    this.#metrics = options.metrics;
    this.#connections = options.connections;
    this.#persistence = options.persistence;
    this.#runtimeVersion = options.runtimeVersion;
    const resume = options.logical.exportedControlState;
    this.#session = new ControlSession({
      sessionId: options.logical.sessionId,
      runtimeVersion: options.runtimeVersion,
      clock: options.clock,
      heartbeat: { intervalMs: options.limits.heartbeatIntervalMs },
      helloTimeoutUs: BigInt(options.limits.helloTimeoutMs) * 1000n,
      replayWindowCapacity: options.limits.replayWindowCapacity,
      dedupCapacity: options.limits.dedupCapacity,
      maxTextBytes: options.limits.maxControlTextBytes,
      sendQueue: {
        maxMessages: options.limits.sendQueueMaxMessages,
        maxBytes: options.limits.sendQueueMaxBytes,
      },
      ...(resume === null ? {} : { resume }),
      logger: options.logger,
    });
    // resume 状态已被本连接消费；断线时由 close 处理器重新导出。
    options.logical.exportedControlState = null;
    options.logical.control = this;
  }

  /** 接入 Socket 并发送 server.hello（P1 在 resume 会话上先重放后 hello）。 */
  start(): void {
    this.#connections.acquire("control");
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
    this.#socket.on("message", (data: unknown, isBinary: boolean) => {
      if (this.#finished) {
        return;
      }
      if (isBinary) {
        // Control 通道只接受文本；二进制帧按协议错误关闭。
        this.#session.enqueueServerMessage({
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
        this.#session.close("binary_frame_rejected", CONTROL_CLOSE_CODES.protocol_error);
        void this.#pump();
        return;
      }
      const text =
        typeof data === "string" ? data : Buffer.from(data as ArrayBufferLike).toString("utf8");
      void this.#acceptText(text);
    });
    this.#socket.on("close", () => this.#handleSocketClosed("close"));
    this.#socket.on("error", (error: Error) => {
      this.#logger.log("warn", "runtime_control_socket_error", {
        sessionId: this.#logical.sessionId,
        error: error.message,
      });
      this.#handleSocketClosed("error");
    });
    void this.#pumpLoop();
  }

  /** 是否还能接收广播（活跃且未进入关闭）。 */
  acceptsBroadcast(): boolean {
    return !this.#finished && this.#session.state !== "closed" && this.#socket.readyState === 1;
  }

  /**
   * Application 广播入口：enqueue + pump；`awaitSent` 时等到实际写出。
   * 返回值不抛异常——发布是尽力而为的协议事件，事实以数据库为准。
   */
  async broadcast(
    message: {
      readonly type: string;
      readonly payload: unknown;
      readonly traceId: string;
      readonly spanId?: string;
    },
    options?: { readonly awaitSent?: boolean },
  ): Promise<BroadcastOutcome> {
    if (!this.acceptsBroadcast()) {
      return "no_connection";
    }
    const messageId = crypto.randomUUID();
    const result: ServerEnqueueResult = this.#session.enqueueServerMessage({
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
      return "unsent";
    }
    if (options?.awaitSent !== true) {
      void this.#pump();
      return "sent";
    }
    const outcome = await this.#waitForSend(messageId);
    void this.#pump();
    return outcome;
  }

  /** 优雅排空：进入 draining，队列清空后按 4005 关闭。 */
  beginDrain(reason: string): void {
    if (this.#finished) {
      return;
    }
    this.#session.close(reason, CONTROL_CLOSE_CODES.server_shutdown);
    void this.#pump();
  }

  forceClose(): void {
    if (this.#finished) {
      return;
    }
    this.#socket.terminate();
  }

  async #acceptText(text: string): Promise<void> {
    const nowUs = this.#clock.nowUs();
    let accepted: ReturnType<ControlSession["acceptClientMessage"]>;
    try {
      accepted = this.#session.acceptClientMessage(text, nowUs);
    } catch (error) {
      this.#logger.log("error", "runtime_control_accept_crashed", {
        sessionId: this.#logical.sessionId,
        error: error instanceof Error ? error.message : "unknown",
      });
      return;
    }
    if (accepted.status === "accepted") {
      try {
        this.#handleAccepted(accepted.envelope, nowUs);
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
      this.#session.enqueueServerMessage({
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

  /** 已通过 P1 全量校验的客户端消息 → Application Effect 映射。 */
  #handleAccepted(envelope: ClientControlEnvelope, nowUs: bigint): void {
    if (envelope.type === "client.hello") {
      // 握手完成：声明会话就绪（空 Payload 的协议事件）。
      this.#session.enqueueServerMessage({
        type: "server.ready",
        payload: {},
        trace: { traceId: envelope.trace.traceId },
        sentAtUs: nowUs,
      });
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
        this.#session.enqueueServerMessage({
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
      this.#session.enqueueServerMessage({
        type: "media.stream.closed",
        payload: { streamId: payload.streamId, reason: "closed_by_client" },
        trace: { traceId: envelope.trace.traceId },
        sentAtUs: nowUs,
      });
    }
  }

  async #pump(): Promise<void> {
    if (this.#finished) {
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
          this.#executeEffect(effect);
        }
      } while (this.#pumpAgain);
    } finally {
      this.#pumpRunning = false;
    }
  }

  #executeEffect(effect: ControlEffect): void {
    if (effect.kind === "send") {
      if (this.#socket.readyState === 1) {
        this.#socket.send(effect.text, (error) => {
          if (error != null) {
            this.#logger.log("warn", "runtime_control_send_failed", {
              sessionId: this.#logical.sessionId,
              error: error.message,
            });
            this.#handleSocketClosed("send_error");
          }
        });
      }
      this.#resolveWaiter(effect.envelope.messageId, "sent");
      return;
    }
    if (effect.kind === "seq_advanced") {
      if (effect.seq > this.#lastPersistedSeq) {
        this.#lastPersistedSeq = effect.seq;
        this.#persistServerSeq(effect.seq);
      }
      return;
    }
    if (effect.kind === "snapshot_required") {
      void this.#sendSnapshot();
      return;
    }
    if (effect.kind === "dropped") {
      this.#metrics
        .counter("bellis_ws_dropped_messages_total", { channel: "control", reason: effect.reason })
        .inc(effect.count);
      return;
    }
    // close：排空完成，按 Effect 的关闭码关闭 Socket。
    this.#finish(effect.code, effect.reason);
  }

  async #sendSnapshot(): Promise<void> {
    if (this.#finished || !this.acceptsBroadcast()) {
      return;
    }
    try {
      const state: RecoveryState = await this.#persistence.readRecoveryState(
        this.#logical.sessionId,
      );
      const snapshot = buildSessionSnapshot(state, {
        reason: "replay_gap",
        sessionStatus: "ready",
        runtimeVersion: this.#runtimeVersion,
        generatedAtMs: Date.now(),
      });
      const enqueued = this.#session.enqueueServerMessage({
        type: "session.snapshot",
        payload: { snapshot },
        sentAtUs: this.#clock.nowUs(),
      });
      if (enqueued.status !== "queued") {
        this.#logger.log("warn", "runtime_snapshot_enqueue_failed", {
          sessionId: this.#logical.sessionId,
          status: enqueued.status,
        });
      }
    } catch (error) {
      this.#logger.log("warn", "runtime_snapshot_failed", {
        sessionId: this.#logical.sessionId,
        error: error instanceof Error ? error.message : "unknown",
      });
      this.#session.enqueueServerMessage({
        type: "error",
        payload: {
          error: {
            code: "internal_error",
            message: "failed to build session snapshot",
            retryable: false,
            traceId: this.#newTraceId(),
          },
        },
        sentAtUs: this.#clock.nowUs(),
      });
    }
    await this.#pump();
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
        resolve("unsent");
      }, SEND_FLUSH_TIMEOUT_MS);
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

  #persistServerSeq(seq: bigint): void {
    const trace: TraceContext = { traceId: this.#newTraceId(), sessionId: this.#logical.sessionId };
    this.#persistence
      .advanceServerSeq({ sessionId: this.#logical.sessionId, latestServerSeq: seq, trace })
      .catch((error: unknown) => {
        this.#logger.log("warn", "runtime_seq_persist_failed", {
          sessionId: this.#logical.sessionId,
          error: error instanceof Error ? error.message : "unknown",
        });
      });
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
    // 导出逻辑状态供同进程重连 resume；并持久化最终 Seq 水位。
    if (this.#logical.control === this) {
      this.#logical.control = null;
      const exported = this.#session.exportLogicalState();
      this.#logical.exportedControlState = exported;
      if (exported.nextSeq - 1n > this.#lastPersistedSeq) {
        this.#lastPersistedSeq = exported.nextSeq - 1n;
        this.#persistServerSeq(exported.nextSeq - 1n);
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
  }

  #newTraceId(): string {
    return crypto.randomUUID().replaceAll("-", "");
  }
}
