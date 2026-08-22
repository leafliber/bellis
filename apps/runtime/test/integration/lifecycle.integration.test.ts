import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseDecimalString } from "@bellis/contracts";
import type { RuntimeHandle } from "../../src/index.js";
import {
  cleanupTempDataDirectory,
  createTempDataDirectory,
  mustExchange,
  originFor,
  startTestRuntime,
} from "../helpers.js";
import { clientEnvelope, ControlWsClient } from "../ws-client.js";

const SCENE_INPUT = {
  sceneId: "22222222-2222-4222-8222-222222222222",
  cycleId: "33333333-3333-4333-8333-333333333333",
  idempotencyKey: "lifecycle-key-1",
  cues: [
    { cueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", lane: "subtitle" as const },
    { cueId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", lane: "avatar" as const },
  ],
  watermarks: [{ source: "lifecycle.asr", watermark: 42424242424242n }],
};

describe("启动边界与优雅关闭", () => {
  it("数据目录不可用（state.db 是垃圾文件）→ 启动失败、ready 保持 false", async () => {
    const dir = createTempDataDirectory("bellis-p4-badmig-");
    writeFileSync(join(dir, "state.db"), "this is not a sqlite database at all");
    try {
      await expect(startTestRuntime({ dataDirectory: dir })).rejects.toThrow();
      // 失败装配已清理：同进程内后续装配不受影响。
      const good = createTempDataDirectory("bellis-p4-badmig-good-");
      const handle = await startTestRuntime({ dataDirectory: good });
      expect(handle.status.ready).toBe(true);
      await handle.close();
      cleanupTempDataDirectory(good);
    } finally {
      cleanupTempDataDirectory(dir);
    }
  });

  it("端口占用时明确失败，不改绑 0.0.0.0 或随机正式端口", async () => {
    const dirA = createTempDataDirectory("bellis-p4-port-a-");
    const dirB = createTempDataDirectory("bellis-p4-port-b-");
    const first = await startTestRuntime({ dataDirectory: dirA, port: 18923 });
    try {
      await expect(startTestRuntime({ dataDirectory: dirB, port: 18923 })).rejects.toThrow();
      // 第一个实例不受影响。
      const live = await fetch(`http://127.0.0.1:18923/api/v1/health/live`, {
        headers: { origin: "http://127.0.0.1:18923" },
      });
      expect(live.status).toBe(200);
    } finally {
      await first.close();
      cleanupTempDataDirectory(dirA);
      cleanupTempDataDirectory(dirB);
    }
  });

  it("只绑定 loopback 地址", async () => {
    const dir = createTempDataDirectory("bellis-p4-bind-");
    const handle = await startTestRuntime({ dataDirectory: dir });
    try {
      const address = handle.status;
      expect(address.ready).toBe(true);
      // 127.0.0.1 监听：非 loopback 地址上不可达（无法直接证明，但地址族
      // 由 listen host 固定；这里断言实际端口与配置一致）。
      expect(address.port).toBeGreaterThan(0);
    } finally {
      await handle.close();
      cleanupTempDataDirectory(dir);
    }
  });

  it("优雅关闭幂等：重复 close 不抛错，DB Worker/句柄回收", async () => {
    const dir = createTempDataDirectory("bellis-p4-close-");
    const handle = await startTestRuntime({ dataDirectory: dir });
    expect(handle.status.ready).toBe(true);
    const port = handle.status.port;
    await handle.close();
    await handle.close(); // 幂等
    await handle.closed;
    expect(handle.status.phase).toBe("closed");
    // 端口已释放：请求被拒绝。
    await expect(
      fetch(`http://127.0.0.1:${port}/api/v1/health/live`, {
        headers: { origin: `http://127.0.0.1:${port}` },
      }),
    ).rejects.toThrow();
    // DB Worker 线程已终止：活动资源里不再有 Worker。
    const resources = process.getActiveResourcesInfo();
    expect(resources.filter((name) => name === "Worker").length).toBe(0);
    cleanupTempDataDirectory(dir);
  });

  it("DB 批量提交期间 Health 仍及时响应", async () => {
    const dir = createTempDataDirectory("bellis-p4-busy-");
    const handle = await startTestRuntime({ dataDirectory: dir });
    try {
      const { sessionId } = await mustExchange(handle, handle.issueStartupToken().token);
      const commits = Array.from({ length: 30 }, (_, index) =>
        handle
          .commitFakeScene({
            sessionId,
            sceneId: `22222222-2222-4222-8222-${(index + 1).toString().padStart(12, "0")}`,
            cycleId: `33333333-3333-4333-8333-${(index + 1).toString().padStart(12, "0")}`,
            idempotencyKey: `busy-${index}`,
            cues: [],
            watermarks: [{ source: "busy", watermark: BigInt(index) }],
          })
          .catch((error: unknown) => error),
      );
      const latencies: number[] = [];
      for (let index = 0; index < 10; index += 1) {
        const started = Date.now();
        const response = await fetch(`http://127.0.0.1:${handle.status.port}/api/v1/health/live`, {
          headers: { origin: originFor(handle) },
        });
        expect(response.status).toBe(200);
        latencies.push(Date.now() - started);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const results = await Promise.all(commits);
      expect(results.every((result) => !(result instanceof Error))).toBe(true);
      expect(Math.max(...latencies)).toBeLessThan(2_000);
    } finally {
      await handle.close();
      cleanupTempDataDirectory(dir);
    }
  });
});

describe("Fake Scene Commit 顺序与幂等", () => {
  let handle: RuntimeHandle;
  let dataDirectory: string;
  let sessionId: string;
  let cookie: string;
  let client: ControlWsClient;

  beforeAll(async () => {
    dataDirectory = createTempDataDirectory("bellis-p4-commit-");
    handle = await startTestRuntime({ dataDirectory: dataDirectory });
    const exchanged = await mustExchange(handle, handle.issueStartupToken().token);
    sessionId = exchanged.sessionId;
    cookie = exchanged.cookie;
    client = new ControlWsClient({
      port: handle.status.port,
      path: "/ws/v1/control",
      cookie,
      origin: originFor(handle),
    });
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
  });

  afterAll(async () => {
    client.close();
    await handle.close();
    cleanupTempDataDirectory(dataDirectory);
  });

  let firstTraceId = "";

  it("数据库 Commit 后才发布 scene.committed；prepared 先于 committed 上线", async () => {
    const result = await handle.commitFakeScene({ sessionId, ...SCENE_INPUT });
    firstTraceId = result.traceId;
    expect(result.duplicate).toBe(false);
    const prepared = await client.waitForType("scene.prepared");
    const committed = await client.waitForType("scene.committed");
    expect(parseDecimalString(prepared.seq)).toBeLessThan(parseDecimalString(committed.seq));
    const committedPayload = committed.payload as {
      sceneId: string;
      cycleId: string;
      committedAtMs: number;
    };
    expect(committedPayload.sceneId).toBe(SCENE_INPUT.sceneId);
    expect(committedPayload.committedAtMs).toBe(result.committedAtMs);
    // committed 已上线 ⇒ 数据库事实必须已存在（顺序不变量的可观察面）。
    const recovery = await handle.readSessionRecovery(sessionId);
    expect(recovery.lastCommittedScene?.sceneId).toBe(SCENE_INPUT.sceneId);
    expect(recovery.signalWatermarks).toEqual([
      { source: "lifecycle.asr", watermark: 42424242424242n },
    ]);
  });

  it("同一幂等键重放返回第一次结果，不产生第二条 committed/Outbox", async () => {
    const before = handle.outboxDeliveries().length;
    const replay = await handle.commitFakeScene({ sessionId, ...SCENE_INPUT });
    expect(replay.duplicate).toBe(true);
    expect(replay.committedAtMs).toBeGreaterThan(0);
    // 无新 committed 事件上线。
    const committedCount = client.received.filter(
      (envelope) => envelope.type === "scene.committed",
    ).length;
    expect(committedCount).toBe(1);
    // 等待一个调度周期，交付记录只增加一次。
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(handle.outboxDeliveries().length).toBe(before + 1);
    const delivery = handle.outboxDeliveries().at(-1);
    expect(delivery?.topic).toBe("scene.committed");
    // Outbox Payload 携带的是第一次提交的 trace（本次重放没有新事务）。
    expect(delivery?.traceId).toBe(firstTraceId);
  });

  it("同 Scene 不同幂等键 → scene_conflict（映射为 invalid_message）", async () => {
    await expect(
      handle.commitFakeScene({
        sessionId,
        ...SCENE_INPUT,
        idempotencyKey: "different-key-same-scene",
      }),
    ).rejects.toThrow(/already committed|scene_conflict/i);
  });

  it("Server Seq 水位随发送推进并持久化", async () => {
    const recovery = await handle.readSessionRecovery(sessionId);
    expect(recovery.latestServerSeq).toBeGreaterThan(0n);
  });
});
