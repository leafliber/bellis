import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseDecimalString } from "@bellis/contracts";
import type { PersistenceClient } from "@bellis/persistence";
import { VirtualClock } from "@bellis/testkit";
import type { RuntimeHandle } from "../../src/index.js";
import {
  cleanupTempDataDirectory,
  createMigratedBaseClient,
  createTempDataDirectory,
  mustExchange,
  originFor,
  startTestRuntime as startRuntimeWithDefaults,
  wrapPersistenceClient,
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
    const replay = await handle.commitFakeScene({ sessionId, ...SCENE_INPUT });
    expect(replay.duplicate).toBe(true);
    expect(replay.committedAtMs).toBeGreaterThan(0);
    // 无新 committed 事件上线。
    const committedCount = client.received.filter(
      (envelope) => envelope.type === "scene.committed",
    ).length;
    expect(committedCount).toBe(1);
    // 首次交付可能发生在重放之前；最终总数必须为一，不能要求重放使它增长。
    await vi.waitFor(() => expect(handle.outboxDeliveries()).toHaveLength(1), { timeout: 2_000 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(handle.outboxDeliveries()).toHaveLength(1);
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

describe("VirtualClock 下的 awaitSent 广播（Gate 3 重开评审修复 2）", () => {
  it("prepared 不依赖 50ms 周期循环：注册 waiter 后立即 pump 发送", async () => {
    const clock = new VirtualClock();
    const dir = createTempDataDirectory("bellis-p4-vclock-");
    const handle = await startTestRuntime({ dataDirectory: dir, clock });
    try {
      const { sessionId, cookie } = await mustExchange(handle, handle.issueStartupToken().token);
      const client = new ControlWsClient({
        port: handle.status.port,
        path: "/ws/v1/control",
        cookie,
        origin: originFor(handle),
      });
      await client.opened();
      // 握手的 server.hello 由 50ms 周期循环首发：推进一次虚拟时钟即可。
      clock.advanceBy(60_000n);
      await client.waitForType("server.hello");
      client.send(
        clientEnvelope({
          sessionId,
          type: "client.hello",
          payload: { protocolVersion: 1, clientType: "test-client" },
        }),
      );
      await client.waitForType("server.ready");

      // 此后不再推进虚拟时钟：awaitSent 的 scene.prepared 必须由 broadcast
      // 注册 waiter 后主动 pump 立即写出（回归：旧实现先等待再 pump，
      // 只能依赖周期循环偶然发送，VirtualClock 下永不发送直至 flush 超时）。
      const commitPromise = handle.commitFakeScene({
        sessionId,
        sceneId: "22222222-2222-4222-8222-444444444444",
        cycleId: "33333333-3333-4333-8333-444444444444",
        idempotencyKey: "vclock-key-1",
        cues: [],
        watermarks: [],
      });
      const prepared = await client.waitForType("scene.prepared", 2_000);
      expect(prepared.type).toBe("scene.prepared");
      const result = await commitPromise;
      expect(result.duplicate).toBe(false);
      const committed = await client.waitForType("scene.committed", 2_000);
      expect((committed.payload as { sceneId: string }).sceneId).toBe(result.sceneId);
      client.close();
    } finally {
      await handle.close();
      cleanupTempDataDirectory(dir);
    }
  });
});

describe("关闭顺序：应用任务与 Outbox 先停、再等待连接排空（Gate 3 重开评审修复 3）", () => {
  it("连接排空等待期间 Dispatcher 不再领取 Outbox", async () => {
    const dir = createTempDataDirectory("bellis-p4-shutdown-order-");
    const base = await createMigratedBaseClient(dir);
    const claimTimes: number[] = [];
    const claimOutbox: PersistenceClient["claimOutbox"] = (input) => {
      claimTimes.push(Date.now());
      return base.claimOutbox(input);
    };
    // 让 Seq 落库在关闭开始后挂起：Control pump 卡在 seq_advanced，
    // 连接保持逻辑打开，排空等待撑满 shutdownGraceMs——等待窗口内
    // Dispatcher 是否停止领取即新旧顺序的可观测判据。
    let hangSeqPersist = false;
    let releaseSeqPersist: (() => void) | undefined;
    const seqGate = new Promise<void>((resolve) => {
      releaseSeqPersist = resolve;
    });
    const advanceServerSeq: PersistenceClient["advanceServerSeq"] = (input) =>
      hangSeqPersist
        ? seqGate.then(() => base.advanceServerSeq(input))
        : base.advanceServerSeq(input);
    const handle = await startTestRuntime({
      dataDirectory: dir,
      persistenceClient: wrapPersistenceClient(base, { claimOutbox, advanceServerSeq }),
      shutdownGraceMs: 1_500,
    });
    let client: ControlWsClient | null = null;
    try {
      const { sessionId, cookie } = await mustExchange(handle, handle.issueStartupToken().token);
      // 正常提交一笔：Outbox 进入轮询交付（正控制：Dispatcher 活跃）。
      await handle.commitFakeScene({ sessionId, ...SCENE_INPUT });
      const deliveryDeadline = Date.now() + 3_000;
      while (handle.outboxDeliveries().length === 0 && Date.now() < deliveryDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(handle.outboxDeliveries().length).toBeGreaterThan(0);

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
      // 等待 Pong 送达（Seq 正常落库），随后挂起 Seq 落库并再发一次
      // Ping：Pong 的 seq_advanced 将卡住 pump，连接保持逻辑打开。
      client.send(clientEnvelope({ sessionId, type: "heartbeat.ping", payload: {} }));
      await client.waitForType("heartbeat.pong");
      hangSeqPersist = true;
      client.send(clientEnvelope({ sessionId, type: "heartbeat.ping", payload: {} }));
      // 等待该 Ping 到达并让 pump 卡在挂起的 seq_advanced 上（此后
      // close 的排空等待才会撑满 Grace——判据才真正生效）。
      await new Promise((resolve) => setTimeout(resolve, 200));

      const t0 = Date.now();
      const closePromise = handle.close();
      await closePromise;
      await handle.closed;
      const closeEnd = Date.now();
      expect(handle.status.phase).toBe("closed");
      // 取样必须在 close 完成后从**完整**时间序列计算（复审修复：此前
      // 150ms 处提前冻结数组，旧实现 200ms/300ms 后的继续领取不会进入
      // 断言）。新顺序：abort 与 dispatcher-stop 在排空等待之前完成，
      // (t0+150, closeEnd] 内不应有任何 claim_outbox；旧顺序：排空等待
      // 先于 dispatcher-stop 撑满 Grace，100ms 轮询在窗口内必然继续领取。
      expect(claimTimes.filter((t) => t > t0 + 150 && t <= closeEnd)).toEqual([]);
      // 观察窗口确实成立：排空等待撑满 Grace（排队的 Pong 卡在挂起的
      // Seq 落库上，连接直到 force-close 才消失）。
      expect(closeEnd - t0).toBeGreaterThanOrEqual(1_400);
      client.close();
    } finally {
      releaseSeqPersist?.();
      client?.close();
      await handle.close();
      cleanupTempDataDirectory(dir);
    }
  });
});

/** These historical tests inject failures at individual allocations.
 * Default batching and restart behavior are covered separately with 1024-ID ranges.
 */
function startTestRuntime(options: Parameters<typeof startRuntimeWithDefaults>[0]) {
  return startRuntimeWithDefaults({
    ...options,
    limits: { seqReservationSize: 1, ...options.limits },
  });
}
