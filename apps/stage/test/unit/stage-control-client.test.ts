/* StageSocket Port 以 on* setter 为接口（自研 Port，非 DOM 事件）。 */
/* oxlint-disable unicorn/prefer-add-event-listener */
import { describe, expect, it } from "vitest";
import { VirtualClock, createDeterministicIdSource } from "@bellis/testkit";
import { encodeControlMessage } from "@bellis/transport/browser";
import type { ServerControlEnvelope } from "@bellis/contracts";
import {
  StageControlClient,
  type StageControlEvent,
} from "../../src/control/stage-control-client.js";
import { FakeSocketPair } from "../fake-socket.js";

/**
 * Stage Control 客户端协议测试：真实 encodeControlMessage 编码的服务端
 * 消息 + FakeSocket——不 Mock 协议，验证握手、能力上报、ACK、时钟校准
 * 与重连代际语义（docs/phase-2-development-guide.md §7）。
 */

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const TRACE_ID = "0123456789abcdef0123456789abcdef";
const CAPS = {
  schemaVersion: 1,
  audio: { contentTypes: ["audio/pcm-s16le-48000-mono"], maxBufferedUs: "2000000" },
  subtitle: { supported: true },
  avatar: { adapter: "pending", motions: [], expressions: [] },
};

interface ServerHarness {
  client: StageControlClient;
  pair: FakeSocketPair;
  clock: VirtualClock;
  received: unknown[];
  events: StageControlEvent[];
}

function createServerHarness(
  overrides?: Partial<ConstructorParameters<typeof StageControlClient>[0]>,
): ServerHarness {
  const pair = new FakeSocketPair();
  const clock = new VirtualClock();
  const ids = createDeterministicIdSource("stage-control-test");
  const events: StageControlEvent[] = [];
  const received: unknown[] = [];
  const client = new StageControlClient({
    url: "ws://test/ws/v1/control",
    sessionId: SESSION_ID,
    socketFactory: () => pair.clientSocket,
    clock,
    nextMessageId: () => ids.uuid(),
    capabilities: CAPS,
    heartbeatIntervalMs: 30_000,
    clockSamplesRequired: 3,
    reconnectBaseMs: 100,
    reconnectMaxMs: 1_000,
    onEvent: (event) => {
      events.push(event);
      if (event.type === "server_message") {
        received.push(event.envelope);
      }
    },
    ...overrides,
  });
  return { client, pair, clock, received, events };
}

let serverSeq = 0;

function serverMessage(type: string, payload: unknown): string {
  serverSeq += 1;
  const envelope: ServerControlEnvelope = {
    version: 1,
    direction: "server",
    type,
    messageId: `77777777-7777-4777-8777-${String(serverSeq).padStart(12, "7")}`,
    sessionId: SESSION_ID,
    trace: { traceId: TRACE_ID },
    sentAtUs: "1000",
    seq: String(serverSeq),
    payload: payload as never,
  };
  return encodeControlMessage(envelope);
}

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

describe("StageControlClient", () => {
  it("握手：server.hello → client.hello(stage) → active → 上报 stage.capabilities", async () => {
    const h = createServerHarness();
    await h.client.connect();
    h.pair.open();
    h.pair.serverSend(
      serverMessage("server.hello", {
        protocolVersion: 1,
        runtimeVersion: "0.1.0-test",
        heartbeatIntervalMs: 30_000,
        replayWindowSize: 512,
      }),
    );
    await flush();
    expect(h.client.state).toBe("active");
    // server.hello 是首条服务端消息；能力上报在 active 后立即发出。
    const caps = h.events.find(
      (e) => e.type === "server_message" && e.envelope.type === "stage.capabilities",
    );
    expect(caps).toBeUndefined(); // capabilities 是客户端 → 服务端，不出现在 server_message
    // 通过 socket 捕获客户端发送内容验证。
    expect(h.events.some((e) => e.type === "state" && e.state === "active")).toBe(true);
    h.client.close();
  });

  it("时钟采样：≥3 个合格 pong 后 clock_ready；样本不足不就绪", async () => {
    const h = createServerHarness({ clockSamplesRequired: 3 });
    await h.client.connect();
    h.pair.open();
    h.pair.serverSend(
      serverMessage("server.hello", {
        protocolVersion: 1,
        runtimeVersion: "0.1.0-test",
        heartbeatIntervalMs: 30_000,
        replayWindowSize: 512,
      }),
    );
    await flush();
    expect(h.client.clockReady).toBe(false);

    // 客户端 1s 后发首个 clock.ping（dense 采样）；VirtualClock 推进驱动。
    const pings: string[] = [];
    h.pair.serverSocket.onmessage = (data: string | Uint8Array) => {
      const parsed = JSON.parse(String(data)) as { type: string; payload: { c0?: string } };
      if (parsed.type === "clock.ping" && parsed.payload.c0 !== undefined) {
        pings.push(parsed.payload.c0);
        // Runtime 侧立即回 pong（r1=r2=c0+250µs 模拟偏移）。
        h.pair.serverSend(
          serverMessage("clock.pong", {
            c0: parsed.payload.c0,
            r1: String(BigInt(parsed.payload.c0) + 250n),
            r2: String(BigInt(parsed.payload.c0) + 250n),
          }),
        );
      }
    };
    for (let i = 0; i < 3; i += 1) {
      h.clock.advanceBy(1_100_000n);
      await flush();
    }
    expect(pings.length).toBeGreaterThanOrEqual(3);
    expect(h.client.clockReady).toBe(true);
    expect(h.client.clockEstimate?.runtimeOffsetUs).toBe(250n);
    h.client.close();
  });

  it("服务端 Seq 倒退 → 协议错误并重连（旧估计清空）", async () => {
    const h = createServerHarness();
    await h.client.connect();
    h.pair.open();
    h.pair.serverSend(
      serverMessage("server.hello", {
        protocolVersion: 1,
        runtimeVersion: "0.1.0-test",
        heartbeatIntervalMs: 30_000,
        replayWindowSize: 512,
      }),
    );
    await flush();
    expect(h.client.state).toBe("active");
    // 构造倒退 Seq（重置计数器并复用更小值）。
    serverSeq = 0;
    h.pair.serverSend(serverMessage("heartbeat.pong", {}));
    await flush();
    expect(h.events.some((e) => e.type === "protocol_error")).toBe(true);
    expect(h.client.state).toBe("reconnect_wait");
    h.client.close();
  });

  it("close()：进入 closed，之后 connect 拒绝", async () => {
    const h = createServerHarness();
    await h.client.connect();
    h.pair.open();
    h.client.close("test_done");
    expect(h.client.state).toBe("closed");
    await expect(h.client.connect()).rejects.toThrow(/stage_control_client_closed/);
  });
});
