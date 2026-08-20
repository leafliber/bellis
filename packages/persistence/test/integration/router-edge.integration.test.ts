import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MessagePort } from "node:worker_threads";
import { STATE_MIGRATIONS, TELEMETRY_MIGRATIONS } from "../../src/migrations/registry.js";
import { WorkerDatabases } from "../../src/worker/database.js";
import { WorkerOperationRuntime } from "../../src/worker/operations.js";
import { PersistenceRpcRouter } from "../../src/worker/rpc-router.js";
import {
  SESSION_ID,
  TRACE,
  cleanupTempDataDirectory,
  createTempDataDirectory,
  makeOutboxMessage,
  makeScene,
  outboxId,
  sceneId,
  cycleId,
} from "../helpers.js";
import type { PersistenceRpcResponse } from "../../src/rpc/envelope.js";

/**
 * 路由器边界集成测试：真实 SQLite（WorkerDatabases 直接构造）+
 * 假 MessagePort，覆盖畸形消息、未知操作、Deadline、检查点桥与串行执行。
 * 这些路径不经过 worker_threads，便于精确注入消息。
 */

class FakePort extends EventEmitter {
  readonly posted: unknown[] = [];

  postMessage(message: unknown): void {
    this.posted.push(message);
  }
}

interface Harness {
  port: FakePort;
  router: PersistenceRpcRouter;
  runtime: WorkerOperationRuntime;
  databases: WorkerDatabases;
}

let dataDirectory: string;

function bootstrap(options?: { checkpointsEnabled?: boolean }): Harness {
  const databases = new WorkerDatabases({ dataDirectory });
  const runtime = new WorkerOperationRuntime({
    databases,
    stateMigrations: STATE_MIGRATIONS,
    telemetryMigrations: TELEMETRY_MIGRATIONS,
  });
  const port = new FakePort();
  const router = new PersistenceRpcRouter({
    runtime,
    checkpointsEnabled: options?.checkpointsEnabled ?? false,
    port: port as unknown as MessagePort,
  });
  return { port, router, runtime, databases };
}

function request(
  port: FakePort,
  body: {
    operation?: string;
    payload?: unknown;
    deadlineUs?: string;
    requestId?: string;
  } = {},
): Promise<PersistenceRpcResponse | undefined> {
  const requestId = body.requestId ?? randomUUID();
  port.emit("message", {
    version: 1,
    requestId,
    operation: body.operation ?? "ping",
    deadlineUs: body.deadlineUs,
    trace: TRACE,
    payload: body.payload ?? {},
  });
  return waitForResponse(port, requestId);
}

async function waitForResponse(
  port: FakePort,
  requestId: string,
  waitMs = 10_000,
): Promise<PersistenceRpcResponse | undefined> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const found = port.posted.find(
      (message): message is PersistenceRpcResponse =>
        typeof message === "object" &&
        message !== null &&
        (message as PersistenceRpcResponse).requestId === requestId &&
        "ok" in (message as Record<string, unknown>),
    );
    if (found !== undefined) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return undefined;
}

beforeAll(() => {
  dataDirectory = createTempDataDirectory("bellis-p2-router-");
});

afterAll(() => {
  cleanupTempDataDirectory(dataDirectory);
});

async function waitForNotice(port: FakePort): Promise<{ requestId: string }> {
  const deadline = Date.now() + 5_000;
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const found = port.posted.find(
        (message) =>
          typeof message === "object" &&
          (message as { type?: string }).type === "persistence_checkpoint",
      );
      if (found !== undefined) {
        clearInterval(timer);
        clearTimeout(fallback);
        resolve(found as { requestId: string });
      }
    }, 5);
    const fallback = setTimeout(() => {
      clearInterval(timer);
      resolve({ requestId: "" });
    }, 5_000);
    void deadline;
  });
}

describe("RPC 路由器", () => {
  it("ping/migrate 正常工作", async () => {
    const h = bootstrap();
    try {
      const pong = await request(h.port);
      expect(pong?.ok).toBe(true);
      const migrated = await request(h.port, { operation: "migrate" });
      expect(migrated?.ok).toBe(true);
      const migratePayload = migrated?.payload as { requeuedInFlight: number };
      expect(migratePayload.requeuedInFlight).toBe(0);
    } finally {
      h.router.close();
      h.databases.close();
    }
  });

  it("未知操作稳定拒绝（不接受任意方法名/SQL）", async () => {
    const h = bootstrap();
    try {
      const response = await request(h.port, { operation: "exec_sql" });
      expect(response?.ok).toBe(false);
      expect(response?.error?.code).toBe("invalid_request");
      const response2 = await request(h.port, {
        operation: "DROP TABLE sessions",
      });
      expect(response2?.error?.code).toBe("invalid_request");
    } finally {
      h.router.close();
      h.databases.close();
    }
  });

  it("畸形 Envelope 被丢弃且不影响后续请求", async () => {
    const h = bootstrap();
    try {
      const postedBefore = h.port.posted.length;
      h.port.emit("message", { garbage: true });
      h.port.emit("message", "not-an-object");
      h.port.emit("message", null);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.port.posted.length).toBe(postedBefore);
      const pong = await request(h.port);
      expect(pong?.ok).toBe(true);
    } finally {
      h.router.close();
      h.databases.close();
    }
  });

  it("已过 Deadline 的请求在事务开始前拒绝", async () => {
    const h = bootstrap();
    try {
      await request(h.port, { operation: "migrate" });
      const response = await request(h.port, {
        operation: "ensure_session",
        payload: { sessionId: SESSION_ID, createdAtMs: 1 },
        deadlineUs: "1",
      });
      expect(response?.error?.code).toBe("deadline_exceeded");
    } finally {
      h.router.close();
      h.databases.close();
    }
  });

  it("操作串行执行：并发请求按到达顺序完成", async () => {
    const h = bootstrap();
    try {
      await request(h.port, { operation: "migrate" });
      await request(h.port, {
        operation: "ensure_session",
        payload: { sessionId: SESSION_ID, createdAtMs: 1 },
      });
      const responsesInOrder: string[] = [];
      const sends = [1, 2, 3].map((n) => {
        const requestId = randomUUID();
        h.port.emit("message", {
          version: 1,
          requestId,
          operation: "advance_server_seq",
          trace: TRACE,
          payload: { sessionId: SESSION_ID, latestServerSeq: `${n}` },
        });
        return waitForResponse(h.port, requestId).then((response) => {
          const seqPayload = response?.payload as { latestServerSeq: string };
          responsesInOrder.push(String(seqPayload.latestServerSeq));
        });
      });
      await Promise.all(sends);
      // 串行 + 单调：最终值为最大值，无中间倒退结果。
      expect(responsesInOrder).toEqual(["1", "2", "3"]);
    } finally {
      h.router.close();
      h.databases.close();
    }
  });
});

describe("检查点桥", () => {
  let commitCounter = 0;
  async function commitSceneRequest(port: FakePort): Promise<PersistenceRpcResponse | undefined> {
    commitCounter += 1;
    return request(port, {
      operation: "commit_scene",
      payload: {
        sceneId: sceneId(commitCounter + 100),
        cycleId: cycleId(commitCounter + 100),
        sessionId: SESSION_ID,
        scene: makeScene({
          sceneId: sceneId(commitCounter + 100),
          cycleId: cycleId(commitCounter + 100),
        }),
        idempotencyKey: `ck-${commitCounter}`,
        requestFingerprint: "fp",
        watermarks: [{ source: "asr", watermark: `${commitCounter}` }],
        outbox: [makeOutboxMessage({ outboxId: outboxId(commitCounter + 100) })],
      },
    });
  }

  it("未启用检查点：事务顺序与结果不受影响，无通知消息", async () => {
    const h = bootstrap();
    try {
      await request(h.port, { operation: "migrate" });
      await request(h.port, {
        operation: "ensure_session",
        payload: { sessionId: SESSION_ID, createdAtMs: 1 },
      });
      const response = await commitSceneRequest(h.port);
      expect(response?.ok).toBe(true);
      expect(
        h.port.posted.some(
          (message) =>
            typeof message === "object" &&
            (message as { type?: string }).type === "persistence_checkpoint",
        ),
      ).toBe(false);
    } finally {
      h.router.close();
      h.databases.close();
    }
  });

  it("启用后到达 before_scene_transaction_commit 并等待释放；proceed 提交", async () => {
    const h = bootstrap({ checkpointsEnabled: true });
    try {
      await request(h.port, { operation: "migrate" });
      await request(h.port, {
        operation: "ensure_session",
        payload: { sessionId: SESSION_ID, createdAtMs: 1 },
      });
      const pending = commitSceneRequest(h.port);
      const notice = await waitForNotice(h.port);
      expect(notice.requestId).not.toBe("");
      // 释放前短暂观察窗口内没有响应。
      expect(await waitForResponse(h.port, notice.requestId, 200)).toBeUndefined();
      h.port.emit("message", {
        type: "persistence_checkpoint_release",
        version: 1,
        requestId: notice.requestId,
        proceed: true,
      });
      const response = await pending;
      expect(response?.ok).toBe(true);
    } finally {
      h.router.close();
      h.databases.close();
    }
  });

  it("释放 proceed=false → checkpoint_aborted 且事务回滚", async () => {
    const h = bootstrap({ checkpointsEnabled: true });
    try {
      await request(h.port, { operation: "migrate" });
      await request(h.port, {
        operation: "ensure_session",
        payload: { sessionId: SESSION_ID, createdAtMs: 1 },
      });
      const statsBefore = await request(h.port, { operation: "read_outbox_stats" });
      const beforePayload = statsBefore?.payload as { pending: number };
      const pendingBefore = beforePayload.pending;
      const pending = commitSceneRequest(h.port);
      const notice = await waitForNotice(h.port);
      expect(notice.requestId).not.toBe("");
      h.port.emit("message", {
        type: "persistence_checkpoint_release",
        version: 1,
        requestId: notice.requestId,
        proceed: false,
      });
      const response = await pending;
      expect(response?.ok).toBe(false);
      expect(response?.error?.code).toBe("checkpoint_aborted");
      const statsAfter = await request(h.port, { operation: "read_outbox_stats" });
      // 回滚后没有任何新 Outbox/Scene 事实。
      const afterPayload = statsAfter?.payload as { pending: number };
      expect(afterPayload.pending).toBe(pendingBefore);
    } finally {
      h.router.close();
      h.databases.close();
    }
  });
});
