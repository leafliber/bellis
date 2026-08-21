import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { VirtualClock } from "@bellis/testkit";
import { createInMemoryMetrics, createPinoLogger } from "@bellis/observability";
import type { LoggerDestination, MetricSnapshot } from "@bellis/observability";
import { createOutboxDispatcher, createPersistenceClient } from "../../src/index.js";
import type { EnsureSessionInput, PersistenceClient } from "../../src/index.js";
import {
  SESSION_ID,
  TRACE,
  WORKER_FIXTURE,
  cleanupTempDataDirectory,
  createTempDataDirectory,
  makeOutboxMessage,
  makeScene,
  outboxId,
  sceneId,
  cycleId,
} from "../helpers.js";

/**
 * 评审回归（P3 评审 1）：P2 Outbox Dispatcher 与 P3 Observability 的真实装配。
 * 此前 Dispatcher 使用 bellis_outbox_delivered_total 等偏离指标名，注入
 * createInMemoryMetrics 后全部退化为 No-op（rejectedOperations=3、counters=[]）；
 * 本测试证明统一为 bellis_outbox_delivery_total{result=...} 后，
 * delivered/retry/dead 三条路径都写入真实 Series，且 Registry 零拒绝。
 *
 * 每个用例使用独立的临时数据库（评审 2-P2-4）：共享数据库时，上一用例
 * Retry 退避到期后的遗留消息会被下一用例的 claim 批次重新领取（慢 CI 下
 * 实测领取到 [2, 4]），用例间因此存在真实的时间耦合。
 *
 * createAssembly 在初始化失败（migrate/ensureSession 抛错）时同样清理
 * 临时目录与 Worker（评审 3-P3-3）——此时 assembly 尚未返回，调用方的
 * finally 接不到手，"失败也清理" 由第三个用例验证。
 */

interface Assembly {
  client: PersistenceClient;
  close: () => Promise<void>;
}

interface AssemblyInit {
  prefix: string;
  /**
   * 覆盖初始化 Session 序列（默认写入一次合法 Session）。测试可注入
   * 冲突元数据（同 sessionId、不同 createdAtMs）触发 ensureSession 的
   * session_conflict，用于验证初始化失败路径的清理（评审 3-P3-3）。
   */
  sessions?: EnsureSessionInput[];
}

async function createAssembly(init: AssemblyInit): Promise<Assembly> {
  const dataDirectory = createTempDataDirectory(init.prefix);
  const client = createPersistenceClient({
    dataDirectory,
    worker: WORKER_FIXTURE,
    retryPolicy: { baseMs: 40, maxMs: 200, maxAttempts: 8, jitterSeed: 3 },
  });
  try {
    await client.migrate();
    for (const session of init.sessions ?? [
      { sessionId: SESSION_ID, createdAtMs: 1, trace: TRACE },
    ]) {
      await client.ensureSession(session);
    }
  } catch (error) {
    // 初始化失败时调用方的 finally 尚未接手：临时目录与 Worker 必须在这里
    // 自行清理；清理自身的失败只吞掉，绝不掩盖原始错误（评审 3-P3-3）。
    try {
      await client.close();
    } catch {
      // 尽力而为：close 失败不掩盖 migrate/ensureSession 的原始错误。
    }
    try {
      cleanupTempDataDirectory(dataDirectory);
    } catch {
      // 同上：目录清理失败不掩盖原始错误。
    }
    throw error;
  }
  return {
    client,
    close: async () => {
      await client.close();
      cleanupTempDataDirectory(dataDirectory);
    },
  };
}

async function commitWithOutbox(client: PersistenceClient, n: number): Promise<void> {
  await client.commitScene({
    sceneId: sceneId(n),
    cycleId: cycleId(n),
    sessionId: SESSION_ID,
    scene: makeScene({ sceneId: sceneId(n), cycleId: cycleId(n) }),
    idempotencyKey: `assembly-${n}`,
    requestFingerprint: `assembly-fp-${n}`,
    watermarks: [{ source: "asr", watermark: BigInt(2000 + n) }],
    outbox: [makeOutboxMessage({ outboxId: outboxId(n) })],
    trace: TRACE,
  });
}

function deliveryTotal(snapshot: MetricSnapshot, result: string): number | undefined {
  return snapshot.counters.find(
    (counter) =>
      counter.name === "bellis_outbox_delivery_total" && counter.labels.result === result,
  )?.value;
}

describe("Outbox Dispatcher × Observability 真实装配", () => {
  it("delivered/retry/dead 三种结果都写入规范指标，Registry 零拒绝", async () => {
    const assembly = await createAssembly({ prefix: "bellis-p2-obs-assembly-1-" });
    try {
      const metrics = createInMemoryMetrics();
      const lines: string[] = [];
      const destination: LoggerDestination = {
        write: (line) => {
          lines.push(line);
        },
      };
      const logger = createPinoLogger({
        service: "bellis-persistence",
        version: "0.1.0",
        level: "info",
        destination,
      });
      const dispatcher = createOutboxDispatcher({
        client: assembly.client,
        ownerInstanceId: "assembly-owner",
        clock: new VirtualClock(),
        pollIntervalMs: 10,
        metrics,
        logger,
        publish: async (message) => {
          if (message.outboxId === outboxId(1)) {
            return { ok: true };
          }
          if (message.outboxId === outboxId(2)) {
            throw new Error("publisher exploded");
          }
          return { ok: false, errorCode: "permanent_failure", retryable: false };
        },
      });

      await commitWithOutbox(assembly.client, 1);
      await commitWithOutbox(assembly.client, 2);
      await commitWithOutbox(assembly.client, 3);

      const summary = await dispatcher.runOnce();
      expect(summary).toEqual({ claimed: 3, delivered: 1, retried: 1, dead: 1 });

      const snapshot = metrics.snapshot();
      expect(snapshot.rejectedOperations).toBe(0);
      expect(deliveryTotal(snapshot, "delivered")).toBe(1);
      expect(deliveryTotal(snapshot, "retry")).toBe(1);
      expect(deliveryTotal(snapshot, "dead")).toBe(1);
      // pending Gauge 也在同批刷新，且不带任何高基数 Label。
      const pending = snapshot.gauges.find((gauge) => gauge.name === "bellis_outbox_pending");
      expect(pending).toBeDefined();
      expect(Object.keys(pending?.labels ?? {})).toHaveLength(0);
      expect(() => JSON.stringify(snapshot)).not.toThrow();

      // 发布器抛错路径产生了结构化 warn 日志（Pino 装配验证）。
      const warnLines = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(warnLines).toHaveLength(1);
      expect(warnLines[0]?.event).toBe("bellis_outbox_publish_threw");
      expect(warnLines[0]?.service).toBe("bellis-persistence");
      expect(warnLines[0]?.version).toBe("0.1.0");
      expect(warnLines[0]?.level).toBe("warn");
      expect(warnLines[0]?.outboxId).toBe(outboxId(2));

      await dispatcher.stop();
    } finally {
      await assembly.close();
    }
  });

  it("只领取本用例写入的消息，与上一用例的退避遗留完全隔离", async () => {
    const assembly = await createAssembly({ prefix: "bellis-p2-obs-assembly-2-" });
    try {
      await commitWithOutbox(assembly.client, 4);
      const seen: string[] = [];
      const dispatcher = createOutboxDispatcher({
        client: assembly.client,
        ownerInstanceId: "assembly-owner-2",
        clock: new VirtualClock(),
        metrics: createInMemoryMetrics(),
        publish: async (message) => {
          seen.push(message.outboxId);
          if (message.outboxId === outboxId(4)) {
            return { ok: true };
          }
          return { ok: false, errorCode: "permanent", retryable: false };
        },
      });
      const summary = await dispatcher.runOnce();
      expect(seen).toEqual([outboxId(4)]);
      expect(summary.claimed).toBe(1);
      expect(summary.delivered).toBe(1);
      await dispatcher.stop();
    } finally {
      await assembly.close();
    }
  });

  it("cleans up the temp directory and worker when initialization fails (评审 3-P3-3)", async () => {
    // 同 sessionId、不同 createdAtMs → ensureSession 确定性抛 session_conflict。
    // 此时 assembly 尚未返回、调用方 finally 未接手，清理必须由
    // createAssembly 自己完成。
    const prefix = "bellis-p2-obs-assembly-fail-";
    const before = new Set(readdirSync(tmpdir()));
    await expect(
      createAssembly({
        prefix,
        sessions: [
          { sessionId: SESSION_ID, createdAtMs: 1, trace: TRACE },
          { sessionId: SESSION_ID, createdAtMs: 2, trace: TRACE },
        ],
      }),
    ).rejects.toThrow("session already exists");
    // 失败路径同样清理：本测试期间创建的、带唯一前缀的临时目录不残留。
    const leftovers = readdirSync(tmpdir()).filter(
      (entry) => !before.has(entry) && entry.startsWith(prefix),
    );
    expect(leftovers).toEqual([]);
  });
});
