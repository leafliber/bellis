import { describe, expect, it } from "vitest";
import { VirtualClock } from "@bellis/testkit";
import { CONTROL_CLOSE_CODES, ControlSession } from "../../src/index.js";
import type { ControlEffect, ControlSessionOptions } from "../../src/index.js";
import {
  ALT_MESSAGE_ID,
  MESSAGE_ID,
  SESSION_ID,
  STREAM_ID,
  TRACE_ID,
  clientText,
} from "../helpers.js";

const US = 1n;
const MS_IN_US = 1000n;

function createSession(overrides: Partial<ControlSessionOptions> = {}): {
  session: ControlSession;
  clock: VirtualClock;
} {
  const clock = new VirtualClock();
  const session = new ControlSession({
    sessionId: SESSION_ID,
    runtimeVersion: "0.1.0-test",
    clock,
    ...overrides,
  });
  return { session, clock };
}

function helloText(lastAck?: string, messageId = MESSAGE_ID): string {
  return clientText({
    type: "client.hello",
    messageId,
    payload: {
      protocolVersion: 1,
      clientType: "test-client",
      ...(lastAck === undefined ? {} : { lastAck }),
    },
  });
}

/** 建连：server.hello → client.hello，返回发送给客户端的全部 send Effect。 */
function handshake(
  session: ControlSession,
  clock: VirtualClock,
): {
  sends: string[];
  effects: ControlEffect[];
} {
  const helloEnqueue = session.enqueueServerMessage({
    type: "server.hello",
    payload: session.helloPayload(),
  });
  expect(helloEnqueue.status).toBe("queued");
  const effects = session.tick(clock.nowUs());
  const accepted = session.acceptClientMessage(helloText(), clock.nowUs());
  expect(accepted.status).toBe("accepted");
  const ready = session.enqueueServerMessage({ type: "server.ready", payload: {} });
  expect(ready.status).toBe("queued");
  const after = session.tick(clock.nowUs());
  return {
    sends: [...effects, ...after]
      .filter(
        (effect): effect is Extract<ControlEffect, { kind: "send" }> => effect.kind === "send",
      )
      .map((effect) => effect.text),
    effects: [...effects, ...after],
  };
}

function sendTexts(effects: readonly ControlEffect[]): string[] {
  return effects
    .filter((effect): effect is Extract<ControlEffect, { kind: "send" }> => effect.kind === "send")
    .map((effect) => effect.text);
}

describe("ControlSession 握手与状态机", () => {
  it("server.hello → client.hello → active → server.ready", () => {
    const { session, clock } = createSession();
    expect(session.state).toBe("awaiting_client_hello");
    const { sends } = handshake(session, clock);
    expect(session.state).toBe("active");
    expect(sends.length).toBe(2);
    const hello = JSON.parse(sends[0] ?? "") as { type: string; seq: string };
    expect(hello.type).toBe("server.hello");
    expect(hello.seq).toBe("1");
  });

  it("helloPayload 暴露心跳间隔与 Replay 窗口大小", () => {
    const { session } = createSession({
      replayWindowCapacity: 64,
      heartbeat: { intervalMs: 5000 },
    });
    expect(session.helloPayload()).toEqual({
      protocolVersion: 1,
      runtimeVersion: "0.1.0-test",
      heartbeatIntervalMs: 5000,
      replayWindowSize: 64,
    });
  });

  it("Hello 前的业务消息被拒绝（not_ready）", () => {
    const { session, clock } = createSession();
    const result = session.acceptClientMessage(clientText({ type: "clock.ping" }), clock.nowUs());
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.code).toBe("not_ready");
    }
  });

  it("重复 client.hello 被稳定拒绝", () => {
    const { session, clock } = createSession();
    handshake(session, clock);
    const result = session.acceptClientMessage(helloText(ALT_MESSAGE_ID), clock.nowUs());
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.code).toBe("invalid_message");
      expect(result.closeInitiated).toBe(false);
    }
    expect(session.state).toBe("active");
  });

  it("协议版本不匹配 → unsupported_version + 关闭 4003", () => {
    const { session, clock } = createSession();
    session.enqueueServerMessage({ type: "server.hello", payload: session.helloPayload() });
    session.tick(clock.nowUs());
    const bad = clientText({
      type: "client.hello",
      payload: { protocolVersion: 2, clientType: "test-client" },
    });
    const result = session.acceptClientMessage(bad, clock.nowUs());
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.code).toBe("unsupported_version");
      expect(result.closeInitiated).toBe(true);
    }
    const effects = session.tick(clock.nowUs());
    const close = effects.find(
      (effect): effect is Extract<ControlEffect, { kind: "close" }> => effect.kind === "close",
    );
    expect(close?.code).toBe(CONTROL_CLOSE_CODES.protocol_error);
    const errorSend = effects.find(
      (effect): effect is Extract<ControlEffect, { kind: "send" }> =>
        effect.kind === "send" && JSON.parse(effect.text).type === "error",
    );
    expect(errorSend).toBeDefined();
    expect(session.state).toBe("closed");
  });

  it("session 不匹配的消息被拒绝", () => {
    const { session, clock } = createSession();
    handshake(session, clock);
    const result = session.acceptClientMessage(
      clientText({ type: "clock.ping", sessionId: "00000000-0000-4000-8000-000000000000" }),
      clock.nowUs(),
    );
    expect(result.status).toBe("rejected");
  });

  it("closed 状态拒绝一切入站消息", () => {
    const { session, clock } = createSession();
    handshake(session, clock);
    session.close("test");
    session.tick(clock.nowUs());
    expect(session.state).toBe("closed");
    const result = session.acceptClientMessage(clientText(), clock.nowUs());
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.code).toBe("not_ready");
    }
  });
});

describe("ControlSession 心跳与时钟同步", () => {
  it("heartbeat.ping → 入队 heartbeat.pong（同 traceId）", () => {
    const { session, clock } = createSession();
    handshake(session, clock);
    const result = session.acceptClientMessage(
      clientText({ type: "heartbeat.ping" }),
      clock.nowUs(),
    );
    expect(result.status).toBe("accepted");
    const sends = sendTexts(session.tick(clock.nowUs()));
    expect(sends.length).toBe(1);
    const pong = JSON.parse(sends[0] ?? "") as {
      type: string;
      trace: { traceId: string };
      seq: string;
    };
    expect(pong.type).toBe("heartbeat.pong");
    expect(pong.trace.traceId).toBe(TRACE_ID);
  });

  it("clock.ping → clock.pong 回显 c0 并携带 r1=r2=nowUs", () => {
    const { session, clock } = createSession();
    handshake(session, clock);
    clock.advanceBy(1234n * US);
    const result = session.acceptClientMessage(clientText({ type: "clock.ping" }), clock.nowUs());
    expect(result.status).toBe("accepted");
    const sends = sendTexts(session.tick(clock.nowUs()));
    const pong = JSON.parse(sends[0] ?? "") as {
      payload: { c0: string; r1: string; r2: string };
    };
    expect(pong.payload).toEqual({ c0: "1000", r1: "1234", r2: "1234" });
  });

  it("clock.ping 缺 c0 → 拒绝", () => {
    const { session, clock } = createSession();
    handshake(session, clock);
    const result = session.acceptClientMessage(
      clientText({ type: "clock.ping", payload: {} }),
      clock.nowUs(),
    );
    expect(result.status).toBe("rejected");
  });

  it("心跳超时（无入站）→ 关闭 4001", () => {
    const { session, clock } = createSession({
      heartbeat: { intervalMs: 1000, timeoutUs: 3000n * MS_IN_US },
    });
    handshake(session, clock);
    clock.advanceBy(3001n * MS_IN_US);
    const effects = session.tick(clock.nowUs());
    const close = effects.find(
      (effect): effect is Extract<ControlEffect, { kind: "close" }> => effect.kind === "close",
    );
    expect(close?.code).toBe(CONTROL_CLOSE_CODES.heartbeat_timeout);
    expect(session.state).toBe("closed");
  });

  it("入站消息刷新心跳时钟（不误杀活跃连接）", () => {
    const { session, clock } = createSession({
      heartbeat: { intervalMs: 1000, timeoutUs: 3000n * MS_IN_US },
    });
    handshake(session, clock);
    clock.advanceBy(2000n * MS_IN_US);
    session.acceptClientMessage(
      clientText({ type: "heartbeat.ping", messageId: ALT_MESSAGE_ID }),
      clock.nowUs(),
    );
    session.tick(clock.nowUs());
    clock.advanceBy(2000n * MS_IN_US);
    const effects = session.tick(clock.nowUs());
    expect(effects.some((effect) => effect.kind === "close")).toBe(false);
    clock.advanceBy(1001n * MS_IN_US);
    const late = session.tick(clock.nowUs());
    expect(late.some((effect) => effect.kind === "close")).toBe(true);
  });

  it("Hello 超时 → 关闭 4004", () => {
    const { session, clock } = createSession({ helloTimeoutUs: 1000n * MS_IN_US });
    session.enqueueServerMessage({ type: "server.hello", payload: session.helloPayload() });
    session.tick(clock.nowUs());
    clock.advanceBy(1001n * MS_IN_US);
    const effects = session.tick(clock.nowUs());
    const close = effects.find(
      (effect): effect is Extract<ControlEffect, { kind: "close" }> => effect.kind === "close",
    );
    expect(close?.code).toBe(CONTROL_CLOSE_CODES.hello_timeout);
  });
});

describe("ControlSession Seq / ACK / Replay", () => {
  it("服务端 Seq 严格递增；seq_advanced Effect 区分 persistable", () => {
    const { session, clock } = createSession();
    handshake(session, clock);
    session.enqueueServerMessage({
      type: "scene.prepared",
      payload: { sceneId: STREAM_ID, cycleId: STREAM_ID, cues: [] },
    });
    const effects = session.tick(clock.nowUs());
    const seqEffects = effects.filter(
      (effect): effect is Extract<ControlEffect, { kind: "seq_advanced" }> =>
        effect.kind === "seq_advanced",
    );
    // handshake 已分配 1(server.hello)+2(pong无)+…：ready=2, prepared=3
    const last = seqEffects[seqEffects.length - 1];
    expect(last?.persistable).toBe(true);
    expect(session.replayAfter(0n).status).not.toBe("invalid_ahead");
  });

  it("心跳/时钟 Pong 消耗 Seq 但标记为非持久化（persistable=false）", () => {
    const { session, clock } = createSession();
    handshake(session, clock); // seq: 1 hello, 2 ready
    session.acceptClientMessage(clientText({ type: "clock.ping" }), clock.nowUs());
    const effects = session.tick(clock.nowUs());
    const seqEffects = effects.filter(
      (effect): effect is Extract<ControlEffect, { kind: "seq_advanced" }> =>
        effect.kind === "seq_advanced",
    );
    expect(seqEffects.length).toBe(1);
    expect(seqEffects[0]?.persistable).toBe(false);
    expect(seqEffects[0]?.seq).toBe(3n);
  });

  it("ACK 推进：advanced → duplicate；超前 → 协议错误关闭", () => {
    const { session, clock } = createSession();
    handshake(session, clock);
    expect(session.acknowledge(1n)).toEqual({ status: "advanced" });
    expect(session.acknowledge(1n)).toEqual({ status: "duplicate" });
    expect(session.acknowledge(0n)).toEqual({ status: "duplicate" });
    expect(session.confirmedAck).toBe(1n);
    // 入站消息携带超前 ACK → 关闭。
    const result = session.acceptClientMessage(
      clientText({ type: "heartbeat.ping", messageId: ALT_MESSAGE_ID }, { ack: "99" }),
      clock.nowUs(),
    );
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.closeInitiated).toBe(true);
    }
    const close = session
      .tick(clock.nowUs())
      .find(
        (effect): effect is Extract<ControlEffect, { kind: "close" }> => effect.kind === "close",
      );
    expect(close?.code).toBe(CONTROL_CLOSE_CODES.protocol_error);
  });

  it("重连：exportLogicalState → resume → lastAck 命中窗口按原 Seq/MessageId 重放", () => {
    const first = createSession();
    handshake(first.session, first.clock);
    for (let index = 0; index < 3; index += 1) {
      first.session.enqueueServerMessage({
        type: "scene.prepared",
        payload: { sceneId: STREAM_ID, cycleId: STREAM_ID, cues: [] },
      });
    }
    const allEffects = first.session.tick(first.clock.nowUs());
    const sentTexts = sendTexts(allEffects);
    expect(sentTexts.length).toBe(3);
    first.session.acknowledge(2n); // 客户端只确认到 seq=2

    const second = createSession({ resume: first.session.exportLogicalState() });
    expect(second.session.state).toBe("awaiting_client_hello");
    second.session.enqueueServerMessage({
      type: "server.hello",
      payload: second.session.helloPayload(),
    });
    second.session.tick(second.clock.nowUs());
    const accepted = second.session.acceptClientMessage(helloText("2"), second.clock.nowUs());
    expect(accepted.status).toBe("accepted");
    const replaySends = sendTexts(second.session.tick(second.clock.nowUs()));
    // 重放 lastAck 之后窗口内全部消息（原 seq=3..5 原文本），随后才是本连接
    // 的 server.hello（此刻才分配 seq=6）：线上 Seq 严格递增、无重复。
    expect(replaySends.length).toBe(4);
    const seqs = replaySends.map((text) => JSON.parse(text).seq);
    expect(seqs).toEqual(["3", "4", "5", "6"]);
    expect(replaySends.slice(0, 3)).toEqual(sentTexts);
    expect(second.session.state).toBe("active");
  });

  it("重连缺口超出窗口 → snapshot_required Effect", () => {
    const first = createSession({ replayWindowCapacity: 4 });
    handshake(first.session, first.clock);
    for (let index = 0; index < 6; index += 1) {
      first.session.enqueueServerMessage({
        type: "scene.prepared",
        payload: { sceneId: STREAM_ID, cycleId: STREAM_ID, cues: [] },
      });
    }
    first.session.tick(first.clock.nowUs());
    const logical = first.session.exportLogicalState();

    const second = createSession({ resume: logical });
    second.session.enqueueServerMessage({
      type: "server.hello",
      payload: second.session.helloPayload(),
    });
    second.session.tick(second.clock.nowUs());
    second.session.acceptClientMessage(helloText("2"), second.clock.nowUs());
    const effects = second.session.tick(second.clock.nowUs());
    const snapshot = effects.find(
      (effect): effect is Extract<ControlEffect, { kind: "snapshot_required" }> =>
        effect.kind === "snapshot_required",
    );
    expect(snapshot).toEqual({ kind: "snapshot_required", lastAck: 2n });
  });

  it("lastAck 超过已分配 Seq → 协议错误关闭", () => {
    const { session, clock } = createSession();
    handshake(session, clock); // 最新 seq = 2
    const logical = session.exportLogicalState();
    const second = createSession({ resume: logical });
    second.session.enqueueServerMessage({
      type: "server.hello",
      payload: second.session.helloPayload(),
    });
    second.session.tick(second.clock.nowUs());
    const result = second.session.acceptClientMessage(helloText("9"), second.clock.nowUs());
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.closeInitiated).toBe(true);
    }
  });
});

describe("ControlSession 去重、幂等与 Deadline", () => {
  it("重复 messageId → duplicate，不重复产生 Pong", () => {
    const { session, clock } = createSession();
    handshake(session, clock);
    session.acceptClientMessage(clientText({ type: "heartbeat.ping" }), clock.nowUs());
    session.tick(clock.nowUs());
    const duplicate = session.acceptClientMessage(
      clientText({ type: "heartbeat.ping" }),
      clock.nowUs(),
    );
    expect(duplicate.status).toBe("duplicate");
    expect(sendTexts(session.tick(clock.nowUs())).length).toBe(0);
  });

  it("状态变更消息缺 idempotencyKey → 拒绝；带 Key → 接受", () => {
    const { session, clock } = createSession();
    handshake(session, clock);
    const missing = session.acceptClientMessage(
      clientText({ type: "media.stream.open" }),
      clock.nowUs(),
    );
    expect(missing.status).toBe("rejected");
    if (missing.status === "rejected") {
      expect(missing.code).toBe("invalid_message");
    }
    const withKey = session.acceptClientMessage(
      clientText({ type: "media.stream.open" }, { idempotencyKey: "open-1" }),
      clock.nowUs(),
    );
    expect(withKey.status).toBe("accepted");
  });

  it("deadlineUs 已过 → deadline_exceeded，不进入去重集合", () => {
    const { session, clock } = createSession();
    handshake(session, clock);
    clock.advanceBy(10_000n);
    const expired = session.acceptClientMessage(
      clientText({ type: "heartbeat.ping", deadlineUs: "1" }),
      clock.nowUs(),
    );
    expect(expired.status).toBe("rejected");
    if (expired.status === "rejected") {
      expect(expired.code).toBe("deadline_exceeded");
    }
    // 同 messageId 在修正 Deadline 后仍可被处理（未消耗去重容量）。
    const retried = session.acceptClientMessage(
      clientText({ type: "heartbeat.ping", deadlineUs: "999999999999" }),
      clock.nowUs(),
    );
    expect(retried.status).toBe("accepted");
  });

  it("入站 Deadline 恰好等于 nowUs 也算过期（<=）", () => {
    const { session, clock } = createSession();
    handshake(session, clock);
    const now = clock.nowUs() + 1n;
    const result = session.acceptClientMessage(
      clientText({ type: "heartbeat.ping", deadlineUs: now.toString() }),
      now,
    );
    expect(result.status).toBe("rejected");
  });
});

describe("ControlSession 背压与关闭", () => {
  it("低优先级溢出 → dropped；高优先级溢出 → close_slow_consumer + 4002", () => {
    const { session, clock } = createSession({
      sendQueue: { maxMessages: 2 },
      replayWindowCapacity: 2,
    });
    handshake(session, clock);
    session.tick(clock.nowUs()); // 排空
    const bulk1 = session.enqueueServerMessage({
      type: "scene.prepared",
      payload: { sceneId: STREAM_ID, cycleId: STREAM_ID, cues: [] },
    });
    const bulk2 = session.enqueueServerMessage({
      type: "scene.prepared",
      payload: { sceneId: STREAM_ID, cycleId: STREAM_ID, cues: [] },
    });
    expect(bulk1.status).toBe("queued");
    expect(bulk2.status).toBe("queued");
    // 第 3 条 bulk：容量满，同为 P3 → dropped。
    const bulk3 = session.enqueueServerMessage({
      type: "scene.prepared",
      payload: { sceneId: STREAM_ID, cycleId: STREAM_ID, cues: [] },
    });
    expect(bulk3.status).toBe("dropped");
    // P1 error：淘汰一条 bulk 后入队成功；随后第二条 P1 占满容量；
    // 第三条 P1 无法淘汰任何条目 → close_slow_consumer。
    const errorPayload = {
      error: { code: "internal_error", message: "x", retryable: false, traceId: TRACE_ID },
    };
    const critical1 = session.enqueueServerMessage({ type: "error", payload: errorPayload });
    expect(critical1.status).toBe("queued");
    const critical2 = session.enqueueServerMessage({ type: "error", payload: errorPayload });
    expect(critical2.status).toBe("queued");
    const critical3 = session.enqueueServerMessage({ type: "error", payload: errorPayload });
    expect(critical3.status).toBe("close_slow_consumer");
    const effects = session.tick(clock.nowUs());
    const close = effects.find(
      (effect): effect is Extract<ControlEffect, { kind: "close" }> => effect.kind === "close",
    );
    expect(close?.code).toBe(CONTROL_CLOSE_CODES.send_queue_overflow);
    // 被淘汰的 bulk 与两条 P1 error 的发送都在关闭前完成。
    const sends = sendTexts(effects).map((text) => JSON.parse(text).type);
    expect(sends).toEqual(["error", "error"]);
    expect(
      effects.some(
        (effect) =>
          effect.kind === "dropped" && effect.category === "scene.prepared" && effect.count === 1,
      ),
    ).toBe(true);
  });

  it("队列淘汰产生 dropped Effect（只含类别与数量）", () => {
    const { session, clock } = createSession({
      sendQueue: { maxMessages: 1 },
      replayWindowCapacity: 1,
    });
    handshake(session, clock);
    session.tick(clock.nowUs());
    session.enqueueServerMessage({
      type: "scene.prepared",
      payload: { sceneId: STREAM_ID, cycleId: STREAM_ID, cues: [] },
    });
    session.enqueueServerMessage({ type: "server.ready", payload: {} });
    const effects = session.tick(clock.nowUs());
    const dropped = effects.filter(
      (effect): effect is Extract<ControlEffect, { kind: "dropped" }> => effect.kind === "dropped",
    );
    expect(dropped).toEqual([
      { kind: "dropped", category: "scene.prepared", count: 1, reason: "capacity" },
    ]);
  });

  it("优雅关闭：draining 收尾 ACK/心跳，排空后 close 1000", () => {
    const { session, clock } = createSession();
    handshake(session, clock);
    session.close("server_shutdown", CONTROL_CLOSE_CODES.server_shutdown);
    expect(session.state).toBe("draining");
    // draining 允许心跳与 ACK。
    const ping = session.acceptClientMessage(clientText({ type: "heartbeat.ping" }), clock.nowUs());
    expect(ping.status).toBe("accepted");
    const business = session.acceptClientMessage(
      clientText({ type: "media.stream.open" }, { idempotencyKey: "k" }),
      clock.nowUs(),
    );
    expect(business.status).toBe("rejected");
    const effects = session.tick(clock.nowUs());
    const sends = sendTexts(effects);
    expect(sends.length).toBe(1); // 心跳 Pong
    const close = effects.find(
      (effect): effect is Extract<ControlEffect, { kind: "close" }> => effect.kind === "close",
    );
    expect(close).toEqual({
      kind: "close",
      code: CONTROL_CLOSE_CODES.server_shutdown,
      reason: "server_shutdown",
    });
    expect(session.state).toBe("closed");
  });

  it("出站消息在排队期间过期：tick 剪枝且不发送", () => {
    const { session, clock } = createSession();
    handshake(session, clock);
    session.enqueueServerMessage({
      type: "scene.prepared",
      payload: { sceneId: STREAM_ID, cycleId: STREAM_ID, cues: [] },
      deadlineUs: clock.nowUs() + 1000n,
    });
    clock.advanceBy(1001n);
    const effects = session.tick(clock.nowUs());
    expect(sendTexts(effects).length).toBe(0);
    expect(
      effects.some(
        (effect) =>
          effect.kind === "dropped" &&
          effect.reason === "expired" &&
          effect.category === "scene.prepared",
      ),
    ).toBe(true);
  });

  it("awaiting 阶段只允许 server.hello/error 出站", () => {
    const { session } = createSession();
    const early = session.enqueueServerMessage({ type: "server.ready", payload: {} });
    expect(early.status).toBe("not_ready");
    const hello = session.enqueueServerMessage({
      type: "server.hello",
      payload: session.helloPayload(),
    });
    expect(hello.status).toBe("queued");
  });

  it("Payload 非法 → invalid（不消耗 Seq）", () => {
    const { session } = createSession();
    const bad = session.enqueueServerMessage({ type: "server.hello", payload: {} });
    expect(bad.status).toBe("invalid");
    const good = session.enqueueServerMessage({
      type: "server.hello",
      payload: session.helloPayload(),
    });
    expect(good.status).toBe("queued");
  });
});

describe("ControlSession 评审回归：Seq 顺序与缺口", () => {
  it("优先级调度不破坏线上 Seq 严格递增（P1 抢先但 Seq 按发送顺序分配）", () => {
    const { session, clock } = createSession();
    handshake(session, clock);
    // 先暂存 P3，再暂存 P1：发送顺序 P1 在前，但 Seq 按实际发送分配。
    session.enqueueServerMessage({
      type: "scene.prepared",
      payload: { sceneId: STREAM_ID, cycleId: STREAM_ID, cues: [] },
    });
    session.enqueueServerMessage({
      type: "scene.committed",
      payload: { sceneId: STREAM_ID, cycleId: STREAM_ID, committedAtMs: 1 },
    });
    const effects = session.tick(clock.nowUs());
    const sends = sendTexts(effects);
    expect(sends.length).toBe(2);
    const parsed = sends.map((text) => JSON.parse(text) as { type: string; seq: string });
    // P1（scene.committed）先发送 → 先分配更小的 Seq；线上 Seq 严格递增。
    expect(parsed.map((item) => item.type)).toEqual(["scene.committed", "scene.prepared"]);
    expect(parsed.map((item) => item.seq)).toEqual(["3", "4"]);
  });

  it("被合并/淘汰/过期的消息不消耗 Seq、不进入 Replay Window", () => {
    const { session, clock } = createSession();
    handshake(session, clock);
    const prepared = { sceneId: STREAM_ID, cycleId: STREAM_ID, cues: [] };
    // 合并：同 mergeKey 的旧消息被替换，只发送新消息，Seq 无缺口。
    session.enqueueServerMessage({
      type: "scene.prepared",
      payload: prepared,
      mergeKey: "world-delta",
      replaceable: true,
    });
    session.enqueueServerMessage({
      type: "scene.prepared",
      payload: prepared,
      mergeKey: "world-delta",
      replaceable: true,
    });
    // 过期：deadline 已过的暂存消息在 tick 剪枝，不发送、不消耗 Seq。
    session.enqueueServerMessage({
      type: "scene.prepared",
      payload: prepared,
      deadlineUs: clock.nowUs() + 1n,
    });
    clock.advanceBy(2n);
    const effects = session.tick(clock.nowUs());
    const sends = sendTexts(effects);
    expect(sends.length).toBe(1); // 只有合并后的新消息
    const replay = session.replayAfter(0n);
    expect(replay.status).toBe("replay");
    if (replay.status === "replay") {
      // 窗口内：hello=1, ready=2, 合并幸存者=3；没有为被合并/过期消息预留的 Seq。
      expect(replay.messages.map((message) => message.seq)).toEqual([1n, 2n, 3n]);
    }
    expect(effects.some((effect) => effect.kind === "dropped" && effect.reason === "merged")).toBe(
      true,
    );
    expect(effects.some((effect) => effect.kind === "dropped" && effect.reason === "expired")).toBe(
      true,
    );
    // 下一条消息从 4 继续，不存在被静默消息消耗的 Seq。
    session.enqueueServerMessage({
      type: "scene.prepared",
      payload: prepared,
    });
    const next = sendTexts(session.tick(clock.nowUs())).map(
      (text) => (JSON.parse(text) as { seq: string }).seq,
    );
    expect(next).toEqual(["4"]);
  });

  it("优先级覆盖只能提升：error 被声明为 P4 仍按 P1 保护", () => {
    const { session, clock } = createSession({
      priorityOverrides: { error: 4 },
      sendQueue: { maxMessages: 1 },
    });
    handshake(session, clock);
    session.tick(clock.nowUs()); // 排空
    session.enqueueServerMessage({
      type: "scene.prepared",
      payload: { sceneId: STREAM_ID, cycleId: STREAM_ID, cues: [] },
    });
    const errorPayload = {
      error: { code: "internal_error", message: "x", retryable: false, traceId: TRACE_ID },
    };
    // 若覆盖能把 error 降级为 P4，这里会 dropped；安全下限应让它淘汰 P3 入队。
    const outcome = session.enqueueServerMessage({ type: "error", payload: errorPayload });
    expect(outcome.status).toBe("queued");
    const sends = sendTexts(session.tick(clock.nowUs())).map(
      (text) => (JSON.parse(text) as { type: string }).type,
    );
    expect(sends).toEqual(["error"]);
  });

  it("显式 priority 同样不能降低安全下限", () => {
    const { session, clock } = createSession({ sendQueue: { maxMessages: 1 } });
    handshake(session, clock);
    session.tick(clock.nowUs());
    session.enqueueServerMessage({
      type: "scene.prepared",
      payload: { sceneId: STREAM_ID, cycleId: STREAM_ID, cues: [] },
    });
    const outcome = session.enqueueServerMessage({
      type: "error",
      payload: {
        error: { code: "internal_error", message: "x", retryable: false, traceId: TRACE_ID },
      },
      priority: 4,
    });
    expect(outcome.status).toBe("queued");
  });
});

describe("ControlSession 评审回归：恢复与水位", () => {
  it("恢复会话在 client.hello 前不发新消息；重放先于新消息且线上 Seq 递增", () => {
    const first = createSession();
    handshake(first.session, first.clock);
    for (let index = 0; index < 3; index += 1) {
      first.session.enqueueServerMessage({
        type: "scene.prepared",
        payload: { sceneId: STREAM_ID, cycleId: STREAM_ID, cues: [] },
      });
    }
    const sentTexts = sendTexts(first.session.tick(first.clock.nowUs()));
    first.session.acknowledge(2n);

    const second = createSession({ resume: first.session.exportLogicalState() });
    second.session.enqueueServerMessage({
      type: "server.hello",
      payload: second.session.helloPayload(),
    });
    // 恢复会话：hello 保留到 client.hello 之后，否则重放 Seq 会回退。
    expect(sendTexts(second.session.tick(second.clock.nowUs())).length).toBe(0);
    const accepted = second.session.acceptClientMessage(helloText("2"), second.clock.nowUs());
    expect(accepted.status).toBe("accepted");
    const sends = sendTexts(second.session.tick(second.clock.nowUs()));
    const seqs = sends.map((text) => BigInt((JSON.parse(text) as { seq: string }).seq));
    // 重放（3,4,5）→ 新 hello（6）：线上 Seq 严格递增。
    expect(seqs).toEqual([3n, 4n, 5n, 6n]);
    expect(sends.slice(0, 3)).toEqual(sentTexts);
  });

  it("窗口全部确认后恢复：合法 ACK 不被误判超前，水位不回退", () => {
    const first = createSession();
    handshake(first.session, first.clock); // seq 1,2 已发送
    first.session.acknowledge(2n); // 全部确认，窗口清空
    const logical = first.session.exportLogicalState();
    expect(logical.replay.length).toBe(0);
    expect(logical.nextSeq).toBe(3n);

    const second = createSession({ resume: logical });
    const accepted = second.session.acceptClientMessage(helloText("2"), second.clock.nowUs());
    expect(accepted.status).toBe("accepted");
    expect(second.session.replayAfter(2n).status).toBe("up_to_date");
    expect(second.session.state).toBe("active");
  });

  it("未发送的暂存消息随逻辑状态导出，恢复后从原水位继续分配 Seq", () => {
    const first = createSession();
    handshake(first.session, first.clock); // seq 1,2
    const prepared = { sceneId: STREAM_ID, cycleId: STREAM_ID, cues: [] };
    first.session.enqueueServerMessage({ type: "scene.prepared", payload: prepared }); // 未 tick
    const logical = first.session.exportLogicalState();
    expect(logical.pending?.length).toBe(1);

    const second = createSession({ resume: logical });
    second.session.acceptClientMessage(helloText("2"), second.clock.nowUs());
    const sends = sendTexts(second.session.tick(second.clock.nowUs()));
    // 暂存消息恢复发送，Seq 从 3 继续（未被丢失，也未被重复分配）。
    expect(sends.length).toBe(1);
    expect((JSON.parse(sends[0] ?? "") as { seq: string }).seq).toBe("3");
  });

  it("瞬时消息推进的 Seq 体现在导出水位（重启后不会复用 Seq）", () => {
    const { session, clock } = createSession();
    handshake(session, clock); // seq 1,2
    session.acceptClientMessage(clientText({ type: "clock.ping" }), clock.nowUs());
    const effects = session.tick(clock.nowUs());
    const seqEffects = effects.filter(
      (effect): effect is Extract<ControlEffect, { kind: "seq_advanced" }> =>
        effect.kind === "seq_advanced",
    );
    expect(seqEffects[0]?.seq).toBe(3n);
    expect(seqEffects[0]?.persistable).toBe(false);
    // 即便 P4 不持久化瞬时消息的 Replay 内容，导出水位也必须覆盖它。
    expect(session.exportLogicalState().nextSeq).toBe(4n);
  });
});
