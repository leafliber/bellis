import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPersistenceClient } from "../../src/index.js";
import type { PersistenceClient } from "../../src/index.js";
import {
  SESSION_ID,
  TRACE,
  WORKER_FIXTURE,
  cleanupTempDataDirectory,
  createTempDataDirectory,
  makeSessionRecord,
} from "../helpers.js";

/**
 * 事件循环隔离测试（docs/protocols/persistence-and-recovery.md）：
 * Worker 执行批量写入时持续采样主线程定时器漂移，
 * 证明主事件循环没有同步执行 SQLite。
 *
 * 该用例同时回归了一个真实缺陷：无聚合列的 Session Record 读取时
 * 曾携带显式 undefined 键跨 postMessage 边界，导致 listRecords 响应
 * 被 JsonValueSchema 判非法而永久挂起。
 */

let dataDirectory: string;
let client: PersistenceClient;

beforeAll(async () => {
  dataDirectory = createTempDataDirectory("bellis-p2-loop-");
  client = createPersistenceClient({
    dataDirectory,
    worker: WORKER_FIXTURE,
    defaultDeadlineMs: 30_000,
  });
  await client.migrate();
  await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 1, trace: TRACE });
});

afterAll(async () => {
  await client.close();
  cleanupTempDataDirectory(dataDirectory);
});

describe("事件循环隔离", () => {
  it("批量写入期间主线程保持响应（定时器漂移有界）", async () => {
    // 固定 25 轮 × 10ms 采样窗口，与写入完成解耦：无论批量写多早结束，
    // 采样都跑满固定轮数，样本数是确定值，消除「写入先于采样结束导致
    // 样本不足」的时序抖动（评审残留项：不得依赖写入时长）。
    const SAMPLE_ROUNDS = 25;
    const drifts: number[] = [];
    const sampleLoop = (async () => {
      let lastTick = performance.now();
      for (let round = 0; round < SAMPLE_ROUNDS; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const now = performance.now();
        drifts.push(now - lastTick);
        lastTick = now;
      }
    })();

    const BATCH = 500;
    const writes: Promise<unknown>[] = [];
    for (let i = 0; i < BATCH; i += 1) {
      writes.push(
        client.appendRecord({
          record: makeSessionRecord({
            recordId: `99999999-9999-4999-8999-${i.toString().padStart(12, "0")}`,
            recordType: "load.record",
            payload: { index: i, blob: "x".repeat(512) },
          }),
          trace: TRACE,
        }),
      );
    }
    await Promise.all(writes);
    await sampleLoop;

    expect(drifts).toHaveLength(SAMPLE_ROUNDS);
    // SQLite 全部在 Worker 线程执行；主线程只处理 Promise 微任务。
    // 阈值 250ms 覆盖 CI 抖动，仍远小于同步写 500 条的量级。
    expect(Math.max(...drifts)).toBeLessThan(250);
    const records = await client.listRecords({ sessionId: SESSION_ID, limit: 1000 });
    expect(records.filter((record) => record.recordType === "load.record")).toHaveLength(BATCH);
  });

  it("Close 后没有 Worker 线程残留", async () => {
    // 独立目录：主客户端仍持有同目录的 Worker 独占守卫。
    const dir = createTempDataDirectory("bellis-p2-loop-close-");
    const ephemeral = createPersistenceClient({ dataDirectory: dir, worker: WORKER_FIXTURE });
    try {
      await ephemeral.migrate();
      await ephemeral.close();
    } finally {
      cleanupTempDataDirectory(dir);
    }
    expect(process.getActiveResourcesInfo().filter((r) => r === "Worker")).toEqual([]);
  });
});
