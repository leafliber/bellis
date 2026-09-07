import { fork } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDataDirectory, createTempDataDirectory, RESOLVE_HOOK_URL } from "../helpers.js";

/**
 * 跨进程 Crash Window 测试（docs/reference/phase-1.md）：真实 fork 子进程 +
 * P2 私有 IPC 检查点 + SIGKILL 强制终止（普通 close 不算 Crash），
 * 再以同一数据目录重启并验证恢复结果。
 */

const HARNESS = join(import.meta.dirname, "..", "fixtures", "runtime-crash-harness.ts");

interface HarnessMessage {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface HarnessChild {
  readonly child: ReturnType<typeof fork>;
  readonly port: number;
  next(): Promise<HarnessMessage>;
  send(message: Record<string, unknown>): void;
  exchangeToken(): Promise<string>;
  kill(): Promise<void>;
  closeGracefully(): Promise<void>;
  expectNoCheckpoint(timeoutMs?: number): Promise<void>;
}

function forkHarness(dataDirectory: string, mode: "armed" | "production"): Promise<HarnessChild> {
  const child = fork(HARNESS, [dataDirectory, mode], {
    execArgv: ["--import", RESOLVE_HOOK_URL],
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });
  const pending: HarnessMessage[] = [];
  const waiters: Array<(message: HarnessMessage) => void> = [];
  child.on("message", (message: unknown) => {
    const event = message as HarnessMessage;
    const waiter = waiters.shift();
    if (waiter === undefined) {
      pending.push(event);
    } else {
      waiter(event);
    }
  });
  const exited = new Promise<never>((_, reject) => {
    child.once("exit", (code) => reject(new Error(`harness exited early (code=${code})`)));
  });

  function next(): Promise<HarnessMessage> {
    const buffered = pending.shift();
    if (buffered !== undefined) {
      return Promise.resolve(buffered);
    }
    const received = new Promise<HarnessMessage>((resolve) => waiters.push(resolve));
    return Promise.race([received, exited]);
  }

  async function start(): Promise<HarnessChild> {
    const ready = await next();
    if (ready.type !== "ready") {
      throw new Error(`expected ready, got ${JSON.stringify(ready)}`);
    }
    return {
      child,
      port: ready.port as number,
      next,
      send: (message) => child.send(message),
      exchangeToken: async () => {
        child.send({ type: "issue-token" });
        const reply = await next();
        if (reply.type !== "token") {
          throw new Error(`expected token, got ${JSON.stringify(reply)}`);
        }
        return reply.token as string;
      },
      kill: async () => {
        const dead = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill("SIGKILL");
        await dead;
      },
      closeGracefully: async () => {
        const closed = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.send({ type: "close" });
        await closed;
      },
      expectNoCheckpoint: async (timeoutMs = 1_500) => {
        const bounded = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
        const checkpoint = Promise.race([
          next().then((message) => message),
          bounded.then(() => null),
        ]);
        const message = await checkpoint;
        if (message !== null && message.type === "checkpoint") {
          throw new Error("unexpected checkpoint reached");
        }
        if (message !== null) {
          pending.push(message);
        }
      },
    };
  }

  return start();
}

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    cleanupTempDataDirectory(directory);
  }
});

function tempDirectory(prefix: string): string {
  const directory = createTempDataDirectory(prefix);
  directories.push(directory);
  return directory;
}

const COMMIT_INPUT = {
  sceneId: "22222222-2222-4222-8222-222222222222",
  cycleId: "33333333-3333-4333-8333-333333333333",
  idempotencyKey: "crash-key-1",
  cues: [
    { cueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", lane: "subtitle" as const },
    { cueId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", lane: "avatar" as const },
  ],
  watermarks: [{ source: "crash.asr", watermark: "9876543210987654321" }],
};

async function exchangeSession(port: number, token: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/auth/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ startupToken: token }),
  });
  if (response.status !== 200) {
    throw new Error(`exchange failed: ${response.status}`);
  }
  const body = (await response.json()) as { sessionId: string };
  return body.sessionId;
}

/** 顺序无关地收集 committed 与 checkpoint（arm 先于提交时两者先后不定）。 */
async function collectCommitAndCheckpoint(
  harness: HarnessChild,
): Promise<{ committed: HarnessMessage; checkpoint: HarnessMessage }> {
  let committed: HarnessMessage | null = null;
  let checkpoint: HarnessMessage | null = null;
  while (committed === null || checkpoint === null) {
    const message = await harness.next();
    if (message.type === "committed") {
      committed = message;
    } else if (message.type === "checkpoint") {
      checkpoint = message;
    } else if (message.type === "commit-error") {
      throw new Error(`commit failed: ${String(message.message)}`);
    }
  }
  return { committed, checkpoint };
}

async function pollDeliveries(harness: HarnessChild): Promise<readonly Record<string, unknown>[]> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    harness.send({ type: "deliveries" });
    const reply = await harness.next();
    if (reply.type !== "deliveries") {
      throw new Error(`expected deliveries, got ${JSON.stringify(reply)}`);
    }
    const records = reply.records as readonly Record<string, unknown>[];
    if (records.length > 0) {
      return records;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("no outbox deliveries observed");
}

describe("Crash Window W1：事务提交前终止", () => {
  it("重启后事实不存在；同请求可完整重提交", async () => {
    const directory = tempDirectory("bellis-p4-w1-");
    const first = await forkHarness(directory, "armed");
    const token = await first.exchangeToken();
    const sessionId = await exchangeSession(first.port, token);

    // 武装检查点 1（Worker 事务 COMMIT 前）→ 提交 → 到达检查点 → SIGKILL。
    first.send({ type: "arm", checkpoint: "before_scene_transaction_commit" });
    first.send({ type: "commit", input: { sessionId, ...COMMIT_INPUT } });
    const checkpoint = await first.next();
    expect(checkpoint.type).toBe("checkpoint");
    expect(checkpoint.checkpoint).toBe("before_scene_transaction_commit");
    await first.kill();

    // 同一数据目录重启（生产装配，无检查点）。
    const second = await forkHarness(directory, "production");
    try {
      second.send({ type: "recovery", sessionId });
      const recovery = await second.next();
      expect(recovery.type).toBe("recovery");
      expect(recovery.lastCommittedScene).toBeNull();
      expect(recovery.watermarks).toEqual([]);

      // 同请求完整重提交成功（第一个事务已回滚，无幂等残留）。
      const token2 = await second.exchangeToken();
      const sessionId2 = await exchangeSession(second.port, token2);
      second.send({ type: "commit", input: { sessionId, ...COMMIT_INPUT } });
      const committed = await second.next();
      expect(committed.type).toBe("committed");
      expect(committed.duplicate).toBe(false);
      void sessionId2;
    } finally {
      await second.closeGracefully();
    }
  });
});

describe("Crash Window W2：提交后、Outbox 发布前终止", () => {
  it("事实恢复、Outbox 重新交付、幂等重放无第二个逻辑结果", async () => {
    const directory = tempDirectory("bellis-p4-w2-");
    const first = await forkHarness(directory, "armed");
    const token = await first.exchangeToken();
    const sessionId = await exchangeSession(first.port, token);

    // 先武装再提交（评审修复 8）：Dispatcher 下一轮调度在 Claim 前被冻结，
    // 目标 Outbox 在实例 1 内绝无发布机会（消除 Dispatcher 竞态）。
    first.send({
      type: "arm",
      checkpoint: "after_scene_transaction_commit_before_outbox_dispatch",
    });
    first.send({ type: "commit", input: { sessionId, ...COMMIT_INPUT } });
    const { committed, checkpoint } = await collectCommitAndCheckpoint(first);
    expect(committed.duplicate).toBe(false);
    const traceId = committed.traceId as string;
    expect(checkpoint.checkpoint).toBe("after_scene_transaction_commit_before_outbox_dispatch");

    // 检查点对应的目标状态：实例 1 零交付（未 Claim/未发布）。
    first.send({ type: "deliveries" });
    const beforeKill = await first.next();
    expect(beforeKill.type).toBe("deliveries");
    expect(beforeKill.records).toEqual([]);
    await first.kill();

    const second = await forkHarness(directory, "production");
    try {
      second.send({ type: "recovery", sessionId });
      const recovery = await second.next();
      expect(recovery.type).toBe("recovery");
      expect((recovery.lastCommittedScene as Record<string, unknown> | null)?.sceneId).toBe(
        COMMIT_INPUT.sceneId,
      );
      expect(recovery.watermarks).toEqual([
        { source: "crash.asr", watermark: "9876543210987654321" },
      ]);
      // 本场景未建立 Control 连接：Server Seq 水位为 0（无消息分配），
      // Seq 持久化由 control-media 套件覆盖。
      expect(recovery.latestServerSeq).toBe("0");

      // Outbox 重新交付：发布记录携带第一次提交的 traceId。
      const deliveries = await pollDeliveries(second);
      expect(deliveries.length).toBe(1);
      expect(deliveries[0]?.topic).toBe("scene.committed");
      expect(deliveries[0]?.traceId).toBe(traceId);

      // 相同幂等键重放：duplicate，无第二个逻辑结果。
      second.send({ type: "commit", input: { sessionId, ...COMMIT_INPUT } });
      const replay = await second.next();
      expect(replay.type).toBe("committed");
      expect(replay.duplicate).toBe(true);

      second.send({ type: "deliveries" });
      const after = await second.next();
      expect((after.records as unknown[]).length).toBe(1);
    } finally {
      await second.closeGracefully();
    }
  });
});

describe("Crash Window W3/W4：发布后标记前终止（Lease 期间）", () => {
  it("允许重复交付，消费端按 outboxId/trace 去重；重启后完成标记", async () => {
    const directory = tempDirectory("bellis-p4-w3-");
    const first = await forkHarness(directory, "armed");
    const token = await first.exchangeToken();
    const sessionId = await exchangeSession(first.port, token);

    // 先武装再提交（评审修复 8）：只有目标消息发布成功后才会触发检查点 3
    // （空轮次不触发——发布未发生），检查点携带目标 outboxId。
    first.send({ type: "arm", checkpoint: "after_outbox_publish_before_mark_delivered" });
    first.send({ type: "commit", input: { sessionId, ...COMMIT_INPUT } });
    const { committed, checkpoint } = await collectCommitAndCheckpoint(first);
    const traceId = committed.traceId as string;
    expect(checkpoint.checkpoint).toBe("after_outbox_publish_before_mark_delivered");
    const targetOutboxId = checkpoint.outboxId as string;
    expect(targetOutboxId).toMatch(/^[0-9a-f-]{36}$/);

    // 严格对应：实例 1 的交付记录恰为检查点携带的 outboxId（此刻行处于
    // in_flight Lease，尚未标记 delivered）。
    first.send({ type: "deliveries" });
    const beforeKill = await first.next();
    expect(beforeKill.type).toBe("deliveries");
    expect(beforeKill.records).toEqual([
      expect.objectContaining({ outboxId: targetOutboxId, topic: "scene.committed" }),
    ]);
    await first.kill();

    // 重启：migrate 把 in_flight 重排队，Dispatcher 重新发布后标记 delivered。
    const second = await forkHarness(directory, "production");
    try {
      const deliveries = await pollDeliveries(second);
      expect(deliveries[0]?.topic).toBe("scene.committed");
      expect(deliveries[0]?.traceId).toBe(traceId);
      // 至少一次交付语义：重复交付允许，逻辑结果唯一由幂等键保证。
      second.send({ type: "recovery", sessionId });
      const recovery = await second.next();
      expect((recovery.lastCommittedScene as Record<string, unknown> | null)?.sceneId).toBe(
        COMMIT_INPUT.sceneId,
      );
    } finally {
      await second.closeGracefully();
    }
  });
});

describe("检查点仅测试装配可用", () => {
  it("生产装配不注入观察器：到达检查点语义不存在（无消息、无阻塞）", async () => {
    const directory = tempDirectory("bellis-p4-noop-");
    const harness = await forkHarness(directory, "production");
    try {
      const token = await harness.exchangeToken();
      const sessionId = await exchangeSession(harness.port, token);
      harness.send({ type: "arm", checkpoint: "before_scene_transaction_commit" });
      harness.send({ type: "commit", input: { sessionId, ...COMMIT_INPUT } });
      const committed = await harness.next();
      expect(committed.type).toBe("committed");
      expect(committed.duplicate).toBe(false);
      // arm 消息对生产 harness 无效（无观察器），事务正常完成。
    } finally {
      await harness.closeGracefully();
    }
  });
});

// 供 Demo 脚本复用的路径导出（保持单一事实源）。
export const HARNESS_PATH = pathToFileURL(HARNESS).href;
