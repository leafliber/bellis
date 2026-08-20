import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { VirtualClock } from "@bellis/testkit";
import { createOutboxDispatcher, createPersistenceClient } from "../../src/index.js";
import { createPersistenceClientForTesting } from "../../src/client/persistence-client.js";
import type { PersistenceClient } from "../../src/index.js";
import { STATE_MIGRATIONS } from "../../src/migrations/registry.js";
import type { MigrationDefinition } from "../../src/migrations/definition.js";
import {
  SESSION_ID,
  TRACE,
  WORKER_FIXTURE,
  cleanupTempDataDirectory,
  createTempDataDirectory,
  outboxId,
} from "../helpers.js";
import { fileURLToPath } from "node:url";

/**
 * Crash Window 集成测试（P2 文档 §11、§12.3-4~7）：
 * 真实子进程 + 真实临时 SQLite + SIGKILL 强制终止。
 * 普通 close() 不算 Crash Window；父进程在子进程报告到达检查点后执行
 * 真正的强制终止，再以同一数据目录重启验证恢复结果。
 */

const HARNESS = fileURLToPath(new URL("../fixtures/crash-harness.ts", import.meta.url));
const HOOK = WORKER_FIXTURE.execArgv[1] as string;

interface HarnessMessage {
  readonly type: string;
  readonly checkpoint?: string;
  readonly count?: number;
  readonly committedAtMs?: number;
  readonly message?: string;
}

function spawnHarness(
  scenario: string,
  dataDirectory: string,
  extraArg?: string,
): { child: ChildProcess; messages: HarnessMessage[] } {
  const child = fork(HARNESS, [scenario, dataDirectory, ...(extraArg ? [extraArg] : [])], {
    execArgv: ["--import", HOOK],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages: HarnessMessage[] = [];
  child.on("message", (message: HarnessMessage) => {
    messages.push(message);
  });
  return { child, messages };
}

async function waitFor(
  child: ChildProcess,
  messages: HarnessMessage[],
  type: string,
  timeoutMs = 15_000,
): Promise<HarnessMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages.find((message) => message.type === type);
    if (found !== undefined) {
      return found;
    }
    if (child.exitCode !== null) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`harness did not report ${type}`);
}

/** SIGKILL 强制终止并等待进程退出。 */
async function killChild(child: ChildProcess): Promise<void> {
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.on("exit", () => resolve());
  });
}

function openState(dataDirectory: string): DatabaseSync {
  const db = new DatabaseSync(join(dataDirectory, "state.db"));
  db.exec("PRAGMA busy_timeout = 3000;");
  return db;
}

async function restartClient(dataDirectory: string): Promise<PersistenceClient> {
  const client = createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
  await client.migrate();
  return client;
}

const crashDirs: string[] = [];

afterAll(() => {
  for (const dir of crashDirs) {
    cleanupTempDataDirectory(dir);
  }
});

describe("Crash Window 恢复（真实 SIGKILL）", () => {
  it("W1 提交前终止：所有事实不存在，同请求可完整重提交", async () => {
    const dir = createTempDataDirectory("bellis-p2-crash-w1-");
    crashDirs.push(dir);
    const { child, messages } = spawnHarness("commit-prekill", dir);
    try {
      await waitFor(child, messages, "checkpoint");
      await killChild(child);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }

    const client = await restartClient(dir);
    try {
      const stats = await client.readOutboxStats();
      expect(stats).toEqual({ pending: 0, inFlight: 0, delivered: 0, dead: 0 });
      const records = await client.listRecords({
        aggregateId: `scene-commit:${SESSION_ID}`,
      });
      expect(records).toEqual([]);
      const db = openState(dir);
      try {
        const scenes = db.prepare("SELECT COUNT(*) AS n FROM scenes").get();
        expect(Number(scenes?.["n"])).toBe(0);
        const keys = db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys").get();
        expect(Number(keys?.["n"])).toBe(0);
        const watermarks = db.prepare("SELECT COUNT(*) AS n FROM signal_watermarks").get();
        expect(Number(watermarks?.["n"])).toBe(0);
      } finally {
        db.close();
      }
      // 同请求重提交成功（非 duplicate）。
      const recommitted = await client.commitScene({
        sceneId: "22222222-2222-4222-8222-000000000001",
        cycleId: "33333333-3333-4333-8333-000000000001",
        sessionId: SESSION_ID,
        scene: {
          schemaVersion: 1,
          sceneId: "22222222-2222-4222-8222-000000000001",
          cycleId: "33333333-3333-4333-8333-000000000001",
          groups: [
            {
              schemaVersion: 1,
              groupId: "44444444-4444-4444-8444-444444444444",
              lanes: ["audio"],
              level: "hard",
            },
          ],
          deadlineMs: 5_000,
          interruptPolicy: "finish",
        },
        idempotencyKey: "crash-key-1",
        requestFingerprint: "crash-fp-1",
        watermarks: [{ source: "asr", watermark: 100n }],
        outbox: [],
        trace: TRACE,
      });
      expect(recommitted.duplicate).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("W2 提交后、发布前终止：事实完整，重启后重新发布", async () => {
    const dir = createTempDataDirectory("bellis-p2-crash-w2-");
    crashDirs.push(dir);
    const { child, messages } = spawnHarness("commit-postkill", dir);
    try {
      await waitFor(child, messages, "committed");
      await waitFor(child, messages, "checkpoint");
      await killChild(child);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }

    const client = await restartClient(dir);
    try {
      const recovery = await client.readRecoveryState(SESSION_ID);
      expect(recovery.latestServerSeq).toBe(0n);
      expect(recovery.signalWatermarks).toEqual([{ source: "asr", watermark: 100n }]);
      expect(recovery.lastCommittedScene?.sceneId).toBe("22222222-2222-4222-8222-000000000001");
      // 幂等重放返回 duplicate 的第一次结果。
      const replay = await client.readOutboxStats();
      expect(replay.pending).toBe(1);
      // 重启 Dispatcher 重新发布。
      const published: string[] = [];
      const dispatcher = createOutboxDispatcher({
        client,
        ownerInstanceId: "restart-dispatcher",
        clock: new VirtualClock(),
        publish: async (message) => {
          published.push(message.outboxId);
          return { ok: true };
        },
      });
      const summary = await dispatcher.runOnce();
      await dispatcher.stop();
      expect(summary.delivered).toBe(1);
      expect(published).toEqual([outboxId(101)]);
      expect((await client.readOutboxStats()).delivered).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("W3 发布后、标记 delivered 前终止：允许重复交付，消费者按 outboxId 去重", async () => {
    const dir = createTempDataDirectory("bellis-p2-crash-w3-");
    crashDirs.push(dir);
    const publishLog = join(dir, "publish.log");
    const { child, messages } = spawnHarness("publish-prekill", dir, publishLog);
    try {
      await waitFor(child, messages, "checkpoint");
      await killChild(child);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }

    // 崩溃前确实发布过一次。
    expect(readFileSync(publishLog, "utf8").trim()).toBe(outboxId(101));

    const client = await restartClient(dir);
    try {
      // in_flight 已被启动恢复重排队 → 重新发布（重复交付是允许的）。
      const dispatcher = createOutboxDispatcher({
        client,
        ownerInstanceId: "restart-dispatcher-w3",
        clock: new VirtualClock(),
        publish: async (message) => {
          appendFileSync(publishLog, `${message.outboxId}\n`);
          return { ok: true };
        },
      });
      const summary = await dispatcher.runOnce();
      await dispatcher.stop();
      expect(summary.delivered).toBe(1);
      const log = readFileSync(publishLog, "utf8").trim().split("\n");
      // 消费者按 outboxId 去重：物理重复、逻辑一次。
      expect(new Set(log).size).toBe(1);
      expect(log.length).toBe(2);
      expect((await client.readOutboxStats()).delivered).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("W4 Lease 期间终止：重启后立即恢复可领取，不等待旧截止时间", async () => {
    const dir = createTempDataDirectory("bellis-p2-crash-w4-");
    crashDirs.push(dir);
    const { child, messages } = spawnHarness("lease-prekill", dir);
    try {
      const leased = await waitFor(child, messages, "leased");
      expect(leased.count).toBe(1);
      await killChild(child);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }

    const client = await restartClient(dir);
    try {
      // 旧 Lease 截止在 10 分钟后；不等待，立即领取成功。
      const claimed = await client.claimOutbox({
        limit: 5,
        leaseMs: 60_000,
        ownerInstanceId: "restart-owner",
      });
      expect(claimed.map((message) => message.outboxId)).toEqual([outboxId(101)]);
      await client.completeOutbox({
        outboxId: outboxId(101),
        ownerInstanceId: "restart-owner",
      });
      expect((await client.readOutboxStats()).delivered).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("Migration 中断：重启后续跑未应用的 Migration（断点幂等）", async () => {
    const dir = createTempDataDirectory("bellis-p2-crash-mig-");
    crashDirs.push(dir);
    const { child, messages } = spawnHarness("migrate-partial", dir);
    try {
      await waitFor(child, messages, "migrated");
      await killChild(child);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }

    const extra: MigrationDefinition = {
      version: 2,
      name: "extra",
      sql: "CREATE TABLE test_extra (id INTEGER PRIMARY KEY) STRICT;",
    };
    const client = createPersistenceClientForTesting(
      { dataDirectory: dir, worker: WORKER_FIXTURE },
      { migrations: { state: [...(STATE_MIGRATIONS as MigrationDefinition[]), extra] } },
    );
    try {
      await client.migrate();
      const db = openState(dir);
      try {
        const versions = db
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all()
          .map((row) => Number(row["version"]));
        expect(versions).toEqual([1, 2]);
        expect(
          db.prepare("SELECT name FROM sqlite_master WHERE name = 'test_extra'").get(),
        ).toBeDefined();
      } finally {
        db.close();
      }
    } finally {
      await client.close();
    }
  });
});
