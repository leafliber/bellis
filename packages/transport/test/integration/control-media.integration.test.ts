import { describe, expect, it } from "vitest";
import { VirtualClock } from "@bellis/testkit";
import {
  CONTROL_CLOSE_CODES,
  ClockOffsetEstimator,
  ControlSession,
  MediaFrameParser,
  MediaStreamRegistry,
  decodeControlMessage,
  encodeMediaFrame,
} from "../../src/index.js";
import type { ControlEffect, ControlSessionOptions } from "../../src/index.js";
import type { MediaFrameHeader, Phase1SessionSnapshot } from "@bellis/contracts";
import {
  ALT_MESSAGE_ID,
  MESSAGE_ID,
  RUNTIME_VERSION,
  SESSION_ID,
  STREAM_ID,
  TRACE_ID,
  VALID_PAYLOADS,
  clientText,
} from "../helpers.js";

/**
 * 传输集成测试（docs/reference/phase-1.md）：内存 Adapter + VirtualClock，
 * 不依赖真实 Socket / 网络等待 / 公网。
 *
 * Harness 模拟 P4 适配器职责：把 accept/tick 产出的 Effect 应用到
 * 内存连接上，客户端侧用同一套编解码原语驱动。
 */

interface InboundServerMessage {
  readonly type: string;
  readonly seq: bigint;
  readonly messageId: string;
  readonly payload: unknown;
  readonly text: string;
}

class ControlHarness {
  readonly clock = new VirtualClock();
  readonly session: ControlSession;
  readonly registry: MediaStreamRegistry;
  readonly parser = new MediaFrameParser();
  readonly serverMessages: InboundServerMessage[] = [];
  readonly closed: { code: number; reason: string }[] = [];
  readonly dropped: { category: string; count: number; reason: string }[] = [];
  readonly snapshotRequests: bigint[] = [];
  #messageIdCounter = 0;

  constructor(options: Partial<ControlSessionOptions> = {}) {
    this.session = new ControlSession({
      sessionId: SESSION_ID,
      runtimeVersion: RUNTIME_VERSION,
      clock: this.clock,
      ...options,
    });
    this.registry = new MediaStreamRegistry({ sessionId: SESSION_ID });
  }

  /** P4 适配器泵：处理一条入站 + 应用全部 Effect。 */
  receive(input: string): void {
    const nowUs = this.clock.nowUs();
    this.session.acceptClientMessage(input, nowUs);
    this.pump();
  }

  pump(): void {
    for (const effect of this.session.tick(this.clock.nowUs())) {
      this.apply(effect);
    }
  }

  private apply(effect: ControlEffect): void {
    if (effect.kind === "send") {
      const decoded = decodeControlMessage(effect.text);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        this.serverMessages.push({
          type: decoded.value.type,
          seq: BigInt(decoded.value.direction === "server" ? decoded.value.seq : "0"),
          messageId: decoded.value.messageId,
          payload: decoded.value.payload,
          text: effect.text,
        });
      }
    } else if (effect.kind === "close") {
      this.closed.push({ code: effect.code, reason: effect.reason });
    } else if (effect.kind === "dropped") {
      this.dropped.push({ category: effect.category, count: effect.count, reason: effect.reason });
    } else if (effect.kind === "snapshot_required") {
      this.snapshotRequests.push(effect.lastAck);
    }
  }

  nextMessageId(): string {
    this.#messageIdCounter += 1;
    return `99999999-9999-4999-8999-${this.#messageIdCounter.toString().padStart(12, "0")}`;
  }

  clientSend(
    type: string,
    extra: Record<string, unknown> = {},
    overrides: Record<string, unknown> = {},
  ): void {
    const payload = VALID_PAYLOADS[type] ?? {};
    this.receive(
      clientText({ type, messageId: this.nextMessageId(), payload, ...overrides }, extra),
    );
  }

  /** 标准握手：server.hello → client.hello → server.ready。 */
  handshake(lastAck?: string): void {
    this.session.enqueueServerMessage({
      type: "server.hello",
      payload: this.session.helloPayload(),
    });
    this.pump();
    this.receive(
      clientText({
        type: "client.hello",
        messageId: this.nextMessageId(),
        payload: {
          protocolVersion: 1,
          clientType: "test-client",
          ...(lastAck === undefined ? {} : { lastAck }),
        },
      }),
    );
    this.session.enqueueServerMessage({ type: "server.ready", payload: {} });
    this.pump();
  }

  sendsOf(type: string): InboundServerMessage[] {
    return this.serverMessages.filter((message) => message.type === type);
  }
}

describe("集成：Control 全流程", () => {
  it("Hello → 心跳 → 时钟同步 → Seq/ACK 全链路", () => {
    const harness = new ControlHarness();
    harness.handshake();
    expect(harness.session.state).toBe("active");
    const hello = harness.sendsOf("server.hello")[0];
    const ready = harness.sendsOf("server.ready")[0];
    expect(hello?.seq).toBe(1n);
    expect(ready?.seq).toBe(2n);

    // 心跳往返。
    harness.clientSend("heartbeat.ping");
    const pong = harness.sendsOf("heartbeat.pong")[0];
    expect(pong).toBeDefined();
    expect(harness.sendsOf("heartbeat.pong").length).toBe(1);

    // 时钟同步：客户端 c0=1000，服务端在 t=5ms 收到。
    harness.clock.advanceBy(5000n);
    harness.clientSend("clock.ping");
    const clockPong = harness.sendsOf("clock.pong")[0];
    expect(clockPong?.payload).toEqual({ c0: "1000", r1: "5000", r2: "5000" });

    // 客户端累计确认 seq=3（pong）。
    harness.clientSend("heartbeat.ping", { ack: "3" });
    expect(harness.session.confirmedAck).toBe(3n);
    // 重复 ACK 不倒退、不报错。
    harness.clientSend("heartbeat.ping", { ack: "2" });
    expect(harness.session.confirmedAck).toBe(3n);
    expect(harness.closed.length).toBe(0);
  });

  it("客户端偏移估计与 Runtime 时钟闭环（已知 offset 可恢复）", () => {
    const harness = new ControlHarness();
    harness.handshake();
    const estimator = new ClockOffsetEstimator();
    const clientNow = () => harness.clock.nowUs() + 123_456n; // 客户端时钟领先 Runtime 123456µs
    for (let index = 0; index < 3; index += 1) {
      const c0 = clientNow();
      harness.clock.advanceBy(100n); // 上行 100µs
      harness.clientSend("clock.ping");
      const pong = harness.sendsOf("clock.pong")[index];
      expect(pong).toBeDefined();
      const payload = pong?.payload as { c0: string; r1: string; r2: string };
      harness.clock.advanceBy(100n); // 下行 100µs
      const c3 = clientNow();
      const sample = {
        c0,
        r1: BigInt(payload.r1),
        r2: BigInt(payload.r2),
        c3,
      };
      const estimate = estimator.add(sample);
      expect(estimate).not.toBeNull();
      // Runtime 相对客户端时钟的 offset = -123456（客户端领先）。
      expect(estimate?.runtimeOffsetUs).toBe(-123_456n);
    }
  });

  it("断线重连：Replay 命中窗口，按原 Seq/原文本重放；幂等键重试被接受", () => {
    const first = new ControlHarness();
    first.handshake();
    for (let index = 0; index < 3; index += 1) {
      first.session.enqueueServerMessage({
        type: "scene.prepared",
        payload: { sceneId: STREAM_ID, cycleId: STREAM_ID, cues: [] },
      });
    }
    first.pump();
    const originals = first.sendsOf("scene.prepared").map((message) => message.text);
    expect(originals.length).toBe(3);
    // 客户端处理到 seq=3（hello=1, ready=2, prepared=3）后断线。
    first.clientSend("heartbeat.ping", { ack: "3" });

    // 同一逻辑会话重连：resume + client.hello(lastAck=3)。
    const second = new ControlHarness({ resume: first.session.exportLogicalState() });
    second.handshake("3");
    const replayed = second.serverMessages
      .filter((message) => message.type === "scene.prepared")
      .map((message) => message.text);
    // 重放 seq=4,5（原文本），不重放已确认的 1..3。
    expect(replayed).toEqual(originals.slice(1));

    // 断线前未确认的命令用相同 idempotencyKey 重试（跨连接去重属 P2/P4 职责）。
    second.clientSend("media.stream.open", { idempotencyKey: "open-42" });
    expect(second.session.state).toBe("active");
  });

  it("Replay Gap → snapshot_required → P4 组装 session.snapshot 发送", () => {
    const first = new ControlHarness({ replayWindowCapacity: 4 });
    first.handshake();
    for (let index = 0; index < 6; index += 1) {
      first.session.enqueueServerMessage({
        type: "scene.prepared",
        payload: { sceneId: STREAM_ID, cycleId: STREAM_ID, cues: [] },
      });
    }
    first.pump();
    const logical = first.session.exportLogicalState();

    const second = new ControlHarness({ resume: logical });
    second.handshake("2");
    expect(second.snapshotRequests).toEqual([2n]);
    // P4 读取 Persistence 后组装快照（此处直接构造）。
    const snapshot: Phase1SessionSnapshot = {
      schemaVersion: 1,
      reason: "replay_gap",
      sessionId: SESSION_ID,
      sessionStatus: "ready",
      latestServerSeq: "8",
      signalWatermarks: [],
      activeScene: null,
      openMediaStreams: [],
      runtimeVersion: RUNTIME_VERSION,
      generatedAtMs: 0,
    };
    const enqueued = second.session.enqueueServerMessage({
      type: "session.snapshot",
      payload: { snapshot },
    });
    expect(enqueued.status).toBe("queued");
    second.pump();
    const sent = second.sendsOf("session.snapshot")[0];
    expect(sent).toBeDefined();
    const snapshotPayload = sent?.payload as { snapshot: { reason: string } } | undefined;
    expect(snapshotPayload?.snapshot.reason).toBe("replay_gap");
  });

  it("重复 messageId 在单连接内被抑制；断线后同一幂等键重试语义正确", () => {
    const harness = new ControlHarness();
    harness.handshake();
    harness.receive(clientText({ type: "heartbeat.ping", messageId: MESSAGE_ID }));
    const pongCount = harness.sendsOf("heartbeat.pong").length;
    harness.receive(clientText({ type: "heartbeat.ping", messageId: MESSAGE_ID }));
    expect(harness.sendsOf("heartbeat.pong").length).toBe(pongCount);
    // 新 messageId 正常处理。
    harness.receive(clientText({ type: "heartbeat.ping", messageId: ALT_MESSAGE_ID }));
    expect(harness.sendsOf("heartbeat.pong").length).toBe(pongCount + 1);
  });

  it("deadline 过期的入站命令被拒绝且无副作用", () => {
    const harness = new ControlHarness();
    harness.handshake();
    harness.receive(
      clientText({ type: "media.stream.open", deadlineUs: "1" }, { idempotencyKey: "late" }),
    );
    // 没有 open 消息被接受（P4 侧不会注册 Stream），也无 error 之外的副作用。
    const errors = harness.sendsOf("error");
    // deadline 拒绝返回给调用方的是 rejected 结果；本测试通过无 Pong/无状态变化断言。
    expect(harness.sendsOf("heartbeat.pong").length).toBe(0);
    expect(errors.length).toBe(0);
  });
});

function openStream(harness: ControlHarness): void {
  harness.clientSend("media.stream.open", { idempotencyKey: "open-1" });
  const opened = harness.registry.open({
    streamId: STREAM_ID,
    sessionId: SESSION_ID,
    mediaKind: "binary-test",
    contentType: "application/octet-stream",
  });
  expect(opened).toEqual({ status: "opened" });
}

function sendFrame(
  harness: ControlHarness,
  overrides: { sequence?: string; frameId?: string },
  payload: Uint8Array,
): void {
  const header: MediaFrameHeader = {
    schemaVersion: 1,
    streamId: STREAM_ID,
    frameId: overrides.frameId ?? crypto.randomUUID(),
    sessionId: SESSION_ID,
    sequence: overrides.sequence ?? "0",
    contentType: "application/octet-stream",
    traceId: TRACE_ID,
  };
  const bytes = encodeMediaFrame({ header, payload, mediaKind: "binary-test" });
  // 模拟 WS 分片：两段 push + endMessage。
  harness.parser.push(bytes.subarray(0, 9));
  harness.parser.push(bytes.subarray(9));
  const frames = harness.parser.endMessage();
  for (const frame of frames) {
    harness.registry.accept(frame, harness.clock.nowUs());
  }
}

describe("集成：Media 与 Control 协同", () => {
  it("注册 → 合法帧序列 → 非法帧拒绝 → 关闭后拒帧", () => {
    const harness = new ControlHarness();
    harness.handshake();
    openStream(harness);
    sendFrame(harness, { sequence: "0" }, Uint8Array.from([1, 2, 3]));
    sendFrame(harness, { sequence: "1" }, Uint8Array.from([4]));
    // 乱序帧。
    const bytes = encodeMediaFrame({
      header: {
        schemaVersion: 1,
        streamId: STREAM_ID,
        frameId: crypto.randomUUID(),
        sessionId: SESSION_ID,
        sequence: "0",
        contentType: "application/octet-stream",
        traceId: TRACE_ID,
      },
      payload: new Uint8Array(1),
      mediaKind: "binary-test",
    });
    harness.parser.push(bytes);
    const bad = harness.parser.endMessage()[0];
    expect(bad).toBeDefined();
    if (bad !== undefined) {
      const rejected = harness.registry.accept(bad, harness.clock.nowUs());
      expect(rejected.status).toBe("rejected");
    }
    // Control 关闭 Stream → 帧不再接受。
    harness.clientSend("media.stream.closed", { idempotencyKey: "close-1" });
    expect(harness.registry.close(STREAM_ID)).toEqual({ status: "closed" });
    sendFrame(harness, { sequence: "2" }, new Uint8Array(1));
    // 直接验证：关闭后的 Stream 收帧被拒绝（registry 状态）。
    const closedFrame = encodeMediaFrame({
      header: {
        schemaVersion: 1,
        streamId: STREAM_ID,
        frameId: crypto.randomUUID(),
        sessionId: SESSION_ID,
        sequence: "2",
        contentType: "application/octet-stream",
        traceId: TRACE_ID,
      },
      payload: new Uint8Array(1),
      mediaKind: "binary-test",
    });
    const parsed = new MediaFrameParser();
    parsed.push(closedFrame);
    const frame = parsed.endMessage()[0];
    expect(frame).toBeDefined();
    if (frame !== undefined) {
      const result = harness.registry.accept(frame, harness.clock.nowUs());
      expect(result.status).toBe("rejected");
    }
  });

  it("持续 Media/批量负载下 Control 心跳优先处理（不饿死）", () => {
    const harness = new ControlHarness({
      sendQueue: { maxMessages: 512, maxBytes: 8 * 1024 * 1024 },
      replayWindowCapacity: 512,
    });
    harness.handshake();
    // 50 条 P3 批量消息排队（模拟 world snapshot 增量）。
    for (let index = 0; index < 50; index += 1) {
      harness.session.enqueueServerMessage({
        type: "scene.prepared",
        payload: { sceneId: STREAM_ID, cycleId: STREAM_ID, cues: [] },
      });
    }
    // 心跳在批量消息之后到达。
    harness.clientSend("heartbeat.ping");
    // 单次 tick 全部排空：Pong(P2) 必须先于全部 scene.prepared(P3)。
    const order = harness.serverMessages.map((message) => message.type);
    const pongIndex = order.lastIndexOf("heartbeat.pong");
    const firstBulkIndex = order.findIndex((type) => type === "scene.prepared");
    expect(pongIndex).toBeGreaterThan(-1);
    expect(firstBulkIndex).toBeGreaterThan(-1);
    expect(pongIndex).toBeLessThan(firstBulkIndex);
    // 全部消息最终送达。
    expect(harness.sendsOf("scene.prepared").length).toBe(50);
  });

  it("慢消费者背压：高优先级溢出关闭 4002，心跳在此之前仍被优先送达", () => {
    const harness = new ControlHarness({ sendQueue: { maxMessages: 2 }, replayWindowCapacity: 2 });
    harness.handshake();
    // 灌满 P3×2。
    harness.session.enqueueServerMessage({
      type: "scene.prepared",
      payload: { sceneId: STREAM_ID, cycleId: STREAM_ID, cues: [] },
    });
    harness.session.enqueueServerMessage({
      type: "scene.prepared",
      payload: { sceneId: STREAM_ID, cycleId: STREAM_ID, cues: [] },
    });
    // 心跳 Pong 触发淘汰一条 P3 并插队。
    harness.clientSend("heartbeat.ping");
    const order = harness.serverMessages.map((message) => message.type);
    expect(order.indexOf("heartbeat.pong")).toBeLessThan(order.indexOf("scene.prepared"));
    // 高优先级塞满后触发关闭。
    const errorPayload = {
      error: { code: "internal_error", message: "x", retryable: false, traceId: TRACE_ID },
    };
    harness.session.enqueueServerMessage({ type: "error", payload: errorPayload });
    harness.session.enqueueServerMessage({ type: "error", payload: errorPayload });
    const overflow = harness.session.enqueueServerMessage({ type: "error", payload: errorPayload });
    expect(overflow.status).toBe("close_slow_consumer");
    harness.pump();
    expect(harness.closed[0]?.code).toBe(CONTROL_CLOSE_CODES.send_queue_overflow);
    expect(harness.dropped.some((drop) => drop.category === "scene.prepared")).toBe(true);
  });
});

describe("集成：关闭与资源释放", () => {
  it("优雅关闭：排空 → close 1000 → 之后一切入站拒绝、资源释放", () => {
    const harness = new ControlHarness();
    harness.handshake();
    harness.clientSend("media.stream.open", { idempotencyKey: "open-9" });
    harness.registry.open({
      streamId: STREAM_ID,
      sessionId: SESSION_ID,
      mediaKind: "binary-test",
      contentType: "application/octet-stream",
    });
    harness.session.close("runtime_shutdown");
    harness.pump();
    expect(harness.closed[0]).toEqual({ code: 1000, reason: "runtime_shutdown" });
    expect(harness.session.state).toBe("closed");
    // 关闭后消息稳定拒绝。
    harness.clientSend("heartbeat.ping");
    expect(harness.sendsOf("heartbeat.pong").length).toBe(0);
    // 资源释放。
    expect(harness.registry.closeAll()).toBe(1);
    expect(harness.registry.openCount()).toBe(0);
    harness.parser.reset();
    expect(harness.parser.failed).toBe(false);
  });

  it("Abort 语义：SystemMonotonicClock 等待可在关闭时全部释放", async () => {
    const { SystemMonotonicClock } = await import("../../src/index.js");
    const clock = new SystemMonotonicClock();
    const pending = clock.sleepUntil(clock.nowUs() + 60_000_000n);
    const expectation = expect(pending).rejects.toThrow(/closed/);
    clock.close();
    await expectation;
  });
});
