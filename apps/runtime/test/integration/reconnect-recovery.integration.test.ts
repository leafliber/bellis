import { getEventListeners } from "node:events";
import { afterAll, describe, expect, it } from "vitest";
import { PersistenceError } from "@bellis/persistence";
import type { PersistenceClient } from "@bellis/persistence";
import type { RuntimeHandle } from "../../src/index.js";
import {
  cleanupTempDataDirectory,
  createMigratedBaseClient,
  createTempDataDirectory,
  originFor,
  startTestRuntime,
  wrapPersistenceClient,
} from "../helpers.js";
import { clientEnvelope, ControlWsClient } from "../ws-client.js";

/**
 * 重连恢复与代际边界回归（P4 二轮评审修复 2/3/4/6/7）：
 * - 断线与 advanceServerSeq 并发：恢复连接先把 resume 水位与 P2 单调
 *   对账，任何 Replay/新消息在补齐落库前不得上线；
 * - 恢复读取失败（database_busy/unavailable/deadline_exceeded）→ 1011
 *   失败关闭，不降级为全新 Session；resume 未携带 lastAck → 强制快照；
 * - scene.prepared 写出失败/超时：内部提交照常，绝不发布无因果的
 *   committed；prepared/committed 必须送达同一连接代际；
 * - Fake Commit 的 Abort 合并监听器在完成后移除（无泄漏）；
 * - WS 层 maxPayload 同时覆盖 Control 与 Media 上限。
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

function cookieFrom(response: Response): string {
  return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

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

const SCENE_INPUT = {
  sessionId: "",
  sceneId: "44444444-4444-4444-8444-444444000001",
  cycleId: "55555555-5555-4555-8555-555555000001",
  idempotencyKey: "reconnect-recovery-1",
  cues: [{ cueId: "66666666-6666-4666-8666-666666666666", lane: "subtitle" as const }],
  watermarks: [{ source: "race.test", watermark: 42n }],
};

describe("断线与 Seq 落库并发（二轮评审修复 2）", () => {
  it("落库挂起期间断线：重连后水位对账完成前任何消息不得上线", async () => {
    const directory = tempDirectory("bellis-p4-rr2-race-");
    const base = await createMigratedBaseClient(directory);
    baseClients.push(base);
    const pending: Array<() => void> = [];
    let holdsLeft = 0;
    const handle = await startTestRuntime({
      dataDirectory: directory,
      persistenceClient: wrapPersistenceClient(base, {
        advanceServerSeq: (input) => {
          if (input.latestServerSeq >= 3n && holdsLeft > 0) {
            holdsLeft -= 1;
            return new Promise<void>((resolve) => {
              pending.push(resolve);
            }).then(() => base.advanceServerSeq(input));
          }
          return base.advanceServerSeq(input);
        },
      }),
    });
    try {
      const token = handle.issueStartupToken().token;
      const exchange = await fetch(`http://127.0.0.1:${handle.status.port}/api/v1/auth/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: originFor(handle) },
        body: JSON.stringify({ startupToken: token }),
      });
      const { sessionId } = (await exchange.json()) as { sessionId: string };
      const cookie = cookieFrom(exchange);

      // 连接 1：hello(1)/ready(2) 正常；挂起 pong(3) 的落库后立即断线。
      const first = await connectedClient(handle, cookie, sessionId);
      await first.waitForType("server.ready");
      holdsLeft = 1;
      first.send(clientEnvelope({ sessionId, type: "clock.ping", payload: { c0: "race" } }));
      first.terminate();
      await new Promise((resolve) => setTimeout(resolve, 150));

      // 连接 2（同进程导出状态 resume）：对账 advanceServerSeq(3) 也被挂起
      // （holdsLeft 已置 1）——水位补齐前不得发送任何字节（含 server.hello）。
      holdsLeft = 1;
      const second = await connectedClient(handle, cookie, sessionId, { lastAck: 0n });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(second.received.length).toBe(0);

      // 解除挂起：对账完成 → hello/重放/ready 才上线。
      for (const release of pending.splice(0)) {
        release();
      }
      await second.waitForType("server.hello");
      await second.waitForType("server.ready");
      // 全部已分配 Seq 都已落库（对账补齐 3，hello(4) 亦随发送落库）。
      const recovery = await handle.readSessionRecovery(sessionId);
      expect(recovery.latestServerSeq).toBeGreaterThanOrEqual(3n);
      second.close();
    } finally {
      await handle.close();
    }
  });

  it("恢复水位对账失败：1011 失败关闭，无任何 Replay 上线", async () => {
    const directory = tempDirectory("bellis-p4-rr2-recon-");
    const base = await createMigratedBaseClient(directory);
    baseClients.push(base);
    let failReconcile = false;
    const handle = await startTestRuntime({
      dataDirectory: directory,
      persistenceClient: wrapPersistenceClient(base, {
        advanceServerSeq: (input) => {
          if (failReconcile && input.latestServerSeq >= 3n) {
            return Promise.reject(new PersistenceError("unavailable", "injected reconcile fail"));
          }
          return base.advanceServerSeq(input);
        },
      }),
    });
    try {
      const token = handle.issueStartupToken().token;
      const exchange = await fetch(`http://127.0.0.1:${handle.status.port}/api/v1/auth/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: originFor(handle) },
        body: JSON.stringify({ startupToken: token }),
      });
      const { sessionId } = (await exchange.json()) as { sessionId: string };
      const cookie = cookieFrom(exchange);

      const first = await connectedClient(handle, cookie, sessionId);
      await first.waitForType("server.ready");
      first.send(clientEnvelope({ sessionId, type: "clock.ping", payload: { c0: "1" } }));
      await first.waitForType("clock.pong");
      first.terminate();
      await new Promise((resolve) => setTimeout(resolve, 150));

      failReconcile = true;
      const second = await connectedClient(handle, cookie, sessionId, { lastAck: 0n });
      const closeCode = await second.closed();
      expect(closeCode).toBe(1011);
      expect(second.received.length).toBe(0);
    } finally {
      await handle.close();
    }
  });
});

describe("恢复读取失败与强制快照（二轮评审修复 3）", () => {
  it.each(["database_busy", "unavailable", "deadline_exceeded"] as const)(
    "readRecoveryState 抛 %s：重连 1011 失败关闭，零帧上线",
    async (code) => {
      const directory = tempDirectory(`bellis-p4-rr3-${code}-`);
      const base = await createMigratedBaseClient(directory);
      baseClients.push(base);
      let armed = false;
      const handle = await startTestRuntime({
        dataDirectory: directory,
        persistenceClient: wrapPersistenceClient(base, {
          readRecoveryState: (sessionId: string) =>
            armed
              ? Promise.reject(new PersistenceError(code, `injected ${code}`))
              : base.readRecoveryState(sessionId),
        }),
      });
      try {
        const token = handle.issueStartupToken().token;
        const exchange = await fetch(
          `http://127.0.0.1:${handle.status.port}/api/v1/auth/exchange`,
          {
            method: "POST",
            headers: { "content-type": "application/json", origin: originFor(handle) },
            body: JSON.stringify({ startupToken: token }),
          },
        );
        const { sessionId } = (await exchange.json()) as { sessionId: string };
        const cookie = cookieFrom(exchange);

        const first = await connectedClient(handle, cookie, sessionId);
        await first.waitForType("server.ready");
        first.terminate();
        await new Promise((resolve) => setTimeout(resolve, 100));

        // 恢复读取失败：不得降级为全新 Seq 的 Session（1011 关闭）。
        armed = true;
        const client = new ControlWsClient({
          port: handle.status.port,
          path: "/ws/v1/control",
          cookie,
          origin: originFor(handle),
        });
        await client.opened();
        client.send(
          clientEnvelope({
            sessionId,
            type: "client.hello",
            payload: { protocolVersion: 1, clientType: "test-client", lastAck: "0" },
          }),
        );
        const closeCode = await client.closed();
        expect(closeCode).toBe(1011);
        expect(client.received.length).toBe(0);
      } finally {
        await handle.close();
      }
    },
  );

  it("resume 连接未携带 lastAck：强制快照，绝不静默进入 active", async () => {
    const handle = await startTestRuntime({ dataDirectory: tempDirectory("bellis-p4-rr3-noack-") });
    try {
      const token = handle.issueStartupToken().token;
      const exchange = await fetch(`http://127.0.0.1:${handle.status.port}/api/v1/auth/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: originFor(handle) },
        body: JSON.stringify({ startupToken: token }),
      });
      const { sessionId } = (await exchange.json()) as { sessionId: string };
      const cookie = cookieFrom(exchange);

      const first = await connectedClient(handle, cookie, sessionId);
      await first.waitForType("server.ready");
      first.terminate();
      await new Promise((resolve) => setTimeout(resolve, 100));

      // 不携带 lastAck 重连（同进程导出 resume）：必须先快照再 ready。
      const second = await connectedClient(handle, cookie, sessionId);
      const snapshot = await second.waitForType("session.snapshot");
      const ready = await second.waitForType("server.ready");
      expect(second.received.findIndex((envelope) => envelope === snapshot)).toBeLessThan(
        second.received.findIndex((envelope) => envelope === ready),
      );
      second.close();
    } finally {
      await handle.close();
    }
  });

  it("快照入队失败（发送队列字节上限容不下快照）：1011 失败关闭，不发 ready", async () => {
    const handle = await startTestRuntime({
      dataDirectory: tempDirectory("bellis-p4-rr3-snapcap-"),
      // 队列字节上限压到 server.hello（~300B）可容纳、含 Scene 事实的
      // session.snapshot（>1KB，32 个 Watermark 撑大）容纳不下。
      limits: { sendFlushTimeoutMs: 5_000, sendQueue: { maxMessages: 512, maxBytes: 768 } },
    });
    try {
      const token = handle.issueStartupToken().token;
      const exchange = await fetch(`http://127.0.0.1:${handle.status.port}/api/v1/auth/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: originFor(handle) },
        body: JSON.stringify({ startupToken: token }),
      });
      const { sessionId } = (await exchange.json()) as { sessionId: string };
      const cookie = cookieFrom(exchange);

      const first = await connectedClient(handle, cookie, sessionId);
      await first.waitForType("server.ready");
      first.terminate();
      await new Promise((resolve) => setTimeout(resolve, 100));

      // 无连接提交：Snapshot 事实变"重"（Scene + 32 个 Watermark）。
      await handle.commitFakeScene({
        ...SCENE_INPUT,
        sessionId,
        watermarks: Array.from({ length: 32 }, (_, index) => ({
          source: `wm.source.${index}`,
          watermark: BigInt(index + 1),
        })),
      });

      // 不带 lastAck 重连 → 强制快照 → 入队被字节上限拒绝 → 1011 关闭。
      const second = await connectedClient(handle, cookie, sessionId);
      const closeCode = await second.closed();
      expect(closeCode).toBe(1011);
      expect(second.received.some((envelope) => envelope.type === "server.ready")).toBe(false);
    } finally {
      await handle.close();
    }
  });
});

describe("scene.prepared 写出结果与连接代际（二轮评审修复 4）", () => {
  async function exchangeSession(
    handle: RuntimeHandle,
  ): Promise<{ sessionId: string; cookie: string }> {
    const token = handle.issueStartupToken().token;
    const exchange = await fetch(`http://127.0.0.1:${handle.status.port}/api/v1/auth/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: originFor(handle) },
      body: JSON.stringify({ startupToken: token }),
    });
    const { sessionId } = (await exchange.json()) as { sessionId: string };
    return { sessionId, cookie: cookieFrom(exchange) };
  }

  it("prepared 写出超时：连接降级关闭，内部提交照常，绝不发布 committed", async () => {
    const directory = tempDirectory("bellis-p4-rr4-flushtimeout-");
    const base = await createMigratedBaseClient(directory);
    baseClients.push(base);
    const handle = await startTestRuntime({
      dataDirectory: directory,
      limits: { sendFlushTimeoutMs: 150 },
      persistenceClient: wrapPersistenceClient(base, {
        advanceServerSeq: (input) => {
          if (input.latestServerSeq >= 3n) {
            return new Promise((resolve) => setTimeout(resolve, 600)).then(() =>
              base.advanceServerSeq(input),
            );
          }
          return base.advanceServerSeq(input);
        },
      }),
    });
    try {
      const { sessionId, cookie } = await exchangeSession(handle);
      const client = await connectedClient(handle, cookie, sessionId);
      await client.waitForType("server.ready");

      // prepared(Seq 3) 的落库被延迟 600ms > 写出超时 150ms：
      // 等待器超时 → forceClose + unsent。
      const commitPromise = handle.commitFakeScene({ ...SCENE_INPUT, sessionId });
      const closeCode = await client.closed();
      expect(closeCode).toBe(1006); // forceClose → terminate（异常关闭）
      const result = await commitPromise;
      expect(result.duplicate).toBe(false);

      // 内部提交照常完成（数据库事实存在），committed 未发布。
      const recovery = await handle.readSessionRecovery(sessionId);
      expect(recovery.lastCommittedScene?.sceneId).toBe(SCENE_INPUT.sceneId);

      // 重连后不得单独收到无 prepared 因果的 committed。
      const resumed = await connectedClient(handle, cookie, sessionId, { lastAck: 0n });
      await resumed.waitForType("server.ready");
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(resumed.received.some((envelope) => envelope.type === "scene.committed")).toBe(false);
      resumed.close();
    } finally {
      await handle.close();
    }
  });

  it("无连接时提交：内部提交照常，重连经快照获得事实而非孤立 committed", async () => {
    const handle = await startTestRuntime({
      dataDirectory: tempDirectory("bellis-p4-rr4-noconn-"),
    });
    try {
      const { sessionId, cookie } = await exchangeSession(handle);
      const client = await connectedClient(handle, cookie, sessionId);
      await client.waitForType("server.ready");
      client.terminate();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const result = await handle.commitFakeScene({ ...SCENE_INPUT, sessionId });
      expect(result.duplicate).toBe(false);
      const recovery = await handle.readSessionRecovery(sessionId);
      expect(recovery.lastCommittedScene?.sceneId).toBe(SCENE_INPUT.sceneId);

      const resumed = await connectedClient(handle, cookie, sessionId, { lastAck: 0n });
      await resumed.waitForType("server.ready");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(resumed.received.some((envelope) => envelope.type === "scene.committed")).toBe(false);
      resumed.close();
    } finally {
      await handle.close();
    }
  });
});

describe("Abort 监听器与 WS 载荷边界（二轮评审修复 6/7）", () => {
  it("Fake Commit 完成后合并 Abort 监听器全部移除", async () => {
    const handle = await startTestRuntime({ dataDirectory: tempDirectory("bellis-p4-rr6-abort-") });
    try {
      const token = handle.issueStartupToken().token;
      const exchange = await fetch(`http://127.0.0.1:${handle.status.port}/api/v1/auth/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: originFor(handle) },
        body: JSON.stringify({ startupToken: token }),
      });
      const { sessionId } = (await exchange.json()) as { sessionId: string };

      for (let index = 0; index < 5; index += 1) {
        const caller = new AbortController();
        await handle.commitFakeScene(
          {
            ...SCENE_INPUT,
            sessionId,
            idempotencyKey: `abort-leak-${index}`,
            sceneId: `44444444-4444-4444-8444-4444440000${index + 10}`,
            cycleId: `55555555-5555-4555-8555-5555550000${index + 10}`,
          },
          caller.signal,
        );
        // 调用方信号上的合并监听器必须随 Commit 完成移除。
        expect(getEventListeners(caller.signal, "abort").length).toBe(0);
      }
    } finally {
      await handle.close();
    }
  });

  it("maxControlTextBytes 大于 Media 组合上限时，Control 大帧不被 WS 层 1009 拒绝", async () => {
    const handle = await startTestRuntime({
      dataDirectory: tempDirectory("bellis-p4-rr7-payload-"),
      limits: {
        maxControlTextBytes: 2_621_440,
        maxMediaHeaderBytes: 1_024,
        maxMediaPayloadBytes: 1_024,
      },
    });
    try {
      const token = handle.issueStartupToken().token;
      const exchange = await fetch(`http://127.0.0.1:${handle.status.port}/api/v1/auth/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: originFor(handle) },
        body: JSON.stringify({ startupToken: token }),
      });
      const { sessionId } = (await exchange.json()) as { sessionId: string };
      const cookie = cookieFrom(exchange);

      const client = new ControlWsClient({
        port: handle.status.port,
        path: "/ws/v1/control",
        cookie,
        origin: originFor(handle),
      });
      await client.opened();
      // 1.5MB 文本帧：超过 Media 组合上限（2KB+12）但低于 Control 上限——
      // 必须穿过 WS 层进入协议处理（响应或稳定拒绝），而非 1009 断开。
      const padded = {
        version: 1,
        direction: "client",
        type: "client.hello",
        messageId: "66666666-6666-4666-8666-666666666666",
        sessionId,
        trace: { traceId: "0123456789abcdef0123456789abcdef" },
        sentAtUs: String(BigInt(Date.now()) * 1000n),
        pad: "x".repeat(1_500_000),
        payload: { protocolVersion: 1, clientType: "test-client" },
      };
      client.sendText(JSON.stringify(padded));
      // 收到任意服务端响应（hello/ready/error）即证明未被 WS 层 1009 拒绝。
      await client.waitFor(() => true, 5_000);
      client.close();
    } finally {
      await handle.close();
    }
  });
});
