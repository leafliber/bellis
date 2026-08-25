import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServerControlEnvelope } from "@bellis/contracts";
import type { RuntimeHandle } from "../../src/index.js";
import {
  cleanupTempDataDirectory,
  createTempDataDirectory,
  mustExchange,
  originFor,
  startTestRuntime,
} from "../helpers.js";
import { clientEnvelope, ControlWsClient, mediaSocket } from "../ws-client.js";

/**
 * Phase 2 角色与 Session 隔离（Gate 2 复审 P0-2）：
 * - 演出回执（scene.ready/stage.capabilities/…）只有 hello 声明
 *   clientType=stage 的连接可提交；观察者连接发送即收到 invalid_message
 *   错误，且不进入 Phase 2 状态机；
 * - 首个 stage hello 决定归属 Session；其它 Session 的 stage hello 不改绑，
 *   其回执也不进入状态机；
 * - Media WebSocket 只有归属 Session 可承载 Phase 2 出站（其它 Session
 *   被 1008 拒绝，不能替换 Stage 媒体连接或接收 PCM）。
 */

let handle: RuntimeHandle;
let dataDirectory: string;

beforeAll(async () => {
  dataDirectory = createTempDataDirectory("bellis-phase2-iso-");
  handle = await startTestRuntime({ dataDirectory, phase2: { enabled: true } });
});

afterAll(async () => {
  await handle.close();
  cleanupTempDataDirectory(dataDirectory);
});

function wsOptions(cookie: string) {
  const port = handle.status.port;
  return { port, path: "/ws/v1/control", cookie, origin: originFor(handle, port) };
}

function mediaOptions(cookie: string) {
  const port = handle.status.port;
  return { port, path: "/ws/v1/media", cookie, origin: originFor(handle, port) };
}

async function connectedClient(
  cookie: string,
  sessionId: string,
  clientType: string,
): Promise<ControlWsClient> {
  const client = new ControlWsClient(wsOptions(cookie));
  await client.opened();
  await client.waitForType("server.hello");
  client.send(
    clientEnvelope({
      sessionId,
      type: "client.hello",
      payload: { protocolVersion: 1, clientType },
    }),
  );
  await client.waitForType("server.ready");
  return client;
}

async function authSession(): Promise<{ sessionId: string; cookie: string }> {
  const issued = handle.issueStartupToken();
  return mustExchange(handle, issued.token);
}

function mediaCloseCode(cookie: string): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const socket = mediaSocket(mediaOptions(cookie));
    const timer = setTimeout(
      () => reject(new Error("media socket neither closed nor opened")),
      5000,
    );
    socket.on("open", () => {
      socket.on("close", (code: number, reason: Buffer) => {
        clearTimeout(timer);
        resolve({ code, reason: reason.toString() });
      });
    });
    socket.on("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      resolve({ code: res.statusCode ?? 0, reason: "http-rejected" });
    });
    socket.on("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function mediaOpen(cookie: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = mediaSocket(mediaOptions(cookie));
    const timer = setTimeout(() => reject(new Error("media socket open timeout")), 5000);
    socket.on("open", () => {
      clearTimeout(timer);
      socket.close(1000, "test-done");
      resolve();
    });
    socket.on("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe("Phase 2 角色与 Session 隔离", () => {
  it("stage hello 前：任何 Session 的 Media WS 都不绑定 Phase 2", async () => {
    const { cookie } = await authSession();
    const closed = await mediaCloseCode(cookie);
    expect(closed.code).toBe(1008);
    expect(closed.reason).toContain("bound stage session");
  });

  it("观察者连接发送演出回执：invalid_message 错误，不进入状态机", async () => {
    const { sessionId, cookie } = await authSession();
    const observer = await connectedClient(cookie, sessionId, "overlay");
    observer.send(
      clientEnvelope({
        sessionId,
        type: "stage.capabilities",
        payload: {
          capabilities: {
            schemaVersion: 1,
            audio: { contentTypes: ["audio/pcm-s16le-48000-mono"], maxBufferedUs: "2000000" },
            subtitle: { supported: true },
            avatar: { adapter: "isolation-test", motions: [], expressions: [] },
          },
        },
      }),
    );
    const error = (await observer.waitForType("error")) as ServerControlEnvelope & {
      payload: { error?: { code?: string; message?: string } };
    };
    expect(error.payload.error?.code).toBe("invalid_message");
    expect(error.payload.error?.message).toContain("clientType=stage");
    observer.close();
  });

  it("首个 stage hello 绑定归属 Session：其 Media 可用，其它 Session 被拒绝", async () => {
    const stage = await authSession();
    const other = await authSession();
    const stageClient = await connectedClient(stage.cookie, stage.sessionId, "stage");
    // 归属 Session 的 Media 连接建立成功。
    await mediaOpen(stage.cookie);
    // 其它 Session 的 Media WS 拒绝（不能替换 Stage 媒体连接）。
    const closed = await mediaCloseCode(other.cookie);
    expect(closed.code).toBe(1008);
    expect(closed.reason).toContain("bound stage session");

    // 其它 Session 即便 hello 成 stage 也不改绑：回执不进入状态机、
    // Media 仍被拒绝。
    const otherStage = await connectedClient(other.cookie, other.sessionId, "stage");
    otherStage.send(
      clientEnvelope({
        sessionId: other.sessionId,
        type: "stage.capabilities",
        payload: {
          capabilities: {
            schemaVersion: 1,
            audio: { contentTypes: ["audio/pcm-s16le-48000-mono"], maxBufferedUs: "2000000" },
            subtitle: { supported: true },
            avatar: { adapter: "isolation-test", motions: [], expressions: [] },
          },
        },
      }),
    );
    // 静默忽略（连接角色合法，但非绑定连接）：无 error、无状态机副作用。
    const silent = await otherStage.waitForType("error", 500).catch(() => null);
    expect(silent).toBeNull();
    const closedAgain = await mediaCloseCode(other.cookie);
    expect(closedAgain.code).toBe(1008);
    otherStage.close();
    stageClient.close();
  });
});
