import {
  CONTROL_PROTOCOL_VERSION,
  ControlPayloadSchema,
  formatDecimalString,
  parseDecimalString,
} from "@bellis/contracts";
import type {
  ClientControlEnvelope,
  ErrorCode,
  MonotonicClock,
  ServerControlEnvelope,
} from "@bellis/contracts";
import type { LoggerPort } from "@bellis/observability";
import { createNoopLogger } from "@bellis/observability";
import { decodeControlMessage, encodeControlMessage } from "./codec.js";
import type { ControlConnectionState } from "./connection-state.js";
import type { ControlCloseCode, ControlEffect } from "./effects.js";
import { CONTROL_CLOSE_CODES } from "./effects.js";
import { BoundedSendQueue } from "./bounded-send-queue.js";
import type { QueuedSend, SendPriority } from "./bounded-send-queue.js";
import { MessageDeduplicator } from "./message-deduplicator.js";
import { ReplayWindow } from "./replay-window.js";
import type { ReplayMessage, ReplayOutcome } from "./replay-window.js";
import type { TransportFailure } from "../errors.js";

/**
 * Control WebSocket 的服务端会话核心（phase-1-build-guide.md §8.2；P1 文档 §7）。
 *
 * 职责：一条客户端连接的完整入站/出站协议处理——分层解码、连接状态机、
 * 服务端 Seq 分配、ACK 推进、Replay、messageId 去重、幂等键要求、心跳与
 * Hello 超时、Deadline 与有界优先级发送队列。核心不持有 Socket/Timer；
 * 网络写入与持久化通过 Effect 交给 P4 适配器。
 *
 * 逻辑会话（Seq/ACK/Replay Window）与物理连接分离：Seq 不因连接重建归零，
 * P4 在重连时用 exportLogicalState()/resume 恢复基线（持久化恢复由 P2/P4 完成）。
 */

/** 瞬时消息：消耗 Seq 但 P4 不得为其持久化推进记录（P1 文档 §7.2/§7.3）。 */
const TRANSIENT_SERVER_TYPES: ReadonlySet<string> = new Set(["heartbeat.pong", "clock.pong"]);

/** 服务端消息类型的默认优先级（phase-1-build-guide.md §8.3）。 */
const DEFAULT_SERVER_PRIORITIES: Readonly<Record<string, SendPriority>> = {
  error: 1,
  "scene.committed": 1,
  "scene.cancelled": 1,
  "server.hello": 2,
  "server.ready": 2,
  "session.snapshot": 2,
  "heartbeat.pong": 2,
  "clock.pong": 2,
  "media.stream.closed": 2,
  "scene.prepared": 3,
};

/** 默认要求 idempotencyKey 的客户端状态变更消息（连接状态变更类）。 */
const DEFAULT_STATE_CHANGING_CLIENT_TYPES: readonly string[] = [
  "media.stream.open",
  "media.stream.closed",
];

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_HELLO_TIMEOUT_US = 10_000_000n;

/** 各错误码的 retryable 语义（ErrorEnvelope 契约）。 */
const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(["backpressure", "not_ready"]);

export interface ControlHeartbeatOptions {
  /** 期望的客户端心跳间隔（毫秒），会写入 server.hello；默认 30000。 */
  readonly intervalMs?: number;
  /** 入站静默超时（微秒），超过即以 4001 关闭；默认 3 × intervalMs。 */
  readonly timeoutUs?: bigint;
}

export interface ControlSendQueueOptions {
  readonly maxMessages?: number;
  readonly maxBytes?: number;
}

/** 逻辑会话状态：跨连接保留，供 P4 持久化/恢复或进程内重建使用。 */
export interface ControlLogicalState {
  /** 下一个将分配的 Seq（已分配最大 Seq + 1）。 */
  readonly nextSeq: bigint;
  /** 客户端最后一次累计确认的最大连续 Seq。 */
  readonly confirmedAck: bigint;
  /** 保留的 Replay Window 内容（按 Seq 升序）。 */
  readonly replay: readonly ReplayMessage[];
}

export interface ControlSessionOptions {
  readonly sessionId: string;
  readonly runtimeVersion: string;
  /** 用于出站 sentAtUs 默认值；测试注入 VirtualClock 以保持确定性。 */
  readonly clock: MonotonicClock;
  readonly heartbeat?: ControlHeartbeatOptions;
  /** 建连后等待 client.hello 的期限（微秒），默认 10 秒。 */
  readonly helloTimeoutUs?: bigint;
  readonly replayWindowCapacity?: number;
  readonly sendQueue?: ControlSendQueueOptions;
  readonly dedupCapacity?: number;
  /** 单条入站文本消息的字节上限。 */
  readonly maxTextBytes?: number;
  /** 按消息类型覆盖默认发送优先级。 */
  readonly priorityOverrides?: Readonly<Record<string, SendPriority>>;
  /** 要求携带 idempotencyKey 的客户端消息类型。 */
  readonly stateChangingClientTypes?: readonly string[];
  /** 从同一逻辑会话的上一条连接恢复（Seq/ACK/Replay 不归零）。 */
  readonly resume?: ControlLogicalState;
  readonly logger?: LoggerPort;
}

export interface ServerMessageInput {
  readonly type: string;
  readonly payload: unknown;
  readonly messageId?: string;
  readonly trace?: { readonly traceId: string; readonly spanId?: string };
  readonly sentAtUs?: bigint;
  readonly deadlineUs?: bigint;
  readonly priority?: SendPriority;
  /** 可替代低优先级消息的稳定合并键（仅优先级 3/4 生效）。 */
  readonly mergeKey?: string;
  readonly replaceable?: boolean;
}

export type ServerEnqueueResult =
  | { readonly status: "queued" }
  | { readonly status: "invalid"; readonly failure: TransportFailure }
  | { readonly status: "not_ready" }
  | { readonly status: "dropped"; readonly reason: "capacity" }
  | { readonly status: "close_slow_consumer" };

export type AcknowledgeOutcome =
  | { readonly status: "advanced" }
  | { readonly status: "duplicate" }
  | { readonly status: "invalid_ahead" };

export type AcceptedClientMessage =
  | {
      readonly status: "accepted";
      readonly envelope: ClientControlEnvelope;
      readonly ack?: AcknowledgeOutcome;
    }
  | {
      readonly status: "duplicate";
      readonly envelope: ClientControlEnvelope;
    }
  | {
      readonly status: "rejected";
      readonly code: ErrorCode;
      readonly message: string;
      readonly messageId: string | null;
      readonly traceId: string | null;
      /** 该拒绝是否伴随连接关闭（版本不匹配、ACK 超前等协议错误）。 */
      readonly closeInitiated: boolean;
    };

function newMessageId(): string {
  return crypto.randomUUID();
}

function newTraceId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

export class ControlSession {
  readonly #sessionId: string;
  readonly #runtimeVersion: string;
  readonly #clock: MonotonicClock;
  readonly #logger: LoggerPort;
  readonly #heartbeatTimeoutUs: bigint;
  readonly #heartbeatIntervalMs: number;
  readonly #helloTimeoutUs: bigint;
  readonly #maxTextBytes: number | undefined;
  readonly #stateChangingClientTypes: ReadonlySet<string>;
  readonly #priorityOverrides: Readonly<Record<string, SendPriority>>;

  readonly #queue: BoundedSendQueue;
  readonly #window: ReplayWindow;
  readonly #dedup: MessageDeduplicator;

  #state: ControlConnectionState = "awaiting_client_hello";
  #createdAtUs: bigint;
  #lastInboundAtUs: bigint;
  #nextSeq: bigint;
  #confirmedAck: bigint;
  #pendingEffects: ControlEffect[] = [];
  #closePending: { code: ControlCloseCode; reason: string } | null = null;
  #helloReceived = false;

  constructor(options: ControlSessionOptions) {
    this.#sessionId = options.sessionId;
    this.#runtimeVersion = options.runtimeVersion;
    this.#clock = options.clock;
    this.#logger = options.logger ?? createNoopLogger();
    const intervalMs = options.heartbeat?.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    if (!Number.isInteger(intervalMs) || intervalMs <= 0 || intervalMs > 600_000) {
      throw new RangeError("heartbeat intervalMs must be in (0, 600000]");
    }
    this.#heartbeatIntervalMs = intervalMs;
    this.#heartbeatTimeoutUs = options.heartbeat?.timeoutUs ?? BigInt(intervalMs * 3) * 1000n;
    this.#helloTimeoutUs = options.helloTimeoutUs ?? DEFAULT_HELLO_TIMEOUT_US;
    this.#maxTextBytes = options.maxTextBytes;
    this.#stateChangingClientTypes = new Set(
      options.stateChangingClientTypes ?? DEFAULT_STATE_CHANGING_CLIENT_TYPES,
    );
    this.#priorityOverrides = options.priorityOverrides ?? {};

    this.#queue = new BoundedSendQueue({
      ...(options.sendQueue?.maxMessages === undefined
        ? {}
        : { maxMessages: options.sendQueue.maxMessages }),
      ...(options.sendQueue?.maxBytes === undefined
        ? {}
        : { maxBytes: options.sendQueue.maxBytes }),
    });
    this.#window = new ReplayWindow(
      options.replayWindowCapacity === undefined ? {} : { capacity: options.replayWindowCapacity },
    );
    this.#dedup = new MessageDeduplicator(
      options.dedupCapacity === undefined ? {} : { capacity: options.dedupCapacity },
    );

    this.#createdAtUs = this.#clock.nowUs();
    this.#lastInboundAtUs = this.#createdAtUs;
    if (options.resume !== undefined) {
      this.#nextSeq = options.resume.nextSeq;
      this.#confirmedAck = options.resume.confirmedAck;
      for (const message of options.resume.replay) {
        this.#window.append(message);
      }
    } else {
      this.#nextSeq = 1n;
      this.#confirmedAck = 0n;
    }
    // Replay 重放入队受队列容量保护；窗口容量必须不大于队列消息上限，
    // 否则重放路径本身不可行。
    if (this.#window.capacity > this.#queue.limits.maxMessages) {
      throw new RangeError(
        "replay window capacity must not exceed send queue maxMessages (replay path relies on it)",
      );
    }
  }

  get state(): ControlConnectionState {
    return this.#state;
  }

  get confirmedAck(): bigint {
    return this.#confirmedAck;
  }

  /** server.hello 的 Payload（P4 建连后第一条消息）。 */
  helloPayload(): {
    protocolVersion: 1;
    runtimeVersion: string;
    heartbeatIntervalMs: number;
    replayWindowSize: number;
  } {
    return {
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      runtimeVersion: this.#runtimeVersion,
      heartbeatIntervalMs: this.#heartbeatIntervalMs,
      replayWindowSize: this.#window.capacity,
    };
  }

  /** 导出逻辑会话状态（Seq/ACK/Replay），供重连或 P4 持久化。 */
  exportLogicalState(): ControlLogicalState {
    return {
      nextSeq: this.#nextSeq,
      confirmedAck: this.#confirmedAck,
      replay: this.#window.snapshot(),
    };
  }

  /**
   * 入站消息完整处理管线：解码 → 状态机 → Deadline → 去重 → 语义校验
   * → 产生框架无关副作用（Pong/错误入队）。nowUs 由调用方注入。
   */
  acceptClientMessage(input: unknown, nowUs: bigint): AcceptedClientMessage {
    this.#lastInboundAtUs = nowUs;
    const decoded = decodeControlMessage(
      input,
      this.#maxTextBytes === undefined ? {} : { maxTextBytes: this.#maxTextBytes },
    );
    if (!decoded.ok) {
      if (decoded.failure.code === "unsupported_version") {
        // 主版本不匹配：返回错误并关闭（phase-1-build-guide.md §8.2）。
        this.#enqueueError(nowUs, "unsupported_version", decoded.failure.message, null);
        this.#initiateClose(CONTROL_CLOSE_CODES.protocol_error, "unsupported_version");
        return this.#reject("unsupported_version", decoded.failure.message, null, null, true);
      }
      return this.#reject(decoded.failure.code, decoded.failure.message, null, null, false);
    }
    const envelope = decoded.value;
    if (envelope.direction !== "client") {
      return this.#reject(
        "invalid_message",
        "server-direction envelope is not accepted on the inbound path",
        envelope.messageId,
        envelope.trace.traceId,
        false,
      );
    }
    if (envelope.sessionId !== this.#sessionId) {
      return this.#reject(
        "invalid_message",
        "sessionId does not match this connection",
        envelope.messageId,
        envelope.trace.traceId,
        false,
      );
    }

    if (this.#state === "closed") {
      return this.#reject(
        "not_ready",
        "connection is closed",
        envelope.messageId,
        envelope.trace.traceId,
        false,
      );
    }

    // 版本探测：Envelope version 已由 Schema 固定为 1；client.hello 的
    // payload.protocolVersion 才是客户端声明的主版本。
    if (envelope.type === "client.hello") {
      return this.#acceptClientHello(envelope, nowUs);
    }

    if (this.#state === "awaiting_client_hello") {
      return this.#reject(
        "not_ready",
        "business messages are not accepted before client.hello",
        envelope.messageId,
        envelope.trace.traceId,
        false,
      );
    }

    // draining：允许心跳/Clock 与 ACK 收尾，拒绝新的状态变更。
    if (
      this.#state === "draining" &&
      envelope.type !== "heartbeat.ping" &&
      envelope.type !== "clock.ping"
    ) {
      return this.#reject(
        "not_ready",
        "connection is draining; only heartbeat/clock/ack are accepted",
        envelope.messageId,
        envelope.trace.traceId,
        false,
      );
    }

    // Deadline：已过期的消息不产生任何后续副作用（含去重记录）。
    if (envelope.deadlineUs !== undefined && parseDecimalString(envelope.deadlineUs) <= nowUs) {
      return this.#reject(
        "deadline_exceeded",
        "message deadline has passed",
        envelope.messageId,
        envelope.trace.traceId,
        false,
      );
    }

    // 累计 ACK：任意客户端消息可携带；协议错误（超前）直接关闭。
    let ackOutcome: AcknowledgeOutcome | undefined;
    if (envelope.ack !== undefined) {
      ackOutcome = this.acknowledge(parseDecimalString(envelope.ack));
      if (ackOutcome.status === "invalid_ahead") {
        this.#enqueueError(
          nowUs,
          "invalid_message",
          "ack exceeds the latest assigned server seq",
          envelope.trace.traceId,
        );
        this.#initiateClose(CONTROL_CLOSE_CODES.protocol_error, "ack_ahead_of_latest_seq");
        return {
          status: "rejected",
          code: "invalid_message",
          message: "ack exceeds the latest assigned server seq",
          messageId: envelope.messageId,
          traceId: envelope.trace.traceId,
          closeInitiated: true,
        };
      }
    }

    // 状态变更消息必须携带幂等键（跨重启幂等由 P2/P4 完成）。
    // 语义校验失败的消息不进入去重集合（修正后的重试可被处理）。
    if (
      this.#stateChangingClientTypes.has(envelope.type) &&
      envelope.idempotencyKey === undefined
    ) {
      return this.#reject(
        "invalid_message",
        `state-changing message ${envelope.type} requires idempotencyKey`,
        envelope.messageId,
        envelope.trace.traceId,
        false,
      );
    }

    // messageId 去重：重复消息返回稳定结果，不重复执行。
    if (!this.#dedup.add(envelope.messageId)) {
      return { status: "duplicate", envelope };
    }

    // 瞬时消息的服务端响应（错误与 Pong 一律走有界队列，保持单一发送通道）。
    if (envelope.type === "heartbeat.ping") {
      this.#enqueuePong("heartbeat.pong", {}, envelope, nowUs);
    } else if (envelope.type === "clock.ping") {
      const payload = envelope.payload as { c0?: unknown };
      const pongPayload =
        typeof payload.c0 === "string"
          ? { c0: payload.c0, r1: formatDecimalString(nowUs), r2: formatDecimalString(nowUs) }
          : null;
      if (pongPayload === null) {
        return this.#reject(
          "invalid_message",
          "clock.ping payload is missing c0",
          envelope.messageId,
          envelope.trace.traceId,
          false,
        );
      }
      this.#enqueuePong("clock.pong", pongPayload, envelope, nowUs);
    }

    return ackOutcome === undefined
      ? { status: "accepted", envelope }
      : { status: "accepted", envelope, ack: ackOutcome };
  }

  #acceptClientHello(envelope: ClientControlEnvelope, nowUs: bigint): AcceptedClientMessage {
    if (this.#helloReceived || this.#state !== "awaiting_client_hello") {
      return this.#reject(
        "invalid_message",
        "client.hello is only accepted once per connection",
        envelope.messageId,
        envelope.trace.traceId,
        false,
      );
    }
    const payload = envelope.payload as { protocolVersion?: unknown };
    if (payload.protocolVersion !== CONTROL_PROTOCOL_VERSION) {
      this.#enqueueError(
        nowUs,
        "unsupported_version",
        `unsupported protocol version ${String(payload.protocolVersion)}`,
        envelope.trace.traceId,
      );
      this.#initiateClose(CONTROL_CLOSE_CODES.protocol_error, "unsupported_version");
      return {
        status: "rejected",
        code: "unsupported_version",
        message: "client declared an unsupported protocol version",
        messageId: envelope.messageId,
        traceId: envelope.trace.traceId,
        closeInitiated: true,
      };
    }
    const hello = envelope.payload as { lastAck?: unknown };
    let ackOutcome: AcknowledgeOutcome | undefined;
    if (typeof hello.lastAck === "string") {
      const lastAck = parseDecimalString(hello.lastAck);
      ackOutcome = this.acknowledge(lastAck);
      if (ackOutcome.status === "invalid_ahead") {
        this.#enqueueError(
          nowUs,
          "invalid_message",
          "reconnect lastAck exceeds the latest assigned server seq",
          envelope.trace.traceId,
        );
        this.#initiateClose(CONTROL_CLOSE_CODES.protocol_error, "last_ack_ahead_of_latest_seq");
        return {
          status: "rejected",
          code: "invalid_message",
          message: "reconnect lastAck exceeds the latest assigned server seq",
          messageId: envelope.messageId,
          traceId: envelope.trace.traceId,
          closeInitiated: true,
        };
      }
      this.#handleReplay(lastAck, envelope);
    }
    this.#helloReceived = true;
    this.#state = "active";
    return ackOutcome === undefined
      ? { status: "accepted", envelope }
      : { status: "accepted", envelope, ack: ackOutcome };
  }

  #handleReplay(lastAck: bigint, envelope: ClientControlEnvelope): void {
    const outcome = this.#window.replayAfter(lastAck);
    if (outcome.status === "snapshot_required") {
      this.#pendingEffects.push({ kind: "snapshot_required", lastAck });
      return;
    }
    if (outcome.status !== "replay") {
      return;
    }
    // 重放批次整体进入同一优先级车道（取批次内最高优先级），
    // 保证重放保持 Seq 原序，同时仍先于更低优先级的新消息发送。
    const lane = outcome.messages.reduce<SendPriority>(
      (current, message) =>
        Math.min(current, this.#priorityFor(message.envelope.type)) as SendPriority,
      4,
    );
    for (const message of outcome.messages) {
      const queued: QueuedSend = {
        priority: lane,
        text: message.text,
        byteSize: Buffer.byteLength(message.text, "utf8"),
        envelope: message.envelope,
        category: message.envelope.type,
        deadlineUs:
          message.envelope.deadlineUs !== undefined
            ? parseDecimalString(message.envelope.deadlineUs)
            : null,
        mergeKey: null,
        replaceable: false,
      };
      const result = this.#queue.enqueue(queued);
      if (result.status !== "queued") {
        // 重放受窗口容量保护（构造时校验窗口 ≤ 队列容量）；走到这里说明
        // 队列已被并发占满，唯一安全的做法是关闭慢消费者。
        this.#logger.log("warn", "control_replay_enqueue_failed", {
          sessionId: this.#sessionId,
          outcome: result.status,
          messageId: envelope.messageId,
        });
        this.#initiateClose(CONTROL_CLOSE_CODES.send_queue_overflow, "replay_enqueue_overflow");
        return;
      }
    }
  }

  /**
   * 服务端消息出站：校验 Payload → 分配 Seq → 写入 Replay Window →
   * 进入有界优先级队列。Seq 分配不受队列淘汰影响（客户端缺口由 Replay 补）。
   */
  enqueueServerMessage(input: ServerMessageInput): ServerEnqueueResult {
    if (this.#state === "closed") {
      return { status: "not_ready" };
    }
    if (
      this.#state === "awaiting_client_hello" &&
      input.type !== "server.hello" &&
      input.type !== "error"
    ) {
      return { status: "not_ready" };
    }
    if (
      this.#state === "draining" &&
      input.type !== "error" &&
      input.type !== "heartbeat.pong" &&
      input.type !== "clock.pong"
    ) {
      // draining 允许错误与瞬时 Pong 完成收尾，拒绝新的业务出站。
      return { status: "not_ready" };
    }
    const payloadCheck = ControlPayloadSchema.safeParse({
      type: input.type,
      payload: input.payload,
    });
    if (!payloadCheck.success) {
      return {
        status: "invalid",
        failure: {
          code: "invalid_message",
          message: `payload does not match schema for ${input.type}`,
        },
      };
    }
    const seq = this.#nextSeq;
    this.#nextSeq += 1n;
    const messageId = input.messageId ?? newMessageId();
    const sentAtUs = input.sentAtUs ?? this.#clock.nowUs();
    const envelope: ServerControlEnvelope = {
      version: CONTROL_PROTOCOL_VERSION,
      direction: "server",
      type: input.type,
      messageId,
      sessionId: this.#sessionId,
      trace:
        input.trace === undefined
          ? { traceId: newTraceId() }
          : input.trace.spanId === undefined
            ? { traceId: input.trace.traceId }
            : { traceId: input.trace.traceId, spanId: input.trace.spanId },
      sentAtUs: formatDecimalString(sentAtUs),
      ...(input.deadlineUs === undefined
        ? {}
        : { deadlineUs: formatDecimalString(input.deadlineUs) }),
      seq: formatDecimalString(seq),
      // 用 safeParse 收窄后的 payload（JsonValue 兼容），而不是 unknown 入参。
      payload: payloadCheck.data.payload,
    };
    let text: string;
    try {
      text = encodeControlMessage(envelope);
    } catch {
      this.#nextSeq -= 1n;
      return {
        status: "invalid",
        failure: {
          code: "invalid_message",
          message: `outbound envelope for ${input.type} failed validation`,
        },
      };
    }
    const persistable = !TRANSIENT_SERVER_TYPES.has(input.type);
    this.#window.append({ seq, messageId, text, envelope, persistable });
    this.#pendingEffects.push({ kind: "seq_advanced", seq, messageId, persistable });

    const outcome = this.#queue.enqueue({
      priority: input.priority ?? this.#priorityFor(input.type),
      text,
      byteSize: Buffer.byteLength(text, "utf8"),
      envelope,
      category: input.type,
      deadlineUs: input.deadlineUs ?? null,
      mergeKey: input.mergeKey ?? null,
      replaceable:
        input.replaceable === true && (input.priority ?? this.#priorityFor(input.type)) >= 3,
    });
    if (outcome.status === "queued") {
      this.#recordEvictions(outcome.evicted, "capacity");
      return { status: "queued" };
    }
    this.#recordEvictions(outcome.evicted, "capacity");
    if (outcome.status === "dropped") {
      // 被丢弃的入队消息本身也进入淘汰记账（只记类别与数量）。
      this.#pendingEffects.push({
        kind: "dropped",
        category: input.type,
        count: 1,
        reason: "capacity",
      });
      this.#logger.log("warn", "control_send_dropped", {
        sessionId: this.#sessionId,
        type: input.type,
        seq: seq.toString(),
      });
      return { status: "dropped", reason: outcome.reason };
    }
    this.#initiateClose(CONTROL_CLOSE_CODES.send_queue_overflow, "send_queue_overflow");
    return { status: "close_slow_consumer" };
  }

  /**
   * 客户端累计确认。重复（小于已确认值）不倒退内部状态；
   * 超前（大于已分配最大 Seq）属于协议错误。
   */
  acknowledge(seq: bigint): AcknowledgeOutcome {
    const latest = this.#window.latestAssignedSeq();
    if (seq > latest) {
      return { status: "invalid_ahead" };
    }
    if (seq <= this.#confirmedAck) {
      return { status: "duplicate" };
    }
    this.#confirmedAck = seq;
    this.#window.pruneThrough(seq);
    return { status: "advanced" };
  }

  /** 重连重放决策（对 ReplayWindow 的直接暴露，P4/测试可用）。 */
  replayAfter(lastAck: bigint): ReplayOutcome {
    return this.#window.replayAfter(lastAck);
  }

  /**
   * 会话心跳：由 P4 适配器周期调用（时间注入）。产出顺序：
   * 已积累的持久化/淘汰 Effect → Hello/心跳超时判定 → 过期剪枝 →
   * 队列排空（send Effect）→ 排空后的 close Effect。
   */
  tick(nowUs: bigint): readonly ControlEffect[] {
    const effects: ControlEffect[] = this.#pendingEffects;
    this.#pendingEffects = [];
    if (this.#state === "closed") {
      return effects;
    }
    if (
      this.#closePending === null &&
      this.#state === "awaiting_client_hello" &&
      nowUs - this.#createdAtUs > this.#helloTimeoutUs
    ) {
      this.#initiateClose(CONTROL_CLOSE_CODES.hello_timeout, "hello_timeout");
    }
    if (
      this.#closePending === null &&
      this.#state === "active" &&
      nowUs - this.#lastInboundAtUs > this.#heartbeatTimeoutUs
    ) {
      this.#initiateClose(CONTROL_CLOSE_CODES.heartbeat_timeout, "heartbeat_timeout");
    }
    const expired = this.#queue.pruneExpired(nowUs);
    if (expired.length > 0) {
      effects.push(...this.#droppedEffects(expired, "expired"));
    }
    for (const message of this.#queue.drain()) {
      effects.push({
        kind: "send",
        text: message.text,
        byteSize: message.byteSize,
        envelope: message.envelope,
      });
    }
    if (this.#closePending !== null && this.#queue.messageCount() === 0) {
      const pending = this.#closePending;
      this.#closePending = null;
      this.#state = "closed";
      effects.push({ kind: "close", code: pending.code, reason: pending.reason });
      this.#logger.log("info", "control_session_closed", {
        sessionId: this.#sessionId,
        code: pending.code,
        reason: pending.reason,
      });
    }
    return effects;
  }

  /** 优雅关闭：进入 draining，排空已入队消息后以给定关闭码关闭。 */
  close(reason: string, code: ControlCloseCode = CONTROL_CLOSE_CODES.normal): void {
    if (this.#state === "closed") {
      return;
    }
    this.#state = "draining";
    this.#initiateClose(code, reason);
  }

  #priorityFor(type: string): SendPriority {
    return this.#priorityOverrides[type] ?? DEFAULT_SERVER_PRIORITIES[type] ?? 3;
  }

  #initiateClose(code: ControlCloseCode, reason: string): void {
    if (this.#state === "closed" || this.#closePending !== null) {
      return;
    }
    this.#state =
      this.#state === "active" || this.#state === "awaiting_client_hello"
        ? "draining"
        : this.#state;
    this.#closePending = { code, reason };
  }

  #reject(
    code: ErrorCode,
    message: string,
    messageId: string | null,
    traceId: string | null,
    closeInitiated: boolean,
  ): AcceptedClientMessage {
    return { status: "rejected", code, message, messageId, traceId, closeInitiated };
  }

  #enqueueError(nowUs: bigint, code: ErrorCode, message: string, traceId: string | null): void {
    this.enqueueServerMessage({
      type: "error",
      payload: {
        error: {
          code,
          message,
          retryable: RETRYABLE_CODES.has(code),
          traceId: traceId ?? newTraceId(),
        },
      },
      ...(traceId === null ? {} : { trace: { traceId } }),
      sentAtUs: nowUs,
    });
  }

  #enqueuePong(
    type: "heartbeat.pong" | "clock.pong",
    payload: Record<string, unknown>,
    request: ClientControlEnvelope,
    nowUs: bigint,
  ): void {
    this.enqueueServerMessage({
      type,
      payload,
      trace: { traceId: request.trace.traceId },
      sentAtUs: nowUs,
    });
  }

  #recordEvictions(evicted: readonly QueuedSend[], reason: "capacity" | "merged"): void {
    if (evicted.length === 0) {
      return;
    }
    this.#pendingEffects.push(...this.#droppedEffects(evicted, reason));
  }

  #droppedEffects(
    messages: readonly QueuedSend[],
    reason: "capacity" | "merged" | "expired",
  ): readonly ControlEffect[] {
    const counts = new Map<string, number>();
    for (const message of messages) {
      counts.set(message.category, (counts.get(message.category) ?? 0) + 1);
    }
    return [...counts.entries()].map(([category, count]) => ({
      kind: "dropped" as const,
      category,
      count,
      reason,
    }));
  }
}
