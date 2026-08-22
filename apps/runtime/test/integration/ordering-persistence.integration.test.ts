import { afterAll, describe, expect, it } from "vitest";
import { PersistenceError } from "@bellis/persistence";
import type { PersistenceClient } from "@bellis/persistence";
import type { RuntimeHandle } from "../../src/index.js";
import { startRuntime } from "../../src/index.js";
import {
  cleanupTempDataDirectory,
  createMigratedBaseClient,
  createTempDataDirectory,
  mustExchange,
  originFor,
  startTestRuntime,
  WORKER_FIXTURE,
  wrapPersistenceClient,
} from "../helpers.js";
import { clientEnvelope, ControlWsClient } from "../ws-client.js";

/**
 * 顺序与失败路径回归（P4 第一轮评审修复 2/3/9/4）：
 * - Seq 水位落库先于发送（延迟/失败注入）；
 * - Replay Gap 快照严格先于 server.ready 与业务消息；
 * - HTTP 边界的 Persistence 错误按集中映射返回；
 * - 关闭流程在在途提交/步骤异常/重复关闭下零残留。
 */

const directories: string[] = [];
const baseClients: PersistenceClient[] = [];

function tempDirectory(prefix: string): string {
  const directory = createTempDataDirectory(prefix);
  directories.push(directory);
  return directory;
}

afterAll(async () => {
  for (const client of baseClients.splice(0)) {
    await client.close().catch(() => undefined);
  }
  for (const directory of directories.splice(0)) {
    cleanupTempDataDirectory(directory);
  }
});

async function connectedClient(
  handle: RuntimeHandle,
  cookie: string,
  sessionId: string,
  options?: { lastAck?: bigint },
): Promise<ControlWsClient> {
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
      payload: {
        protocolVersion: 1,
        clientType: "test-client",
        ...(options?.lastAck === undefined ? {} : { lastAck: options.lastAck.toString() }),
      },
    }),
  );
  return client;
}

describe("Seq 水位先于发送（P4 修复 2/11）", () => {
  it("advanceServerSeq 延迟时，Pong 在延迟结束前不会送达", async () => {
    const directory = tempDirectory("bellis-p4-seqdelay-");
    const base = await createMigratedBaseClient(directory);
    baseClients.push(base);
    const releaseGate = { fn: null as null | (() => void) };
    const gate = new Promise<void>((resolve) => {
      releaseGate.fn = resolve;
    });
    let delayed = false;
    const handle = await startTestRuntime({
      dataDirectory: directory,
      persistenceClient: wrapPersistenceClient(base, {
        advanceServerSeq: (input) => {
          if (!delayed && input.latestServerSeq >= 3n) {
            delayed = true;
            return gate.then(() => base.advanceServerSeq(input));
          }
          return base.advanceServerSeq(input);
        },
      }),
    });
    try {
      const { sessionId, cookie } = await mustExchange(handle, handle.issueStartupToken().token);
      const client = await connectedClient(handle, cookie, sessionId);
      await client.waitForType("server.ready");
      const sentAt = Date.now();
      client.send(clientEnvelope({ sessionId, type: "clock.ping", payload: { c0: "1" } }));
      // 延迟未解除：500ms 内不允许 Pong 上线。
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(client.received.some((envelope) => envelope.type === "clock.pong")).toBe(false);
      releaseGate.fn?.();
      const pong = await client.waitForType("clock.pong");
      expect(Date.now() - sentAt).toBeGreaterThanOrEqual(500);
      void pong;
      client.close();
    } finally {
      await handle.close();
    }
  });

  it("advanceServerSeq 失败时消息不发送，连接降级关闭（1011）", async () => {
    const directory = tempDirectory("bellis-p4-seqfail-");
    const base = await createMigratedBaseClient(directory);
    baseClients.push(base);
    const handle = await startTestRuntime({
      dataDirectory: directory,
      persistenceClient: wrapPersistenceClient(base, {
        advanceServerSeq: () =>
          Promise.reject(new PersistenceError("unavailable", "injected seq persist failure")),
      }),
    });
    try {
      const { cookie } = await mustExchange(handle, handle.issueStartupToken().token);
      const client = new ControlWsClient({
        port: handle.status.port,
        path: "/ws/v1/control",
        cookie,
        origin: originFor(handle),
      });
      await client.opened();
      // server.hello 的 Seq 落库即失败：不发送 hello，连接 1011 关闭。
      const closeCode = await client.closed();
      expect(closeCode).toBe(1011);
      expect(client.received.length).toBe(0);
    } finally {
      await handle.close();
    }
  });
});

describe("Replay Gap 快照顺序（P4 修复 3）", () => {
  it("session.snapshot 严格先于 server.ready 与业务消息", async () => {
    const directory = tempDirectory("bellis-p4-snaporder-");
    const handle = await startTestRuntime({
      dataDirectory: directory,
      replayWindowCapacity: 2,
    });
    try {
      const { sessionId, cookie } = await mustExchange(handle, handle.issueStartupToken().token);
      const first = await connectedClient(handle, cookie, sessionId);
      await first.waitForType("server.ready");
      for (let index = 0; index < 4; index += 1) {
        first.send(clientEnvelope({ sessionId, type: "heartbeat.ping", payload: {} }));
        await first.waitForType("heartbeat.pong");
      }
      first.terminate();
      await new Promise((resolve) => setTimeout(resolve, 200));

      // 以 lastAck=0 重连 → Replay Gap → 快照必须先于 ready。
      const resumed = await connectedClient(handle, cookie, sessionId, { lastAck: 0n });
      const snapshot = await resumed.waitForType("session.snapshot");
      const ready = await resumed.waitForType("server.ready");
      const snapshotIndex = resumed.received.findIndex((envelope) => envelope === snapshot);
      const readyIndex = resumed.received.findIndex((envelope) => envelope === ready);
      const helloIndex = resumed.received.findIndex((envelope) => envelope.type === "server.hello");
      expect(helloIndex).toBeGreaterThanOrEqual(0);
      expect(snapshotIndex).toBeGreaterThan(helloIndex);
      expect(readyIndex).toBeGreaterThan(snapshotIndex);
      // 业务消息（Pong）在 ready 之后。
      resumed.send(clientEnvelope({ sessionId, type: "clock.ping", payload: { c0: "9" } }));
      const pong = await resumed.waitForType("clock.pong");
      expect(resumed.received.findIndex((envelope) => envelope === pong)).toBeGreaterThan(
        readyIndex,
      );
      const payload = (snapshot.payload as { snapshot: { reason: string; activeScene: null } })
        .snapshot;
      expect(payload.reason).toBe("replay_gap");
      expect(payload.activeScene).toBeNull();
      resumed.close();
    } finally {
      await handle.close();
      cleanupTempDataDirectory(directory);
    }
  });
});

describe("HTTP 边界的 Persistence 错误映射（P4 修复 9）", () => {
  async function exchangeStatus(
    error: PersistenceError,
  ): Promise<{ status: number; body: { code: string; retryable: boolean } }> {
    const directory = tempDirectory("bellis-p4-httpmap-");
    const base = await createMigratedBaseClient(directory);
    baseClients.push(base);
    const handle = await startTestRuntime({
      dataDirectory: directory,
      persistenceClient: wrapPersistenceClient(base, {
        ensureSession: () => Promise.reject(error),
      }),
    });
    try {
      const token = handle.issueStartupToken().token;
      const response = await fetch(`http://127.0.0.1:${handle.status.port}/api/v1/auth/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: originFor(handle) },
        body: JSON.stringify({ startupToken: token }),
      });
      const body = (await response.json()) as { code: string; retryable: boolean };
      return { status: response.status, body };
    } finally {
      await handle.close();
    }
  }

  it("database_busy → 503 backpressure（可重试）", async () => {
    const result = await exchangeStatus(new PersistenceError("database_busy", "injected busy"));
    expect(result.status).toBe(503);
    expect(result.body.code).toBe("backpressure");
    expect(result.body.retryable).toBe(true);
  });

  it("unavailable → 503 not_ready（可重试）", async () => {
    const result = await exchangeStatus(
      new PersistenceError("unavailable", "injected unavailable"),
    );
    expect(result.status).toBe(503);
    expect(result.body.code).toBe("not_ready");
    expect(result.body.retryable).toBe(true);
  });

  it("deadline_exceeded → 504（不可重试）", async () => {
    const result = await exchangeStatus(
      new PersistenceError("deadline_exceeded", "injected deadline"),
    );
    expect(result.status).toBe(504);
    expect(result.body.code).toBe("deadline_exceeded");
    expect(result.body.retryable).toBe(false);
  });
});

describe("关闭鲁棒性（P4 修复 4）", () => {
  it("在途 Commit 期间关闭：等待结束、零 Worker/句柄残留", async () => {
    const directory = tempDirectory("bellis-p4-closeinflight-");
    const base = await createMigratedBaseClient(directory);
    baseClients.push(base);
    const releaseGate = { fn: null as null | (() => void) };
    const gate = new Promise<void>((resolve) => {
      releaseGate.fn = resolve;
    });
    const handle = await startTestRuntime({
      dataDirectory: directory,
      persistenceClient: wrapPersistenceClient(base, {
        commitScene: (input) => gate.then(() => base.commitScene(input)),
      }),
    });
    const { sessionId } = await mustExchange(handle, handle.issueStartupToken().token);
    const commitPromise = handle
      .commitFakeScene({
        sessionId,
        sceneId: "22222222-2222-4222-8222-222222000001",
        cycleId: "33333333-3333-4333-8333-333333000001",
        idempotencyKey: "close-inflight-1",
        cues: [],
        watermarks: [{ source: "close", watermark: 1n }],
      })
      .then(
        () => "fulfilled",
        () => "rejected",
      );
    await new Promise((resolve) => setTimeout(resolve, 150));
    releaseGate.fn?.();
    // 关闭与在途提交并发：close 等待（有界）后正常结束。
    await handle.close();
    const outcome = await commitPromise;
    expect(outcome).toBe("fulfilled");
    await handle.closed;
    expect(handle.status.phase).toBe("closed");
    expect(process.getActiveResourcesInfo().filter((name) => name === "Worker").length).toBe(0);
  });

  it("关闭期间新提交被拒绝为 not_ready", async () => {
    const directory = tempDirectory("bellis-p4-closedrain-");
    const base = await createMigratedBaseClient(directory);
    baseClients.push(base);
    const handle = await startTestRuntime({ dataDirectory: directory, persistenceClient: base });
    const { sessionId } = await mustExchange(handle, handle.issueStartupToken().token);
    const closing = handle.close();
    await expect(
      handle.commitFakeScene({
        sessionId,
        sceneId: "22222222-2222-4222-8222-222222000002",
        cycleId: "33333333-3333-4333-8333-333333000002",
        idempotencyKey: "closed-drain-1",
        cues: [],
        watermarks: [],
      }),
    ).rejects.toThrow(/shutting down|not ready/i);
    await closing;
  });

  it("关闭步骤抛错：聚合 reject 但 closed 兑现、重复 close 不挂起", async () => {
    const directory = tempDirectory("bellis-p4-closefail-");
    const base = await createMigratedBaseClient(directory);
    baseClients.push(base);
    let closeThrows = false;
    const handle = await startTestRuntime({
      dataDirectory: directory,
      persistenceClient: wrapPersistenceClient(base, {
        close: () => {
          closeThrows = true;
          return Promise.reject(new Error("injected close failure"));
        },
      }),
    });
    await expect(handle.close()).rejects.toThrow(/runtime close failed/i);
    expect(closeThrows).toBe(true);
    // closed 仍兑现；重复 close 不等待、不挂起。
    await handle.closed;
    expect(handle.status.phase).toBe("closed");
    await handle.close();
    expect(process.getActiveResourcesInfo().filter((name) => name === "Worker").length).toBe(0);
  });

  it("注入 LoggerPort 的装配（RuntimeOptions.logger 兼容选项）", async () => {
    const directory = tempDirectory("bellis-p4-logger-");
    const events: string[] = [];
    const handle = await startRuntime({
      config: { dataDirectory: directory, runtimeVersion: "0.1.0-test", port: 0 },
      persistenceWorker: WORKER_FIXTURE,
      logger: {
        log: (_level, event) => {
          events.push(event);
        },
        child: () => {
          throw new Error("child logger is not used by the runtime assembly");
        },
      },
    });
    try {
      expect(handle.status.ready).toBe(true);
      expect(events).toContain("runtime_listening");
    } finally {
      await handle.close();
      cleanupTempDataDirectory(directory);
    }
  });
});
