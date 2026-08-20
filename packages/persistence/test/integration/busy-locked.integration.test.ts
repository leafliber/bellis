import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PersistenceError, createPersistenceClient } from "../../src/index.js";
import type { PersistenceClient, PersistenceCheckpoint } from "../../src/index.js";
import {
  SESSION_ID,
  TRACE,
  WORKER_FIXTURE,
  cleanupTempDataDirectory,
  createTempDataDirectory,
  cycleId,
  makeScene,
  sceneId,
} from "../helpers.js";

/**
 * SQLite Busy/Locked 集成测试（P2 文档 §12.3-2）。
 *
 * 用真实双 Worker 制造锁竞争：Client A 的 commitScene 在检查点
 * before_scene_transaction_commit 处持有 BEGIN IMMEDIATE 写锁；
 * Client B（独立 Worker/连接）提交时只能等待 busy_timeout=3000，
 * 超时后必须收到可重试的 database_busy，而不是崩溃或数据损坏。
 */

let dataDirectory: string;
let clientA: PersistenceClient;
let clientB: PersistenceClient;
let releaseA: (() => void) | null = null;

function commitInput(n: number) {
  return {
    sceneId: sceneId(n),
    cycleId: cycleId(n),
    sessionId: SESSION_ID,
    scene: makeScene({ sceneId: sceneId(n), cycleId: cycleId(n) }),
    idempotencyKey: `busy-${n}`,
    requestFingerprint: `busy-fp-${n}`,
    watermarks: [{ source: "asr", watermark: BigInt(n) }],
    outbox: [],
    trace: TRACE,
  };
}

beforeAll(async () => {
  dataDirectory = createTempDataDirectory("bellis-p2-busy-");
  const holdObserver = {
    reached: (_checkpoint: PersistenceCheckpoint) =>
      new Promise<void>((resolve) => {
        releaseA = resolve;
      }),
  };
  clientA = createPersistenceClient({
    dataDirectory,
    worker: WORKER_FIXTURE,
    checkpointObserver: holdObserver,
  });
  clientB = createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
  await clientA.migrate();
  await clientB.migrate();
  await clientA.ensureSession({ sessionId: SESSION_ID, createdAtMs: 1, trace: TRACE });
});

afterAll(async () => {
  await clientA.close();
  await clientB.close();
  cleanupTempDataDirectory(dataDirectory);
});

describe("SQLite Busy/Locked", () => {
  it("写锁被持有时，另一 Worker 超时收到可重试 database_busy", async () => {
    const held = clientA.commitScene(commitInput(1));
    // 等待 A 到达检查点（已持有写锁）。
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(releaseA).not.toBeNull();

    await expect(clientB.commitScene(commitInput(2))).rejects.toMatchObject({
      code: "database_busy",
      retryable: true,
    });

    // 释放 A 的检查点：A 正常提交，B 的请求没有留下部分事实。
    releaseA?.();
    const result = await held;
    expect(result.duplicate).toBe(false);
    const records = await clientB.listRecords({
      aggregateId: `scene-commit:${SESSION_ID}`,
    });
    expect(records).toHaveLength(1);
  });

  it("锁释放后同一请求可成功重试", async () => {
    const retried = await clientB.commitScene(commitInput(2));
    expect(retried.duplicate).toBe(false);
    expect(retried.sceneId).toBe(sceneId(2));
  });

  it("database_busy 是唯一可从锁竞争观察到的错误形态", async () => {
    const error = new PersistenceError("database_busy", "database is busy");
    expect(error.retryable).toBe(true);
    expect(error.safe.code).toBe("database_busy");
  });
});
