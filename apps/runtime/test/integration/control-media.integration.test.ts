import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServerControlEnvelope } from "@bellis/contracts";
import { parseDecimalString } from "@bellis/contracts";
import type { RuntimeHandle } from "../../src/index.js";
import {
  cleanupTempDataDirectory,
  createTempDataDirectory,
  mustExchange,
  originFor,
  startTestRuntime,
} from "../helpers.js";
import { buildMediaFrame, clientEnvelope, ControlWsClient, mediaSocket } from "../ws-client.js";

let handle: RuntimeHandle;
let dataDirectory: string;

beforeAll(async () => {
  dataDirectory = createTempDataDirectory("bellis-p4-ws-");
  handle = await startTestRuntime({ dataDirectory });
});

afterAll(async () => {
  await handle.close();
  cleanupTempDataDirectory(dataDirectory);
});

function wsOptions(cookie: string, port: number = handle.status.port) {
  return { port, path: "/ws/v1/control", cookie, origin: originFor(handle, port) };
}

function mediaOptions(cookie: string, port: number = handle.status.port) {
  return { port, path: "/ws/v1/media", cookie, origin: originFor(handle, port) };
}

async function connectedClient(
  options: { port: number; cookie: string },
  sessionId: string,
): Promise<ControlWsClient> {
  const client = new ControlWsClient(wsOptions(options.cookie, options.port));
  await client.opened();
  await client.waitForType("server.hello");
  client.send(
    clientEnvelope({
      sessionId,
      type: "client.hello",
      payload: { protocolVersion: 1, clientType: "test-client" },
    }),
  );
  await client.waitForType("server.ready");
  return client;
}

describe("Control WebSocket 握手与基础协议", () => {
  it("server.hello → client.hello → server.ready；协议版本正确", async () => {
    const issued = handle.issueStartupToken();
    const { sessionId, cookie } = await mustExchange(handle, issued.token);
    const client = new ControlWsClient(wsOptions(cookie));
    await client.opened();
    const hello = await client.waitForType("server.hello");
    expect(hello.seq).toBe("1");
    expect((hello.payload as { protocolVersion: number }).protocolVersion).toBe(1);
    expect((hello.payload as { replayWindowSize: number }).replayWindowSize).toBeGreaterThan(0);
    client.send(
      clientEnvelope({
        sessionId,
        type: "client.hello",
        payload: { protocolVersion: 1, clientType: "test-client" },
      }),
    );
    const ready = await client.waitForType("server.ready");
    expect(ready.seq).toBe("2");
    client.close();
  });

  it("clock.ping → clock.pong（r2 ≥ r1）；heartbeat ping → pong", async () => {
    const { sessionId, cookie } = await mustExchange(handle, handle.issueStartupToken().token);
    const client = await connectedClient({ port: handle.status.port, cookie }, sessionId);
    const c0 = BigInt(Date.now()) * 1000n;
    client.send(
      clientEnvelope({
        sessionId,
        type: "clock.ping",
        payload: { c0: c0.toString() },
        ack: parseDecimalString((client.received.at(-1) as ServerControlEnvelope).seq),
      }),
    );
    const pong = await client.waitForType("clock.pong");
    const payload = pong.payload as { c0: string; r1: string; r2: string };
    expect(payload.c0).toBe(c0.toString());
    expect(BigInt(payload.r2)).toBeGreaterThanOrEqual(BigInt(payload.r1));
    client.send(clientEnvelope({ sessionId, type: "heartbeat.ping", payload: {} }));
    await client.waitForType("heartbeat.pong");
    client.close();
  });

  it("未知类型与非法 JSON 返回稳定错误，不崩连接", async () => {
    const { sessionId, cookie } = await mustExchange(handle, handle.issueStartupToken().token);
    const client = await connectedClient({ port: handle.status.port, cookie }, sessionId);
    client.send(clientEnvelope({ sessionId, type: "totally.unknown", payload: {} }));
    const error = await client.waitForType("error");
    expect((error.payload as { error: { code: string } }).error.code).toBe("invalid_message");
    client.sendText("{not json");
    const second = await client.waitFor(
      (envelope) => envelope.type === "error" && envelope !== error,
    );
    expect((second.payload as { error: { code: string } }).error.code).toBe("invalid_message");
    // 连接仍可用。
    client.send(clientEnvelope({ sessionId, type: "heartbeat.ping", payload: {} }));
    await client.waitForType("heartbeat.pong");
    client.close();
  });

  it("过期 Deadline 返回 deadline_exceeded 且无副作用", async () => {
    const { sessionId, cookie } = await mustExchange(handle, handle.issueStartupToken().token);
    const client = await connectedClient({ port: handle.status.port, cookie }, sessionId);
    client.send(
      clientEnvelope({
        sessionId,
        type: "heartbeat.ping",
        payload: {},
        deadlineUs: 1n,
      }),
    );
    const error = await client.waitForType("error");
    expect((error.payload as { error: { code: string } }).error.code).toBe("deadline_exceeded");
    client.close();
  });

  it("伪造服务端方向 / 错误 SessionId 被拒绝", async () => {
    const { sessionId, cookie } = await mustExchange(handle, handle.issueStartupToken().token);
    const client = await connectedClient({ port: handle.status.port, cookie }, sessionId);
    client.send(
      clientEnvelope({
        sessionId: "99999999-9999-4999-8999-999999999999",
        type: "heartbeat.ping",
        payload: {},
      }),
    );
    const error = await client.waitForType("error");
    expect((error.payload as { error: { code: string } }).error.code).toBe("invalid_message");
    client.close();
  });

  it("未认证 / 伪造 Cookie 的 Upgrade 被关闭", async () => {
    const unauth = new ControlWsClient({
      ...wsOptions("bellis_session=forged-token-value"),
    });
    const closeCode = await new Promise<number>((resolve) => {
      unauth.socket.once("close", (code: number) => resolve(code));
    });
    expect(closeCode).toBe(1008);
  });

  it("同一 Session 的第二条 Control 连接被拒绝", async () => {
    const { sessionId, cookie } = await mustExchange(handle, handle.issueStartupToken().token);
    const first = await connectedClient({ port: handle.status.port, cookie }, sessionId);
    const second = new ControlWsClient(wsOptions(cookie));
    const closeCode = await new Promise<number>((resolve) => {
      second.socket.once("close", (code: number) => resolve(code));
    });
    expect(closeCode).toBe(1008);
    first.close();
  });
});

describe("重连 Replay 与 Snapshot", () => {
  it("断线重连：同 Seq/MessageId 原文重放，重放先于新消息", async () => {
    const { sessionId, cookie } = await mustExchange(handle, handle.issueStartupToken().token);
    const client = await connectedClient({ port: handle.status.port, cookie }, sessionId);
    // 制造三条 Pong（各消耗一个 Seq）。
    for (let index = 0; index < 3; index += 1) {
      client.send(
        clientEnvelope({ sessionId, type: "clock.ping", payload: { c0: String(index) } }),
      );
      await client.waitFor(
        (envelope) =>
          envelope.type === "clock.pong" &&
          (envelope.payload as { c0: string }).c0 === String(index),
      );
    }
    const sentBefore = client.received.map((envelope) => ({
      seq: envelope.seq,
      messageId: envelope.messageId,
      type: envelope.type,
    }));
    expect(sentBefore.length).toBeGreaterThanOrEqual(4);
    const lastSeq = parseDecimalString((client.received.at(-1) as ServerControlEnvelope).seq);
    // ACK 前粗暴断线（terminate，不给 Close 握手）。
    client.terminate();
    await new Promise((resolve) => setTimeout(resolve, 150));

    // 以 lastAck=0 重连：窗口内全部消息按原 Seq/MessageId 重放。
    const resumed = new ControlWsClient(wsOptions(cookie));
    await resumed.opened();
    resumed.send(
      clientEnvelope({
        sessionId,
        type: "client.hello",
        payload: { protocolVersion: 1, clientType: "test-client", lastAck: "0" },
      }),
    );
    const replayed = await resumed.waitFor(
      (envelope) =>
        envelope.type === "clock.pong" && (envelope.payload as { c0: string }).c0 === "0",
    );
    expect(replayed.messageId).toBe(
      sentBefore.find((entry) => entry.type === "clock.pong")?.messageId,
    );
    // 线上 Seq 不回退：重放条目保持原 Seq。
    const replayedAll = resumed.received.filter((envelope) => envelope.type === "clock.pong");
    expect(replayedAll.length).toBe(3);
    const seqs = replayedAll.map((envelope) => parseDecimalString(envelope.seq));
    expect(seqs).toEqual(seqs.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(seqs.reduce((max, seq) => (seq > max ? seq : max), 0n)).toBeLessThanOrEqual(lastSeq);
    resumed.close();
  });

  it("Replay Gap（超出窗口）→ session.snapshot，activeScene=null、Streams 空", async () => {
    // 小窗口实例：窗口容量 2，制造 4 条 Pong 后以 lastAck=0 重连。
    const gapDir = createTempDataDirectory("bellis-p4-gap-");
    const gapRuntime = await startTestRuntime({ dataDirectory: gapDir, replayWindowCapacity: 2 });
    try {
      const { sessionId, cookie } = await mustExchange(
        gapRuntime,
        gapRuntime.issueStartupToken().token,
      );
      const client = await connectedClient({ port: gapRuntime.status.port, cookie }, sessionId);
      for (let index = 0; index < 4; index += 1) {
        client.send(clientEnvelope({ sessionId, type: "heartbeat.ping", payload: {} }));
        await client.waitForType("heartbeat.pong");
      }
      client.terminate();
      await new Promise((resolve) => setTimeout(resolve, 150));
      const resumed = new ControlWsClient({
        port: gapRuntime.status.port,
        path: "/ws/v1/control",
        cookie,
        origin: originFor(gapRuntime),
      });
      await resumed.opened();
      resumed.send(
        clientEnvelope({
          sessionId,
          type: "client.hello",
          payload: { protocolVersion: 1, clientType: "test-client", lastAck: "0" },
        }),
      );
      const snapshot = await resumed.waitForType("session.snapshot");
      const snapshotPayload = (snapshot.payload as { snapshot: Record<string, unknown> }).snapshot;
      expect(snapshotPayload.reason).toBe("replay_gap");
      expect(snapshotPayload.activeScene).toBeNull();
      expect(snapshotPayload.openMediaStreams).toEqual([]);
      expect(snapshotPayload.latestServerSeq).toMatch(/^\d+$/);
      resumed.close();
    } finally {
      await gapRuntime.close();
      cleanupTempDataDirectory(gapDir);
    }
  });
});

describe("Media WebSocket", () => {
  it("注册 Stream → 合法帧被接受；未注册 Stream 的帧被拒绝", async () => {
    const { sessionId, cookie } = await mustExchange(handle, handle.issueStartupToken().token);
    const control = await connectedClient({ port: handle.status.port, cookie }, sessionId);
    const media = mediaSocket(mediaOptions(cookie));
    await new Promise<void>((resolve) => media.once("open", () => resolve()));

    const streamId = randomUUID();
    await openStream(control, sessionId, streamId, `open-${streamId}`);
    const frame = buildMediaFrame({
      streamId,
      frameId: randomUUID(),
      sessionId,
      sequence: 0,
      traceId: randomUUID().replaceAll("-", ""),
    });
    media.send(frame);
    await waitUntil(() => handle.mediaFrameStats(sessionId)?.accepted === 1);
    expect(handle.mediaFrameStats(sessionId)).toEqual({ accepted: 1, rejected: 0 });

    const unknownStreamFrame = buildMediaFrame({
      streamId: randomUUID(),
      frameId: randomUUID(),
      sessionId,
      sequence: 0,
      traceId: randomUUID().replaceAll("-", ""),
    });
    media.send(unknownStreamFrame);
    await waitUntil(() => handle.mediaFrameStats(sessionId)?.rejected === 1);

    // 乱序帧（sequence 跳号）→ 拒绝且 Stream 关闭。
    const gapFrame = buildMediaFrame({
      streamId,
      frameId: randomUUID(),
      sessionId,
      sequence: 9,
      traceId: randomUUID().replaceAll("-", ""),
    });
    media.send(gapFrame);
    await waitUntil(() => handle.mediaFrameStats(sessionId)?.rejected === 2);
    media.close(1000);
    control.close();
  });

  it("缺少幂等键的 media.stream.open 返回 invalid_message", async () => {
    const { sessionId, cookie } = await mustExchange(handle, handle.issueStartupToken().token);
    const control = await connectedClient({ port: handle.status.port, cookie }, sessionId);
    const before = control.received.length;
    await openStream(control, sessionId, randomUUID());
    const error = await control.waitFor(
      (envelope) => envelope.type === "error" && control.received.indexOf(envelope) >= before,
    );
    expect((error.payload as { error: { code: string } }).error.code).toBe("invalid_message");
    control.close();
  });

  it("Magic 损坏帧关闭 Media 连接（1003）；重连后重新注册才可发帧", async () => {
    const { sessionId, cookie } = await mustExchange(handle, handle.issueStartupToken().token);
    const control = await connectedClient({ port: handle.status.port, cookie }, sessionId);
    const streamId = randomUUID();
    await openStream(control, sessionId, streamId, `open-${streamId}`);

    const media = mediaSocket(mediaOptions(cookie));
    await new Promise<void>((resolve) => media.once("open", () => resolve()));
    const bad = buildMediaFrame({
      streamId,
      frameId: randomUUID(),
      sessionId,
      sequence: 0,
      traceId: randomUUID().replaceAll("-", ""),
    });
    bad[0] = 0x58; // 破坏 magic。
    media.send(bad);
    const closed = await new Promise<number>((resolve) =>
      media.once("close", (code: number) => resolve(code)),
    );
    expect(closed).toBe(1003);
    // Control 侧 Stream 因连接关闭被释放：同 streamId 不可复活，但可注册新 Stream。
    await waitUntil(() => handle.mediaFrameStats(sessionId)?.rejected === 1);

    const media2 = mediaSocket(mediaOptions(cookie));
    await new Promise<void>((resolve) => media2.once("open", () => resolve()));
    const newStream = randomUUID();
    await openStream(control, sessionId, newStream, `open-${newStream}`);
    media2.send(
      buildMediaFrame({
        streamId: newStream,
        frameId: randomUUID(),
        sessionId,
        sequence: 0,
        traceId: randomUUID().replaceAll("-", ""),
      }),
    );
    await waitUntil(() => (handle.mediaFrameStats(sessionId)?.accepted ?? 0) === 1);
    media2.close(1000);
    control.close();
  });

  it("Text Frame 在 Media 通道被明确拒绝", async () => {
    const { sessionId, cookie } = await mustExchange(handle, handle.issueStartupToken().token);
    const media = mediaSocket(mediaOptions(cookie));
    await new Promise<void>((resolve) => media.once("open", () => resolve()));
    media.send("plain text is not allowed");
    const closed = await new Promise<number>((resolve) =>
      media.once("close", (code: number) => resolve(code)),
    );
    expect(closed).toBe(1003);
    expect(handle.mediaFrameStats(sessionId)).toEqual({ accepted: 0, rejected: 1 });
  });

  it("Media 压力下 Control 心跳仍然及时响应", async () => {
    const { sessionId, cookie } = await mustExchange(handle, handle.issueStartupToken().token);
    const control = await connectedClient({ port: handle.status.port, cookie }, sessionId);
    const streamId = randomUUID();
    await openStream(control, sessionId, streamId, `open-${streamId}`);
    const media = mediaSocket(mediaOptions(cookie));
    await new Promise<void>((resolve) => media.once("open", () => resolve()));

    let sending = true;
    const sendLoop = (sequence: number): void => {
      if (!sending) {
        return;
      }
      media.send(
        buildMediaFrame({
          streamId,
          frameId: randomUUID(),
          sessionId,
          sequence,
          traceId: randomUUID().replaceAll("-", ""),
          payload: new Uint8Array(2048),
        }),
      );
      setImmediate(() => sendLoop(sequence + 1));
    };
    sendLoop(0);

    // 压力期间做 5 次 clock 采样，Pong 必须及时。
    const latencies: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const started = Date.now();
      control.send(
        clientEnvelope({ sessionId, type: "clock.ping", payload: { c0: String(index) } }),
      );
      await control.waitFor(
        (envelope) =>
          envelope.type === "clock.pong" &&
          (envelope.payload as { c0: string }).c0 === String(index),
        5_000,
      );
      latencies.push(Date.now() - started);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    sending = false;
    expect(Math.max(...latencies)).toBeLessThan(2_000);
    const stats = await waitUntil(() => {
      const value = handle.mediaFrameStats(sessionId);
      return value !== null && value.accepted > 100 ? value : null;
    });
    expect(stats.accepted).toBeGreaterThan(100);
    media.close(1000);
    control.close();
  });
});

async function openStream(
  client: ControlWsClient,
  sessionId: string,
  streamId: string,
  idempotencyKey?: string,
): Promise<void> {
  client.send(
    clientEnvelope({
      sessionId,
      type: "media.stream.open",
      payload: { streamId, mediaKind: "binary-test", contentType: "application/octet-stream" },
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    }),
  );
}

async function waitUntil<T>(probe: () => T | null, timeoutMs = 5_000, intervalMs = 25): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error("waitUntil timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
