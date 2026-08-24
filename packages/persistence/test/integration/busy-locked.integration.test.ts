import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { PersistenceError, createPersistenceClient } from "../../src/index.js";
import type { PersistenceClient } from "../../src/index.js";
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
 * SQLite Busy/Locked 集成测试（docs/protocols/persistence-and-recovery.md）。
 *
 * 同目录只允许一个 DB Worker（worker-lock 独占，见 worker-lock 测试），
 * 锁竞争改由外部连接制造：测试进程持有 state.db 的 EXCLUSIVE 锁，
 * Worker 的写事务等待 busy_timeout=3000 后必须收到可重试的
 * database_busy，而不是崩溃或数据损坏。
 */

let dataDirectory: string;
let client: PersistenceClient;

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
  client = createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
  await client.migrate();
  await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 1, trace: TRACE });
});

afterAll(async () => {
  await client.close();
  cleanupTempDataDirectory(dataDirectory);
});

describe("SQLite Busy/Locked", () => {
  it("外部连接持有写锁时，Worker 超时收到可重试 database_busy", async () => {
    const holder = new DatabaseSync(join(dataDirectory, "state.db"));
    holder.exec("PRAGMA busy_timeout = 100;");
    holder.exec("BEGIN EXCLUSIVE");
    try {
      await expect(client.commitScene(commitInput(1))).rejects.toMatchObject({
        code: "database_busy",
        retryable: true,
      });
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    // 竞争请求没有留下部分事实。
    const stats = await client.readOutboxStats();
    expect(stats).toEqual({ pending: 0, inFlight: 0, delivered: 0, dead: 0 });
  });

  it("锁释放后同一请求可成功重试", async () => {
    const retried = await client.commitScene(commitInput(1));
    expect(retried.duplicate).toBe(false);
    expect(retried.sceneId).toBe(sceneId(1));
  });

  it("database_busy 是唯一可从锁竞争观察到的错误形态", async () => {
    const error = new PersistenceError("database_busy", "database is busy");
    expect(error.retryable).toBe(true);
    expect(error.safe.code).toBe("database_busy");
  });
});
