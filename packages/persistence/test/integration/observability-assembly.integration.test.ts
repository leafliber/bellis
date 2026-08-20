import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VirtualClock } from "@bellis/testkit";
import { createInMemoryMetrics, createPinoLogger } from "@bellis/observability";
import type { LoggerDestination, MetricSnapshot } from "@bellis/observability";
import { createOutboxDispatcher, createPersistenceClient } from "../../src/index.js";
import type { PersistenceClient } from "../../src/index.js";
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
 */

let dataDirectory: string;
let client: PersistenceClient;

async function commitWithOutbox(n: number): Promise<void> {
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

beforeAll(async () => {
  dataDirectory = createTempDataDirectory("bellis-p2-obs-assembly-");
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

function deliveryTotal(snapshot: MetricSnapshot, result: string): number | undefined {
  return snapshot.counters.find(
    (counter) =>
      counter.name === "bellis_outbox_delivery_total" && counter.labels.result === result,
  )?.value;
}

describe("Outbox Dispatcher × Observability 真实装配", () => {
  it("delivered/retry/dead 三种结果都写入规范指标，Registry 零拒绝", async () => {
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
      client,
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

    await commitWithOutbox(1);
    await commitWithOutbox(2);
    await commitWithOutbox(3);

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
  });

  it("发布器按消息返回三种结果（本测试的发布器约定）", async () => {
    await commitWithOutbox(4);
    const seen: string[] = [];
    const dispatcher = createOutboxDispatcher({
      client,
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
    expect(summary.delivered).toBe(1);
    await dispatcher.stop();
  });
});
