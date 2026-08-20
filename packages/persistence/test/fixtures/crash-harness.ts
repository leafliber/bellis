import { appendFileSync } from "node:fs";
import { createOutboxDispatcher, createPersistenceClient } from "../../src/index.js";
import type {
  PersistenceCheckpoint,
  PersistenceCheckpointObserver,
  PersistenceClient,
} from "../../src/index.js";
import { VirtualClock } from "@bellis/testkit";
import { STATE_MIGRATIONS } from "../../src/migrations/registry.js";
import type { MigrationDefinition } from "../../src/migrations/definition.js";
import {
  SESSION_ID,
  TRACE,
  WORKER_FIXTURE,
  makeOutboxMessage,
  makeScene,
  outboxId,
} from "../helpers.js";

/**
 * Crash Window 测试子进程 harness（P2 文档 §11、§12.3）。
 *
 * 仅测试可用：通过 fork 继承的私有 IPC（process.send）向父进程报告
 * 到达检查点/关键状态，然后等待；父进程以 SIGKILL 强制终止本进程，
 * 模拟真实崩溃（普通 close() 不算 Crash Window）。
 *
 * 用法：node --import <hook> crash-harness.ts <scenario> <dataDirectory> [publishLogPath]
 */

function notifyParent(message: Record<string, unknown>): void {
  process.send?.(message);
}

/** 到达目标检查点后通知父进程并永久阻塞（等待被杀）；其余检查点放行。 */
function holdAtCheckpoint(target: PersistenceCheckpoint): PersistenceCheckpointObserver {
  return {
    reached: (reached: PersistenceCheckpoint) => {
      if (reached !== target) {
        return Promise.resolve();
      }
      notifyParent({ type: "checkpoint", checkpoint: reached });
      return new Promise<void>(() => {});
    },
  };
}

function buildClient(
  dataDirectory: string,
  observer?: PersistenceCheckpointObserver,
  migrations?: { state?: MigrationDefinition[] },
): PersistenceClient {
  return createPersistenceClient({
    dataDirectory,
    worker: WORKER_FIXTURE,
    ...(observer === undefined ? {} : { checkpointObserver: observer }),
    ...(migrations === undefined ? {} : { migrations }),
  });
}

const SCENE_N = 1;
const input = {
  sceneId: "22222222-2222-4222-8222-000000000001",
  cycleId: "33333333-3333-4333-8333-000000000001",
  sessionId: SESSION_ID,
  scene: makeScene({
    sceneId: "22222222-2222-4222-8222-000000000001",
    cycleId: "33333333-3333-4333-8333-000000000001",
  }),
  idempotencyKey: "crash-key-1",
  requestFingerprint: "crash-fp-1",
  watermarks: [{ source: "asr", watermark: 100n }],
  outbox: [makeOutboxMessage({ outboxId: outboxId(101) })],
  trace: TRACE,
};

async function prepare(client: PersistenceClient): Promise<void> {
  await client.migrate();
  await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 1, trace: TRACE });
}

async function main(): Promise<void> {
  const [scenario, dataDirectory, publishLogPath] = process.argv.slice(2) as [
    string,
    string,
    string | undefined,
  ];

  if (scenario === "commit-prekill") {
    const client = buildClient(dataDirectory, holdAtCheckpoint("before_scene_transaction_commit"));
    await prepare(client);
    void client.commitScene(input).finally(() => notifyParent({ type: "unexpected-done" }));
    return;
  }

  if (scenario === "commit-postkill") {
    const client = buildClient(dataDirectory);
    await prepare(client);
    const committed = await client.commitScene(input);
    notifyParent({ type: "committed", committedAtMs: committed.committedAtMs });
    // Dispatcher 检查点 2：Commit 成功后、Claim 发布前。
    const dispatcher = createOutboxDispatcher({
      client,
      ownerInstanceId: "crash-dispatcher",
      clock: new VirtualClock(),
      checkpointObserver: holdAtCheckpoint("after_scene_transaction_commit_before_outbox_dispatch"),
      publish: async () => ({ ok: true }),
    });
    void dispatcher.runOnce().finally(() => notifyParent({ type: "unexpected-done" }));
    return;
  }

  if (scenario === "publish-prekill") {
    const client = buildClient(dataDirectory);
    await prepare(client);
    await client.commitScene(input);
    // 检查点 3：发布成功后、标记 delivered 前。
    const dispatcher = createOutboxDispatcher({
      client,
      ownerInstanceId: "crash-dispatcher",
      clock: new VirtualClock(),
      checkpointObserver: holdAtCheckpoint("after_outbox_publish_before_mark_delivered"),
      publish: async (message) => {
        if (publishLogPath !== undefined) {
          appendFileSync(publishLogPath, `${message.outboxId}\n`);
        }
        return { ok: true };
      },
    });
    void dispatcher.runOnce().finally(() => notifyParent({ type: "unexpected-done" }));
    return;
  }

  if (scenario === "lease-prekill") {
    const client = buildClient(dataDirectory);
    await prepare(client);
    await client.commitScene(input);
    const claimed = await client.claimOutbox({
      limit: 5,
      leaseMs: 600_000,
      ownerInstanceId: "crash-owner",
    });
    notifyParent({ type: "leased", count: claimed.length });
    await new Promise<void>(() => {});
    return;
  }

  if (scenario === "migrate-partial") {
    // 只应用第一个 Migration 后通知父进程并等待（被杀）。
    const client = buildClient(dataDirectory, undefined, {
      state: STATE_MIGRATIONS.slice(0, 1) as MigrationDefinition[],
    });
    await client.migrate();
    notifyParent({ type: "migrated" });
    await new Promise<void>(() => {});
    return;
  }

  throw new Error(`unknown scenario: ${scenario}`);
}

void main().catch((error) => {
  notifyParent({ type: "harness-error", message: String(error) });
  process.exitCode = 1;
});

void SCENE_N;
