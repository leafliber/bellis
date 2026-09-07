/* StageSocket Port 以 on* setter 为接口（自研 Port，非 DOM 事件）。 */
/* oxlint-disable unicorn/prefer-add-event-listener */
import {
  CLIENT_TO_SERVER_MESSAGE_TYPES,
  type ControlEnvelope,
  type JsonValue,
  type MonotonicClock,
} from "@bellis/contracts";
import {
  ClockOffsetEstimator,
  decodeControlMessage,
  encodeControlMessage,
} from "@bellis/transport/browser";
import type { StageSocket } from "./stage-socket.js";

/**
 * Stage Control 客户端（docs/archive/phase-2/development-guide.md §7）。
 *
 * 职责：Control WebSocket 连接生命周期——hello 握手（含 resume lastAck）、
 * ACK 累计确认（搭载心跳）、心跳、时钟采样与偏移估计（≥3 个合格样本进入
 * clock_ready，重连后重新校准）、Stage 能力上报、服务端演出命令分发，
 * 以及意外断线后的确定性退避重连。
 *
 * 边界约束：
 * - 不直接持有浏览器 WebSocket：经注入的 StageSocket Port；
 * - 所有循环（心跳/采样/超时）由注入时钟的 sleepUntil 驱动，受 AbortSignal
 *   控制，close() 后零残留；
 * - 入站消息一律经 decodeControlMessage 校验（协议 §1），失败计入
 *   协议错误计数并按策略重连，不崩溃。
 */

export type StageControlState =
  | "idle"
  | "connecting"
  | "hello_wait"
  | "active"
  | "reconnect_wait"
  | "closed";

export interface StageControlClientOptions {
  readonly url: string;
  readonly sessionId: string;
  readonly socketFactory: () => StageSocket;
  readonly clock: MonotonicClock;
  /** 消息/帧 ID 源（生产为 crypto UUID；测试注入确定性源）。 */
  readonly nextMessageId: () => string;
  readonly capabilities: JsonValue;
  readonly heartbeatIntervalMs: number;
  /** 进入 clock_ready 所需的合格样本数（默认 3）。 */
  readonly clockSamplesRequired: number;
  /** 重连退避基数（毫秒，默认 500，×2^n 封顶 maxBackoffMs）。 */
  readonly reconnectBaseMs: number;
  readonly reconnectMaxMs: number;
  readonly onEvent: (event: StageControlEvent) => void;
}

export type StageControlEvent =
  | { readonly type: "state"; readonly state: StageControlState }
  | { readonly type: "clock_ready" }
  | { readonly type: "clock_sample"; readonly samples: number }
  | {
      readonly type: "server_message";
      readonly envelope: ControlEnvelope;
    }
  | { readonly type: "protocol_error"; readonly code: string; readonly message: string };

interface Loops {
  heartbeat: AbortController;
  clockSampling: AbortController;
  watchdog: AbortController;
}

export class StageControlClient {
  readonly #options: StageControlClientOptions;
  readonly #estimator = new ClockOffsetEstimator();
  #state: StageControlState = "idle";
  #socket: StageSocket | null = null;
  #loops: Loops | null = null;
  #closedByUser = false;
  #lastProcessedSeq = 0n;
  #lastServerSeq = 0n;
  #clockSamples = 0;
  #clockReady = false;
  #helloTimeoutUs = 10_000_000n;
  #reconnectAttempt = 0;

  constructor(options: StageControlClientOptions) {
    this.#options = options;
  }

  get state(): StageControlState {
    return this.#state;
  }

  get clockReady(): boolean {
    return this.#clockReady;
  }

  get clockEstimate(): { roundTripUs: bigint; runtimeOffsetUs: bigint } | null {
    return this.#estimator.current();
  }

  get lastProcessedSeq(): bigint {
    return this.#lastProcessedSeq;
  }

  /** 连接（首次或重连由内部驱动；外部只在启动时调用一次）。 */
  async connect(): Promise<void> {
    if (this.#state === "closed") {
      throw new Error("stage_control_client_closed");
    }
    this.#setState("connecting");
    const socket = this.#options.socketFactory();
    this.#socket = socket;
    socket.onopen = () => {
      this.#setState("hello_wait");
      this.#armHelloTimeout();
      // client.hello 必须在 open 后立即发送，不等 server.hello：resume
      // 连接在收到 client.hello 前保留一切出站（含 server.hello，P1
      // ControlSession holdNewSends），先等 server.hello 会与 Runtime
      // 互相等待直至 hello 超时（4004）。
      this.#sendHello();
    };
    socket.onmessage = (data) => this.#onSocketMessage(data);
    socket.onclose = (code, reason) => {
      void this.#onSocketClose(code, reason);
    };
    socket.onerror = () => {
      // onclose 随后到达；此处不重复处理。
    };
  }

  /** 发送客户端消息（自动携带累计 ack；state-changing 消息由调用方给幂等键）。 */
  sendClient(
    type: string,
    payload: JsonValue,
    options?: { readonly idempotencyKey?: string; readonly deadlineUs?: bigint },
  ): boolean {
    if (this.#state !== "active" || this.#socket === null) {
      return false;
    }
    if (
      !(CLIENT_TO_SERVER_MESSAGE_TYPES as readonly string[]).includes(type) &&
      type !== "media.stream.closed"
    ) {
      this.#emit({
        type: "protocol_error",
        code: "invalid_message",
        message: `stage cannot send ${type}`,
      });
      return false;
    }
    const envelope = {
      version: 1,
      direction: "client",
      type,
      messageId: this.#options.nextMessageId(),
      sessionId: this.#options.sessionId,
      trace: { traceId: this.#traceId() },
      sentAtUs: this.#options.clock.nowUs().toString(),
      ...(options?.deadlineUs === undefined ? {} : { deadlineUs: options.deadlineUs.toString() }),
      ...(this.#lastProcessedSeq === 0n ? {} : { ack: this.#lastProcessedSeq.toString() }),
      ...(options?.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
      payload,
    };
    try {
      this.#socket.send(encodeControlMessage(envelope as never));
      return true;
    } catch (error) {
      this.#emit({
        type: "protocol_error",
        code: "invalid_message",
        message: `outbound ${type} rejected: ${String(error)}`,
      });
      return false;
    }
  }

  /** 主动关闭：停心跳/采样循环并以 1000 关闭 socket；不再重连。 */
  close(reason = "stage_client_close"): void {
    this.#closedByUser = true;
    this.#stopLoops();
    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null) {
      socket.onclose = null;
      socket.close(1000, reason);
    }
    this.#setState("closed");
  }

  #setState(state: StageControlState): void {
    if (this.#state === state) {
      return;
    }
    this.#state = state;
    this.#emit({ type: "state", state });
  }

  #emit(event: StageControlEvent): void {
    this.#options.onEvent(event);
  }

  #traceId(): string {
    // 会话级稳定 traceId：Stage 用连接生命周期内一致的 trace 根。
    return (this.#sessionTraceId ??= this.#options.nextMessageId().replace(/-/g, "").slice(0, 32));
  }

  #sessionTraceId: string | null = null;

  #sendHello(): void {
    const hello = {
      version: 1,
      direction: "client",
      type: "client.hello",
      messageId: this.#options.nextMessageId(),
      sessionId: this.#options.sessionId,
      trace: { traceId: this.#traceId() },
      sentAtUs: this.#options.clock.nowUs().toString(),
      ...(this.#lastProcessedSeq === 0n ? {} : { ack: this.#lastProcessedSeq.toString() }),
      payload: { protocolVersion: 1, clientType: "stage" },
    } as never;
    try {
      this.#socket?.send(encodeControlMessage(hello));
    } catch {
      this.#reconnect("hello_send_failed");
    }
  }

  #armHelloTimeout(): void {
    const timeout = new AbortController();
    void this.#options.clock
      .sleepUntil(this.#options.clock.nowUs() + this.#helloTimeoutUs, timeout.signal)
      .then(() => {
        if (this.#state === "hello_wait") {
          this.#reconnect("hello_timeout");
        }
      })
      .catch(() => {});
    this.#helloTimeoutController = timeout;
  }

  #helloTimeoutController: AbortController | null = null;

  #onSocketMessage(data: string | Uint8Array): void {
    if (typeof data !== "string") {
      this.#emit({
        type: "protocol_error",
        code: "invalid_message",
        message: "control channel received a binary frame",
      });
      return;
    }
    const decoded = decodeControlMessage(data);
    if (!decoded.ok) {
      this.#emit({
        type: "protocol_error",
        code: decoded.failure.code,
        message: decoded.failure.message,
      });
      return;
    }
    const envelope = decoded.value;
    this.#watchdogFeed?.();
    if (envelope.direction !== "server") {
      this.#emit({
        type: "protocol_error",
        code: "invalid_message",
        message: "server channel received a client-direction envelope",
      });
      return;
    }
    const seq = BigInt(envelope.seq);
    // 服务端 Seq 严格递增：线上缺口在单连接内属协议违例（WS 有序可靠）。
    if (seq <= this.#lastServerSeq) {
      this.#emit({
        type: "protocol_error",
        code: "invalid_message",
        message: `server seq regressed (${seq} <= ${this.#lastServerSeq})`,
      });
      this.#reconnect("seq_regression");
      return;
    }
    this.#lastServerSeq = seq;

    switch (envelope.type) {
      case "server.hello": {
        this.#helloTimeoutController?.abort(new Error("hello_received"));
        this.#helloTimeoutController = null;
        // client.hello 已在 open 时发出（resume 语义，见 connect）。
        this.#setState("active");
        this.#startLoops();
        this.sendClient("stage.capabilities", { capabilities: this.#options.capabilities });
        return;
      }
      case "heartbeat.pong":
        // 心跳回应：仅推进 seq；watchdog 由任意入站消息喂食。
        break;
      case "clock.pong": {
        const payload = envelope.payload as { c0?: unknown; r1?: unknown; r2?: unknown };
        if (
          typeof payload.c0 === "string" &&
          typeof payload.r1 === "string" &&
          typeof payload.r2 === "string"
        ) {
          const pending = this.#pendingClockPings.get(payload.c0);
          if (pending !== undefined) {
            this.#pendingClockPings.delete(payload.c0);
            const estimate = this.#estimator.add({
              c0: BigInt(payload.c0),
              r1: BigInt(payload.r1),
              r2: BigInt(payload.r2),
              c3: this.#options.clock.nowUs(),
            });
            if (estimate !== null) {
              this.#clockSamples += 1;
              this.#emit({ type: "clock_sample", samples: this.#clockSamples });
              if (!this.#clockReady && this.#clockSamples >= this.#options.clockSamplesRequired) {
                this.#clockReady = true;
                this.#emit({ type: "clock_ready" });
              }
            }
          }
        }
        break;
      }
      default:
        break;
    }
    this.#lastProcessedSeq = seq;
    this.#emit({ type: "server_message", envelope });
  }

  readonly #pendingClockPings = new Map<string, bigint>();

  async #onSocketClose(code: number, reason: string): Promise<void> {
    this.#stopLoops();
    this.#socket = null;
    if (this.#closedByUser || this.#state === "closed") {
      return;
    }
    void code;
    void reason;
    this.#reconnect("socket_closed");
  }

  #reconnect(reason: string): void {
    this.#stopLoops();
    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null) {
      socket.onclose = null;
      socket.close(4001, reason);
    }
    // 重连即新连接代际：时钟估计清空重新校准（§7.3）。
    this.#estimator.reset();
    this.#clockSamples = 0;
    this.#clockReady = false;
    this.#setState("reconnect_wait");
    const backoffMs = Math.min(
      this.#options.reconnectBaseMs * 2 ** this.#reconnectAttempt,
      this.#options.reconnectMaxMs,
    );
    this.#reconnectAttempt += 1;
    const timer = new AbortController();
    void this.#options.clock
      .sleepUntil(this.#options.clock.nowUs() + BigInt(backoffMs) * 1000n, timer.signal)
      .then(
        () => {
          if (!this.#closedByUser && this.#state === "reconnect_wait") {
            void this.connect();
          }
        },
        () => {},
      );
    this.#reconnectTimer = timer;
  }

  #reconnectTimer: AbortController | null = null;

  #startLoops(): void {
    this.#stopLoops();
    const heartbeat = new AbortController();
    const clockSampling = new AbortController();
    const watchdog = new AbortController();
    this.#loops = { heartbeat, clockSampling, watchdog };
    void this.#heartbeatLoop(heartbeat.signal);
    void this.#clockLoop(clockSampling.signal);
    void this.#watchdogLoop(watchdog.signal);
  }

  #stopLoops(): void {
    this.#helloTimeoutController?.abort(new Error("closed"));
    this.#helloTimeoutController = null;
    this.#reconnectTimer?.abort(new Error("closed"));
    this.#reconnectTimer = null;
    if (this.#loops !== null) {
      this.#loops.heartbeat.abort(new Error("closed"));
      this.#loops.clockSampling.abort(new Error("closed"));
      this.#loops.watchdog.abort(new Error("closed"));
      this.#loops = null;
    }
  }

  async #heartbeatLoop(signal: AbortSignal): Promise<void> {
    const intervalUs = BigInt(this.#options.heartbeatIntervalMs) * 1000n;
    try {
      for (;;) {
        await this.#options.clock.sleepUntil(this.#options.clock.nowUs() + intervalUs, signal);
        if (this.#state !== "active") {
          return;
        }
        this.sendClient("heartbeat.ping", {});
      }
    } catch {
      // abort：循环结束。
    }
  }

  async #clockLoop(signal: AbortSignal): Promise<void> {
    // ready 前密集采样（1s），ready 后维持校准（heartbeat 间隔的一半）。
    const denseUs = 1_000_000n;
    const steadyUs = (BigInt(this.#options.heartbeatIntervalMs) * 1000n) / 2n;
    try {
      for (;;) {
        const intervalUs = this.#clockReady ? steadyUs : denseUs;
        await this.#options.clock.sleepUntil(this.#options.clock.nowUs() + intervalUs, signal);
        if (this.#state !== "active") {
          return;
        }
        const c0 = this.#options.clock.nowUs();
        const c0Text = c0.toString();
        this.#pendingClockPings.set(c0Text, c0);
        // 超时未回的 ping 丢弃（防有界集合泄漏）。
        if (this.#pendingClockPings.size > 16) {
          const oldest = this.#pendingClockPings.keys().next().value;
          if (oldest !== undefined) {
            this.#pendingClockPings.delete(oldest);
          }
        }
        this.sendClient("clock.ping", { c0: c0Text });
      }
    } catch {
      // abort：循环结束。
    }
  }

  async #watchdogLoop(signal: AbortSignal): Promise<void> {
    const timeoutUs = BigInt(this.#options.heartbeatIntervalMs * 3) * 1000n;
    let lastInbound = this.#options.clock.nowUs();
    this.#watchdogFeed = () => {
      lastInbound = this.#options.clock.nowUs();
    };
    try {
      for (;;) {
        await this.#options.clock.sleepUntil(lastInbound + timeoutUs, signal);
        if (this.#options.clock.nowUs() - lastInbound >= timeoutUs) {
          this.#reconnect("heartbeat_timeout");
          return;
        }
        // 目标已过但喂食过：立即进入下一轮（sleepUntil 已过目标）。
      }
    } catch {
      // abort：循环结束。
    } finally {
      this.#watchdogFeed = null;
    }
  }

  #watchdogFeed: (() => void) | null = null;
}
