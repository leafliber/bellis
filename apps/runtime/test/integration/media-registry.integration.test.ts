import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RuntimeHandle } from "../../src/index.js";
import {
  cleanupTempDataDirectory,
  createTempDataDirectory,
  mustExchange,
  originFor,
  startTestRuntime,
} from "../helpers.js";
import { buildMediaFrame, clientEnvelope, ControlWsClient, mediaSocket } from "../ws-client.js";
import type { WebSocket } from "ws";

/**
 * Media Registry 生命周期回归（P4 修复 7）：
 * - 同一 Session 同时只允许一条 Media 连接；
 * - Registry 所有权与 Media 连接绑定：关闭/重连重建全新 Registry，
 *   totalStreams 计数不跨连接继承；
 * - Control 重连不重置计数（Registry 跨 Control 重连保留墓碑）。
 */

let handle: RuntimeHandle;
let dataDirectory: string;

beforeAll(async () => {
  dataDirectory = createTempDataDirectory("bellis-p4-mreg-");
  handle = await startTestRuntime({ dataDirectory: dataDirectory, maxTotalStreams: 2 });
});

afterAll(async () => {
  await handle.close();
  cleanupTempDataDirectory(dataDirectory);
});

async function openControl(sessionId: string, cookie: string): Promise<ControlWsClient> {
  const client = new ControlWsClient({
    port: handle.status.port,
    path: "/ws/v1/control",
    cookie,
    origin: originFor(handle),
  });
  await client.opened();
  // resume 连接上 P1 会 hold server.hello 直到 client.hello：先发 hello。
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

async function openMedia(cookie: string): Promise<WebSocket> {
  const socket = mediaSocket({
    port: handle.status.port,
    path: "/ws/v1/media",
    cookie,
    origin: originFor(handle),
  });
  await new Promise<void>((resolve) => socket.once("open", () => resolve()));
  return socket;
}

function openStreamMessage(client: ControlWsClient, sessionId: string, streamId: string): void {
  client.send(
    clientEnvelope({
      sessionId,
      type: "media.stream.open",
      payload: { streamId, mediaKind: "binary-test", contentType: "application/octet-stream" },
      idempotencyKey: `reg-${streamId}`,
    }),
  );
}

describe("Media Registry 生命周期", () => {
  it("同一 Session 的第二条 Media 连接被拒绝（1008）", async () => {
    const { sessionId, cookie } = await mustExchange(handle, handle.issueStartupToken().token);
    const control = await openControl(sessionId, cookie);
    const media1 = await openMedia(cookie);
    const media2 = mediaSocket({
      port: handle.status.port,
      path: "/ws/v1/media",
      cookie,
      origin: originFor(handle),
    });
    const closeCode = await new Promise<number>((resolve) => {
      media2.once("close", (code: number) => resolve(code));
    });
    expect(closeCode).toBe(1008);
    media1.close(1000);
    control.close();
  });

  it("总量上限内的注册成功；超限被拒绝", async () => {
    const { sessionId, cookie } = await mustExchange(handle, handle.issueStartupToken().token);
    const control = await openControl(sessionId, cookie);
    const media = await openMedia(cookie);
    const first = randomUUID();
    const second = randomUUID();
    const third = randomUUID();
    openStreamMessage(control, sessionId, first);
    openStreamMessage(control, sessionId, second);
    openStreamMessage(control, sessionId, third);
    // 前两个注册无回执；第三个总量超限 → 稳定错误。
    const error = await control.waitFor(
      (envelope) =>
        envelope.type === "error" &&
        (envelope.payload as { error: { message: string } }).error.message.includes(
          "total_stream_limit_reached",
        ),
    );
    expect((error.payload as { error: { code: string } }).error.code).toBe("invalid_message");
    media.close(1000);
    control.close();
  });

  it("Media 重连重建 Registry：totalStreams 计数不继承（P4 修复 7）", async () => {
    const { sessionId, cookie } = await mustExchange(handle, handle.issueStartupToken().token);
    const control = await openControl(sessionId, cookie);

    // 第一条 Media 连接：注册 2 个 Stream（到达 maxTotalStreams）。
    const media1 = await openMedia(cookie);
    openStreamMessage(control, sessionId, randomUUID());
    openStreamMessage(control, sessionId, randomUUID());
    await new Promise((resolve) => setTimeout(resolve, 200));
    media1.close(1000);
    await new Promise((resolve) => setTimeout(resolve, 150));

    // 重连：全新 Registry，配额重置，再注册 2 个新 Stream 并发帧成功。
    const media2 = await openMedia(cookie);
    const streamId = randomUUID();
    openStreamMessage(control, sessionId, streamId);
    await new Promise((resolve) => setTimeout(resolve, 150));
    media2.send(
      buildMediaFrame({
        streamId,
        frameId: randomUUID(),
        sessionId,
        sequence: 0,
        traceId: randomUUID().replaceAll("-", ""),
      }),
    );
    const deadline = Date.now() + 5_000;
    while (handle.mediaFrameStats(sessionId)?.accepted !== 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(handle.mediaFrameStats(sessionId)).toEqual({ accepted: 1, rejected: 0 });
    media2.close(1000);
    control.close();
  });

  it("Control 重连不重置 Registry：旧连接的总量计数保留（墓碑语义）", async () => {
    const { sessionId, cookie } = await mustExchange(handle, handle.issueStartupToken().token);
    const control1 = await openControl(sessionId, cookie);
    const media = await openMedia(cookie);
    openStreamMessage(control1, sessionId, randomUUID());
    openStreamMessage(control1, sessionId, randomUUID());
    await new Promise((resolve) => setTimeout(resolve, 200));
    control1.close();
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Control 重连（同 Session）：Registry 未重建，第 3 个注册仍超限。
    const control2 = await openControl(sessionId, cookie);
    openStreamMessage(control2, sessionId, randomUUID());
    const error = await control2.waitFor(
      (envelope) =>
        envelope.type === "error" &&
        (envelope.payload as { error: { message: string } }).error.message.includes(
          "total_stream_limit_reached",
        ),
    );
    expect(error).toBeDefined();
    // Media 重连后配额重置。
    media.close(1000);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await openMedia(cookie);
    const streamId = randomUUID();
    openStreamMessage(control2, sessionId, streamId);
    await new Promise((resolve) => setTimeout(resolve, 150));
    control2.close();
  });
});
