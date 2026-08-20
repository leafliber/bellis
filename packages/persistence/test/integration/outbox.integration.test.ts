import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VirtualClock } from "@bellis/testkit";
import { createOutboxDispatcher, createPersistenceClient } from "../../src/index.js";
import type { PersistenceClient } from "../../src/index.js";
import type { PersistenceCheckpoint } from "../../src/index.js";
import {
  SESSION_ID,
  TRACE,
  WORKER_FIXTURE,
  cleanupTempDataDirectory,
  createTempDataDirectory,
  cycleId,
  makeOutboxMessage,
  makeScene,
  outboxId,
  sceneId,
} from "../helpers.js";

/**
 * Outbox 状态机集成测试（P2 文档 §12.3-5/6/7/8）：
 * 条件更新、退避重试、Dead Letter、Lease 重启恢复与 Dispatcher 编排。
 */

const OWNER_A = "dispatcher-a";
const OWNER_B = "dispatcher-b";

async function claimUntil(
  ownerInstanceId: string,
  expected: number,
  timeoutMs = 2_000,
): Promise<Awaited<ReturnType<PersistenceClient["claimOutbox"]>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const claimed = await client.claimOutbox({
      limit: 256,
      leaseMs: 600_000,
      ownerInstanceId,
    });
    if (claimed.length >= expected) {
      return claimed;
    }
    if (Date.now() > deadline) {
      return claimed;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** 测试隔离：清空待领取项（全部标 delivered），避免跨用例污染。 */
async function drainOutbox(): Promise<void> {
  for (;;) {
    const claimed = await claimUntil(OWNER_A, 1, 200);
    if (claimed.length === 0) {
      return;
    }
    for (const message of claimed) {
      await client.completeOutbox({ outboxId: message.outboxId, ownerInstanceId: OWNER_A });
    }
  }
}

let dataDirectory: string;
let client: PersistenceClient;

async function commitWithOutbox(n: number, count: number): Promise<void> {
  await client.commitScene({
    sceneId: sceneId(n),
    cycleId: cycleId(n),
    sessionId: SESSION_ID,
    scene: makeScene({ sceneId: sceneId(n), cycleId: cycleId(n) }),
    idempotencyKey: `ob-key-${n}`,
    requestFingerprint: `ob-fp-${n}`,
    watermarks: [{ source: "asr", watermark: BigInt(n) }],
    outbox: Array.from({ length: count }, (_, i) =>
      makeOutboxMessage({ outboxId: outboxId(n * 100 + i) }),
    ),
    trace: TRACE,
  });
}

beforeAll(async () => {
  dataDirectory = createTempDataDirectory("bellis-p2-outbox-");
  client = createPersistenceClient({
    dataDirectory,
    worker: WORKER_FIXTURE,
    retryPolicy: { baseMs: 60, maxMs: 300, maxAttempts: 2, jitterSeed: 7 },
  });
  await client.migrate();
  await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 1, trace: TRACE });
  await commitWithOutbox(1, 2);
});

afterAll(async () => {
  await client.close();
  cleanupTempDataDirectory(dataDirectory);
});

describe("Claim 与条件更新", () => {
  it("Claim 后他人不能领取或完成；delivered 完成幂等", async () => {
    const claimed = await client.claimOutbox({
      limit: 2,
      leaseMs: 600_000,
      ownerInstanceId: OWNER_A,
    });
    expect(claimed.map((m) => m.outboxId)).toEqual([outboxId(100), outboxId(101)]);
    // 已被 A 领取：B 既领不到新项，也不能完成 A 的项。
    expect(
      await client.claimOutbox({ limit: 2, leaseMs: 600_000, ownerInstanceId: OWNER_B }),
    ).toEqual([]);
    await expect(
      client.completeOutbox({ outboxId: outboxId(100), ownerInstanceId: OWNER_B }),
    ).rejects.toMatchObject({ code: "not_claimed" });
    await client.completeOutbox({ outboxId: outboxId(100), ownerInstanceId: OWNER_A });
    // delivered 后重复 complete 幂等成功。
    await client.completeOutbox({ outboxId: outboxId(100), ownerInstanceId: OWNER_A });
    expect((await client.readOutboxStats()).delivered).toBe(1);
  });
});

describe("重试与 Dead Letter", () => {
  it("可重试失败 → 退避后可再领取；超过次数进入 dead", async () => {
    // 项 101 当前 in_flight（Owner A）。
    const first = await client.retryOutbox({
      outboxId: outboxId(101),
      ownerInstanceId: OWNER_A,
      errorCode: "publish_failed",
      retryable: true,
    });
    expect(first.disposition).toBe("retry");
    // 退避窗口内不可立即领取，但退避时长（≤75ms）过后可领取。
    const immediate = await client.claimOutbox({
      limit: 5,
      leaseMs: 600_000,
      ownerInstanceId: OWNER_A,
    });
    if (immediate.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const reclaimed = await claimUntil(OWNER_A, 1);
    expect(reclaimed.map((m) => m.outboxId)).toEqual([outboxId(101)]);
    // 第二次可重试（attempts 1 < maxAttempts 2）。
    const second = await client.retryOutbox({
      outboxId: outboxId(101),
      ownerInstanceId: OWNER_A,
      errorCode: "publish_failed",
      retryable: true,
    });
    expect(second.disposition).toBe("retry");
    const reclaimed2 = await claimUntil(OWNER_A, 1);
    expect(reclaimed2.map((m) => m.outboxId)).toEqual([outboxId(101)]);
    // attempts 已到上限 → dead。
    const third = await client.retryOutbox({
      outboxId: outboxId(101),
      ownerInstanceId: OWNER_A,
      errorCode: "publish_failed",
      retryable: true,
    });
    expect(third.disposition).toBe("dead");
    const stats = await client.readOutboxStats();
    expect(stats.dead).toBe(1);
    // 不可重试错误立即 dead。
    await commitWithOutbox(2, 1);
    const claimed = await claimUntil(OWNER_A, 1);
    const fatal = await client.retryOutbox({
      outboxId: claimed[claimed.length - 1]!.outboxId,
      ownerInstanceId: OWNER_A,
      errorCode: "schema_invalid",
      retryable: false,
    });
    expect(fatal.disposition).toBe("dead");
  });
});

describe("Lease 重启恢复", () => {
  it("旧实例 in_flight 项在新 Worker 启动后立即可领取", async () => {
    await drainOutbox();
    await commitWithOutbox(3, 1);
    // 独立 Client 模拟旧实例：领取后直接销毁（普通 close 模拟进程消失）。
    const holder = createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
    await holder.migrate();
    const claimed = await holder.claimOutbox({
      limit: 5,
      leaseMs: 600_000,
      ownerInstanceId: OWNER_A,
    });
    expect(claimed.map((m) => m.outboxId)).toEqual([outboxId(300)]);
    await holder.close();
    // 旧 Lease 截止在 10 分钟后；重启后不允许等待旧墙钟截止时间。
    const reborn = createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
    try {
      await reborn.migrate();
      const requeued = await reborn.claimOutbox({
        limit: 5,
        leaseMs: 600_000,
        ownerInstanceId: OWNER_B,
      });
      expect(requeued.map((m) => m.outboxId)).toEqual([outboxId(300)]);
      await reborn.completeOutbox({ outboxId: outboxId(300), ownerInstanceId: OWNER_B });
    } finally {
      await reborn.close();
    }
  });
});

describe("Dispatcher 编排", () => {
  it("runOnce：Claim → 发布 → 检查点 3 → Complete；指标计数", async () => {
    await drainOutbox();
    await commitWithOutbox(4, 1);
    const checkpoints: PersistenceCheckpoint[] = [];
    const published: string[] = [];
    const dispatcher = createOutboxDispatcher({
      client,
      ownerInstanceId: "dispatcher-test",
      clock: new VirtualClock(),
      publish: async (message) => {
        published.push(message.outboxId);
        return { ok: true };
      },
      checkpointObserver: {
        reached: async (checkpoint) => {
          checkpoints.push(checkpoint);
        },
      },
    });
    try {
      const summary = await dispatcher.runOnce();
      expect(summary).toEqual({ claimed: 1, delivered: 1, retried: 0, dead: 0 });
      expect(published).toEqual([outboxId(400)]);
      expect(checkpoints).toEqual([
        "after_scene_transaction_commit_before_outbox_dispatch",
        "after_outbox_publish_before_mark_delivered",
      ]);
      expect((await client.readOutboxStats()).delivered).toBeGreaterThanOrEqual(2);
      // 再跑一次：无待领取项。
      const idle = await dispatcher.runOnce();
      expect(idle.claimed).toBe(0);
    } finally {
      await dispatcher.stop();
    }
  });

  it("发布失败：可重试走 retryOutbox，不可重试直接 dead", async () => {
    await drainOutbox();
    await commitWithOutbox(5, 2);
    const dispatcher = createOutboxDispatcher({
      client,
      ownerInstanceId: "dispatcher-mixed",
      clock: new VirtualClock(),
      publish: async (message) =>
        message.outboxId === outboxId(500)
          ? { ok: false, errorCode: "transient", retryable: true }
          : { ok: false, errorCode: "fatal", retryable: false },
    });
    try {
      const summary = await dispatcher.runOnce();
      expect(summary).toEqual({ claimed: 2, delivered: 0, retried: 1, dead: 1 });
      const stats = await client.readOutboxStats();
      expect(stats.pending).toBe(1);
      expect(stats.dead).toBeGreaterThanOrEqual(1);
    } finally {
      await dispatcher.stop();
    }
  });

  it("start/stop：循环推进并在 stop 后停止领取（Grace 语义）", async () => {
    await commitWithOutbox(6, 1);
    const clock = new VirtualClock();
    const published: string[] = [];
    const dispatcher = createOutboxDispatcher({
      client,
      ownerInstanceId: "dispatcher-loop",
      clock,
      pollIntervalMs: 10,
      publish: async (message) => {
        published.push(message.outboxId);
        return { ok: true };
      },
    });
    dispatcher.start();
    // 推进虚拟时钟驱动轮询循环（不使用真实业务时长等待）。
    for (let i = 0; i < 20 && published.length === 0; i += 1) {
      clock.advance(BigInt(10_000));
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await dispatcher.stop();
    expect(published).toEqual([outboxId(600)]);
    expect(dispatcher.running).toBe(false);
  });
});

describe("并发幂等（双客户端同请求）", () => {
  it("两个 Client 并发提交相同幂等键 → 只有一个逻辑 Commit", async () => {
    await drainOutbox();
    const other = createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
    try {
      await other.migrate();
      const input = {
        sceneId: sceneId(7),
        cycleId: cycleId(7),
        sessionId: SESSION_ID,
        scene: makeScene({ sceneId: sceneId(7), cycleId: cycleId(7) }),
        idempotencyKey: "ob-key-7",
        requestFingerprint: "ob-fp-7",
        watermarks: [{ source: "asr", watermark: 7n }],
        outbox: [makeOutboxMessage({ outboxId: outboxId(700) })],
        trace: TRACE,
      } as const;
      const [r1, r2] = await Promise.all([
        client.commitScene({ ...input }),
        other.commitScene({ ...input }),
      ]);
      const originals = [r1, r2].filter((r) => !r.duplicate);
      expect(originals).toHaveLength(1);
      expect(originals[0]?.committedAtMs).toBe([r1, r2].find((r) => r.duplicate)?.committedAtMs);
      // 只有一份 Outbox 事实。
      const stats = await client.readOutboxStats();
      const records = await client.listRecords({ aggregateId: `scene-commit:${SESSION_ID}` });
      const scene7Records = records.filter(
        (record) => (record.payload as { sceneId?: string }).sceneId === sceneId(7),
      );
      expect(scene7Records).toHaveLength(1);
      void stats;
    } finally {
      await other.close();
    }
  });
});
