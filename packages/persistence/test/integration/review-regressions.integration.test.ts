import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { getEventListeners } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VirtualClock } from "@bellis/testkit";
import { createOutboxDispatcher, createPersistenceClient } from "../../src/index.js";
import type { PersistenceClient } from "../../src/index.js";
import {
  SESSION_ID,
  TRACE,
  WORKER_FIXTURE,
  cleanupTempDataDirectory,
  createTempDataDirectory,
  cycleId,
  makeOutboxMessage,
  makeScene,
  makeSessionRecord,
  outboxId,
  sceneId,
} from "../helpers.js";

/**
 * 评审回归测试（8 项评审意见的定向覆盖）：
 * 1. aggregate_seq 长度+字典序排序：跨位数十进制序号（9→10→11）不塌陷。
 * 2. 同 Worker 生命周期内 Lease 到期重领（不依赖 Worker 重启）。
 * 3. 审计墙钟与 Lease 单调时钟分离：未来审计时钟不影响调度可领取性。
 * 4. worker-lock 单 Worker 独占：第二个存活 Worker 无法启动，不会抢走活跃 Lease。
 * 5. 挂起 Publisher 的有界 stop（Grace 超时返回 + AbortSignal 传播 + Lease 兜底）。
 * 8. Abort 监听器不残留。
 */

let dataDirectory: string;
let client: PersistenceClient;

/** 测试隔离：清空全部可领取项（避免跨用例 claim 到遗留消息）。 */
async function drainOutbox(): Promise<void> {
  for (;;) {
    const claimed = await client.claimOutbox({
      limit: 256,
      leaseMs: 600_000,
      ownerInstanceId: "drain",
    });
    if (claimed.length === 0) {
      return;
    }
    for (const message of claimed) {
      await client.completeOutbox({ outboxId: message.outboxId, ownerInstanceId: "drain" });
    }
  }
}

async function commitWithOutbox(n: number, watermark?: bigint): Promise<void> {
  await client.commitScene({
    sceneId: sceneId(n),
    cycleId: cycleId(n),
    sessionId: SESSION_ID,
    scene: makeScene({ sceneId: sceneId(n), cycleId: cycleId(n) }),
    idempotencyKey: `reg-${n}`,
    requestFingerprint: `reg-fp-${n}`,
    watermarks: [{ source: "asr", watermark: watermark ?? BigInt(1000 + n) }],
    outbox: [makeOutboxMessage({ outboxId: outboxId(n) })],
    trace: TRACE,
  });
}

beforeAll(async () => {
  dataDirectory = createTempDataDirectory("bellis-p2-regress-");
  client = createPersistenceClient({
    dataDirectory,
    worker: WORKER_FIXTURE,
    retryPolicy: { baseMs: 40, maxMs: 200, maxAttempts: 8, jitterSeed: 3 },
  });
  await client.migrate();
  await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 1, trace: TRACE });
});

afterAll(async () => {
  await client.close();
  cleanupTempDataDirectory(dataDirectory);
});

function crossDigitRecord(seq: number) {
  return {
    schemaVersion: 1 as const,
    recordId: `99999999-9999-4999-8999-${(seq + 100).toString().padStart(12, "0")}`,
    sessionId: SESSION_ID,
    recordType: "cross-digit.record",
    aggregateId: "cross-digit",
    aggregateSeq: seq.toString(10),
    traceId: TRACE.traceId,
    occurredAtMs: 1,
    payload: {},
  };
}

describe("评审回归 1：aggregate_seq 数值序（长度+字典序）", () => {
  it("15 次连续 Scene Commit 全部成功，聚合序号跨越 9→10→11", async () => {
    for (let n = 1; n <= 15; n += 1) {
      await commitWithOutbox(n);
    }
    const records = await client.listRecords({
      aggregateId: `scene-commit:${SESSION_ID}`,
      limit: 1000,
    });
    const seqs = records
      .map((record) => BigInt(record.aggregateSeq ?? "0"))
      .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(seqs).toHaveLength(15);
    expect(seqs[0]).toBe(1n);
    expect(seqs[14]).toBe(15n);
    // 9、10、11 三个位数十进制序号严格递增存在。
    expect(seqs.slice(8, 11)).toEqual([9n, 10n, 11n]);
    // 第 16 次继续成功（NextAggregateSeq 正确越过两位数）。
    await commitWithOutbox(16);
    expect(
      (await client.listRecords({ aggregateId: `scene-commit:${SESSION_ID}`, limit: 1000 })).length,
    ).toBe(16);
  });

  it("appendRecord 跨位数聚合序号不误判冲突", async () => {
    for (const seq of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      await client.appendRecord({ record: crossDigitRecord(seq), trace: TRACE });
    }
    // "12" > "9"（数值）：不误判冲突。
    await expect(
      client.appendRecord({ record: crossDigitRecord(9), trace: TRACE }),
    ).rejects.toMatchObject({
      code: "record_conflict",
    });
  });
});

describe("评审回归 2：同 Worker Lease 到期重领", () => {
  it("Lease 过期后同一 Worker 立即重新领取（无需重启）", async () => {
    await drainOutbox();
    await commitWithOutbox(20);
    const claimed = await client.claimOutbox({
      limit: 5,
      leaseMs: 10,
      ownerInstanceId: "stuck-dispatcher",
    });
    expect(claimed.map((m) => m.outboxId)).toEqual([outboxId(20)]);
    // 10ms Lease；立即再领：仍在租期内，领不到。
    const immediate = await client.claimOutbox({
      limit: 5,
      leaseMs: 10,
      ownerInstanceId: "other",
    });
    expect(immediate).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 40));
    // 到期后同 Worker 内即可重领（评审实测：修复前永久停留 in_flight）。
    const reclaimed = await client.claimOutbox({
      limit: 5,
      leaseMs: 60_000,
      ownerInstanceId: "healthy-dispatcher",
    });
    expect(reclaimed.map((m) => m.outboxId)).toEqual([outboxId(20)]);
    await client.completeOutbox({
      outboxId: outboxId(20),
      ownerInstanceId: "healthy-dispatcher",
    });
  });
});

describe("评审回归 3：审计墙钟与 Lease 时钟分离", () => {
  it("未来审计时钟下新 Outbox 立即可领取、退避可用 lease 域", async () => {
    const futureDir = createTempDataDirectory("bellis-p2-clocks-");
    // 审计墙钟固定在未来 10 分钟：调度必须不受影响。
    const futureClient = createPersistenceClient({
      dataDirectory: futureDir,
      worker: WORKER_FIXTURE,
      wallClockMs: Date.now() + 600_000,
      retryPolicy: { baseMs: 40, maxMs: 200, maxAttempts: 8, jitterSeed: 5 },
    });
    try {
      await futureClient.migrate();
      await futureClient.ensureSession({ sessionId: SESSION_ID, createdAtMs: 1, trace: TRACE });
      await futureClient.commitScene({
        sceneId: sceneId(1),
        cycleId: cycleId(1),
        sessionId: SESSION_ID,
        scene: makeScene({ sceneId: sceneId(1), cycleId: cycleId(1) }),
        idempotencyKey: "clock-1",
        requestFingerprint: "clock-fp-1",
        watermarks: [],
        outbox: [makeOutboxMessage({ outboxId: outboxId(1) })],
        trace: TRACE,
      });
      const claimed = await futureClient.claimOutbox({
        limit: 5,
        leaseMs: 60_000,
        ownerInstanceId: "clock-owner",
      });
      // 评审实测：修复前 available_at = 未来审计时钟 → 永远领不到。
      expect(claimed.map((m) => m.outboxId)).toEqual([outboxId(1)]);
      // 退避也走 lease 域：短暂等待后可再领取。
      const retried = await futureClient.retryOutbox({
        outboxId: outboxId(1),
        ownerInstanceId: "clock-owner",
        errorCode: "test",
        retryable: true,
      });
      expect(retried.disposition).toBe("retry");
      const deadline = Date.now() + 2_000;
      let reclaimed: Awaited<ReturnType<PersistenceClient["claimOutbox"]>> = [];
      while (Date.now() < deadline) {
        reclaimed = await futureClient.claimOutbox({
          limit: 5,
          leaseMs: 60_000,
          ownerInstanceId: "clock-owner-2",
        });
        if (reclaimed.length > 0) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(reclaimed.map((m) => m.outboxId)).toEqual([outboxId(1)]);
    } finally {
      await futureClient.close();
      cleanupTempDataDirectory(futureDir);
    }
  });
});

describe("评审回归 4：worker-lock 单 Worker 独占", () => {
  it("存活 Worker 持锁期间，第二个 Worker 无法启动且不触碰其 Lease", async () => {
    await drainOutbox();
    await commitWithOutbox(30);
    const claimed = await client.claimOutbox({
      limit: 5,
      leaseMs: 600_000,
      ownerInstanceId: "live-owner",
    });
    expect(claimed.map((m) => m.outboxId)).toEqual([outboxId(30)]);

    // 同目录第二个 Client：Worker 启动即被守卫拒绝。
    const intruder = createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
    try {
      await expect(intruder.migrate()).rejects.toMatchObject({
        code: "unavailable",
        retryable: true,
      });
    } finally {
      await intruder.close();
    }

    // 原 Worker 的活跃 Lease 未被清空：项仍 in_flight 且归 live-owner。
    const stats = await client.readOutboxStats();
    expect(stats.inFlight).toBe(1);
    // 原连接仍可正常完成该 Lease。
    await client.completeOutbox({ outboxId: outboxId(30), ownerInstanceId: "live-owner" });
    expect((await client.readOutboxStats()).delivered).toBeGreaterThanOrEqual(1);
  });

  it("Worker 退出（进程消失）后，新 Worker 可立即接管", async () => {
    const handoffDir = createTempDataDirectory("bellis-p2-handoff-");
    const first = createPersistenceClient({ dataDirectory: handoffDir, worker: WORKER_FIXTURE });
    await first.migrate();
    await first.close();
    // close 释放守卫后同目录可再启动。
    const second = createPersistenceClient({ dataDirectory: handoffDir, worker: WORKER_FIXTURE });
    try {
      await second.migrate();
    } finally {
      await second.close();
    }
    cleanupTempDataDirectory(handoffDir);
  });
});

describe("评审回归 5：挂起 Publisher 的有界 stop", () => {
  it("stop() 在 Grace 超时后返回，中止信号传播，Lease 到期兜底回收", async () => {
    await drainOutbox();
    await commitWithOutbox(40);
    const state: { signal: AbortSignal | null } = { signal: null };
    const dispatcher = createOutboxDispatcher({
      client,
      ownerInstanceId: "hanging-publisher",
      clock: new VirtualClock(),
      leaseMs: 80,
      stopGraceMs: 150,
      publish: (message, signal) =>
        new Promise((_resolve, reject) => {
          state.signal = signal;
          void message;
          // 监听中止的发布器：Grace 超时后随信号退出。
          signal.addEventListener("abort", () => {
            reject(new Error("publisher aborted"));
          });
          // 故意不 resolve：模拟卡死的下游。
        }),
    });
    const started = Date.now();
    const loop = dispatcher.runOnce();
    void loop.catch(() => {});
    // runOnce 挂起在 publish 上；stop 必须有界返回。
    await dispatcher.stop();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2_000);
    expect(state.signal?.aborted).toBe(true);
    // 项保持 in_flight（未完成）；等待 Lease 到期后可被重领。
    const deadline = Date.now() + 3_000;
    let reclaimed: Awaited<ReturnType<PersistenceClient["claimOutbox"]>> = [];
    while (Date.now() < deadline) {
      reclaimed = await client.claimOutbox({
        limit: 5,
        leaseMs: 60_000,
        ownerInstanceId: "recovery-publisher",
      });
      if (reclaimed.length > 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(reclaimed.map((m) => m.outboxId)).toEqual([outboxId(40)]);
    await client.completeOutbox({
      outboxId: outboxId(40),
      ownerInstanceId: "recovery-publisher",
    });
  });
});

describe("评审回归 8：Abort 监听器不残留", () => {
  it("同一 Signal 连续调用 15 次 migrate() 后监听器数量归零", async () => {
    const controller = new AbortController();
    for (let i = 0; i < 15; i += 1) {
      await client.migrate(controller.signal);
    }
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});

describe("评审回归 9：公开入口无 SQL 通道（运行时）", () => {
  it("向公开工厂附加 migrations 属性（JS 绕过类型）不生效", async () => {
    const dir = createTempDataDirectory("bellis-p2-nosql-");
    try {
      const malicious = {
        dataDirectory: dir,
        worker: WORKER_FIXTURE,
        // 故意附加未知属性（JS 运行时绕过类型）：实现只从内部第二参数
        // 读取 migrations，options 上的注入必须被忽略。
        migrations: {
          state: [{ version: 1, name: "evil", sql: "CREATE TABLE evil (id INTEGER) STRICT" }],
        },
      };
      const intruder = createPersistenceClient(malicious as never);
      try {
        await intruder.migrate();
        // 内建注册表生效：evil 表不存在，sessions 等内建表存在。
        const db = new DatabaseSync(join(dir, "state.db"));
        try {
          expect(
            db.prepare("SELECT name FROM sqlite_master WHERE name = 'evil'").get(),
          ).toBeUndefined();
          expect(
            db.prepare("SELECT name FROM sqlite_master WHERE name = 'sessions'").get(),
          ).toBeDefined();
        } finally {
          db.close();
        }
      } finally {
        await intruder.close();
      }
    } finally {
      cleanupTempDataDirectory(dir);
    }
  });
});

describe("评审回归 10：重启恢复不受旧时钟域影响", () => {
  it("旧时钟域超前的 available_at 在重排队后立即可领取", async () => {
    const dir = createTempDataDirectory("bellis-p2-rewind-");
    const T = TRACE;
    try {
      const first = createPersistenceClient({ dataDirectory: dir, worker: WORKER_FIXTURE });
      await first.migrate();
      await first.ensureSession({ sessionId: SESSION_ID, createdAtMs: 1, trace: T });
      await first.commitScene({
        sceneId: sceneId(1),
        cycleId: cycleId(1),
        sessionId: SESSION_ID,
        scene: makeScene({ sceneId: sceneId(1), cycleId: cycleId(1) }),
        idempotencyKey: "rewind-1",
        requestFingerprint: "rewind-fp-1",
        watermarks: [],
        outbox: [makeOutboxMessage({ outboxId: outboxId(1) })],
        trace: T,
      });
      const claimed = await first.claimOutbox({
        limit: 5,
        leaseMs: 600_000,
        ownerInstanceId: "old-owner",
      });
      expect(claimed).toHaveLength(1);
      await first.close();
      // 模拟旧 Worker 时钟域领先：available_at 被推到 1 小时后。
      const db = new DatabaseSync(join(dir, "state.db"));
      try {
        db.prepare("UPDATE outbox SET available_at_ms = ? WHERE status = 'in_flight'").run(
          Date.now() + 3_600_000,
        );
      } finally {
        db.close();
      }
      // 重启：重排队必须把 available_at 重置到新 Worker 的 leaseNowMs。
      const reborn = createPersistenceClient({ dataDirectory: dir, worker: WORKER_FIXTURE });
      try {
        await reborn.migrate();
        const reclaimed = await reborn.claimOutbox({
          limit: 5,
          leaseMs: 60_000,
          ownerInstanceId: "new-owner",
        });
        expect(reclaimed.map((m) => m.outboxId)).toEqual([outboxId(1)]);
      } finally {
        await reborn.close();
      }
    } finally {
      cleanupTempDataDirectory(dir);
    }
  });
});

describe("评审回归 11：干净 stop 不残留定时器、不中止信号", () => {
  it("批次正常完成后 stop() 返回：无活动 Timeout、发布信号未中止", async () => {
    await drainOutbox();
    await commitWithOutbox(50);
    const signals: AbortSignal[] = [];
    const dispatcher = createOutboxDispatcher({
      client,
      ownerInstanceId: "clean-stop",
      clock: new VirtualClock(),
      stopGraceMs: 5_000,
      publish: async (message, signal) => {
        signals.push(signal);
        void message;
        return { ok: true };
      },
    });
    const summary = await dispatcher.runOnce();
    expect(summary.delivered).toBe(1);
    const timersBefore = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    await dispatcher.stop();
    // 批次已结束：stop 不应留下 5s Grace 定时器。
    expect(process.getActiveResourcesInfo().filter((r) => r === "Timeout").length).toBe(
      timersBefore,
    );
    // 干净停止不中止发布信号（挂起场景才中止，见回归 5）。
    expect(signals[0]?.aborted).toBe(false);
  });
});

describe("评审回归 12：危险键 payload 跨 Worker/SQLite 无损往返", () => {
  it('记录 payload 含 "__proto__" 键时读取逐字节等价', async () => {
    // JSON 允许 "__proto__" 作为普通键；曾因 Zod record 重建静默丢键，
    // payload 在 Worker 侧校验后变成 {}（contracts 修复 + 端到端回归）。
    const payloadText = '{"__proto__":null,"nested":{"__proto__":{"k":[1]}},"plain":2}';
    const record = makeSessionRecord({
      recordId: "99999999-9999-4999-8999-000000000012",
      recordType: "dangerous.payload",
      payload: JSON.parse(payloadText),
    });
    await client.appendRecord({ record, trace: TRACE });
    const records = await client.listRecords({ sessionId: SESSION_ID, limit: 10 });
    const found = records.find((entry) => entry.recordId === record.recordId);
    expect(found).toBeDefined();
    expect(JSON.stringify(found?.payload)).toBe(payloadText);
  });
});
