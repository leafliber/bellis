import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VirtualClock } from "@bellis/testkit";
import { StageApp, type StageAppState } from "../../src/bootstrap/stage-app.js";

/* FakeSocketPort 以 on* setter 为接口。 */
/* oxlint-disable unicorn/prefer-add-event-listener */
import { FakeSocketPair } from "../fake-socket.js";

/**
 * StageApp 引导状态机测试：booting → auth_ready → control_ready →
 * clock_ready → performance_ready，以及统一 close()。
 */

const CAPS = {
  schemaVersion: 1,
  audio: { contentTypes: ["audio/pcm-s16le-48000-mono"], maxBufferedUs: "2000000" },
  subtitle: { supported: true },
  avatar: { adapter: "pending", motions: [], expressions: [] },
};

let serverSeq = 0;

function createApp(states: StageAppState[]): {
  app: StageApp;
  pair: FakeSocketPair;
  clock: VirtualClock;
} {
  const pair = new FakeSocketPair();
  const clock = new VirtualClock();
  let seq = 0;
  const app = new StageApp({
    clock,
    nextMessageId: () => `88888888-8888-4888-8888-88888888888${seq++ % 10}`,
    capabilities: CAPS,
    socketFactory: () => pair.clientSocket,
    authenticate: async () => ({
      sessionId: "11111111-1111-4111-8111-111111111111",
      controlUrl: "ws://test/ws/v1/control",
    }),
    heartbeatIntervalMs: 30_000,
    onStateChange: (state) => states.push(state),
  });
  return { app, pair, clock };
}

function serverHello(pair: FakeSocketPair): void {
  pair.serverSend(
    JSON.stringify({
      version: 1,
      direction: "server",
      type: "server.hello",
      messageId: "77777777-7777-4777-8777-777777777777",
      sessionId: "11111111-1111-4111-8111-111111111111",
      trace: { traceId: "0123456789abcdef0123456789abcdef" },
      sentAtUs: "1",
      seq: String(++serverSeq),
      payload: {
        protocolVersion: 1,
        runtimeVersion: "0.1.0-test",
        heartbeatIntervalMs: 30_000,
        replayWindowSize: 512,
      },
    }),
  );
}

describe("StageApp", () => {
  it("完整引导链 + close() 零残留", async () => {
    const states: StageAppState[] = [];
    const { app, pair, clock } = createApp(states);
    const starting = app.start();
    await Promise.resolve();
    pair.open();
    serverHello(pair);
    await starting;
    expect(states).toContain("auth_ready");
    expect(states).toContain("control_ready");
    // 时钟校准：注入 3 个 RTT=0 样本。
    pair.serverSocket.onmessage = (data: string | Uint8Array) => {
      const parsed = JSON.parse(String(data)) as { type: string; payload: { c0?: string } };
      if (parsed.type === "clock.ping" && parsed.payload.c0 !== undefined) {
        pair.serverSend(
          JSON.stringify({
            version: 1,
            direction: "server",
            type: "clock.pong",
            messageId: "77777777-7777-4777-8777-777777777771",
            sessionId: "11111111-1111-4111-8111-111111111111",
            trace: { traceId: "0123456789abcdef0123456789abcdef" },
            sentAtUs: "2",
            seq: String(++serverSeq),
            payload: {
              c0: parsed.payload.c0,
              r1: String(BigInt(parsed.payload.c0) + 100n),
              r2: String(BigInt(parsed.payload.c0) + 100n),
            },
          }),
        );
      }
    };
    for (let i = 0; i < 3; i += 1) {
      clock.advanceBy(1_100_000n);
      for (let j = 0; j < 8; j += 1) {
        await Promise.resolve();
      }
    }
    expect(states).toContain("clock_ready");
    expect(states).toContain("performance_ready");
    expect(app.state).toBe("performance_ready");

    await app.close("test_complete");
    expect(app.state).toBe("closed");
    expect(states[states.length - 1]).toBe("closed");
  });

  it("重复 start 拒绝；认证失败保持在 booting 并暴露错误路径", async () => {
    const pair = new FakeSocketPair();
    const app = new StageApp({
      clock: new VirtualClock(),
      nextMessageId: () => "88888888-8888-4888-8888-888888888888",
      capabilities: CAPS,
      socketFactory: () => pair.clientSocket,
      authenticate: async () => {
        throw new Error("stage_auth_failed_401");
      },
    });
    await expect(app.start()).rejects.toThrow(/stage_auth_failed_401/);
    expect(app.state).toBe("booting");
    await expect(app.start()).rejects.toThrow(/stage_app_already_started|booting/);
  });
});

describe("浏览器 Bundle 扫描（构建产物存在时）", () => {
  const distWeb = join(import.meta.dirname, "../../dist-web/assets");

  it("dist-web 存在时：无 node: 导入、无 hrtime/SystemMonotonicClock", { timeout: 10_000 }, () => {
    if (!existsSync(distWeb)) {
      return; // 未构建（纯 test 阶段）：由 transport 的 browser-entry 静态扫描兜底。
    }
    for (const file of readdirSync(distWeb)) {
      if (!file.endsWith(".js")) {
        continue;
      }
      const source = readFileSync(join(distWeb, file), "utf8");
      expect(/\bfrom\s*["']node:/.test(source), file).toBe(false);
      expect(/\brequire\(\s*["']node:/.test(source), file).toBe(false);
      expect(/process\.hrtime/.test(source), file).toBe(false);
      expect(/SystemMonotonicClock/.test(source), file).toBe(false);
    }
  });
});
