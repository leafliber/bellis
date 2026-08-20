import { describe, expect, it } from "vitest";
import {
  childTraceContext,
  createInMemoryMetrics,
  createPinoLogger,
  createTraceContext,
  createTraceContextManager,
  parseTraceparent,
} from "../src/index.js";
import type { LoggerDestination, TraceRandomSource } from "../src/index.js";

/**
 * 使用示例（p3-observability-testkit.md §1）：P1/P2/P4 以 Gate 1 Port 的方式
 * 装配 Trace + Logger + Metrics。本测试即文档：不依赖任何实现内部状态。
 */

/** 测试注入的确定性随机源：结构兼容 TraceRandomSource（生产注入 crypto 源）。 */
const deterministicSource: TraceRandomSource = (() => {
  let state = 0x1234_5678n;
  const step = () => {
    state = (state * 0x9e37_79b9_7f4a_7c15n + 1n) & 0xffff_ffff_ffff_ffffn;
    return state.toString(16).padStart(16, "0");
  };
  return {
    traceId: () => step() + step(),
    spanId: () => step().slice(0, 16),
  };
})();

describe("assembly usage example (P4 runtime wiring)", () => {
  it("serves an HTTP request end to end with trace, logs and metrics", () => {
    const lines: string[] = [];
    const destination: LoggerDestination = {
      write: (line) => {
        lines.push(line);
      },
    };
    const logger = createPinoLogger({
      service: "bellis-runtime",
      version: "0.1.0",
      level: "info",
      destination,
    });
    const metrics = createInMemoryMetrics();
    const traces = createTraceContextManager();

    // HTTP 边界：合法 traceparent 被采纳，非法值丢弃并创建新 Trace。
    const incoming = parseTraceparent("00-0123456789abcdef0123456789abcdef-0123456789abcdef-01");
    const root =
      incoming === null
        ? createTraceContext(undefined, deterministicSource)
        : createTraceContext(
            { traceId: incoming.traceId, spanId: incoming.spanId },
            deterministicSource,
          );

    traces.run(root, () => {
      const current = traces.current();
      expect(current?.traceId).toBe("0123456789abcdef0123456789abcdef");
      const requestLogger = logger.child({ traceId: current?.traceId });
      const span = childTraceContext(current ?? root, deterministicSource);
      requestLogger.log("info", "scene.commit.started", {
        sceneId: "22222222-2222-4222-8222-222222222222",
      });
      requestLogger.log("info", "scene.commit.ok", { spanId: span.spanId });
      metrics.counter("bellis_scene_commit_total", { result: "committed" }).inc();
      metrics.histogram("bellis_scene_commit_duration_ms").observe(6.2);
    });

    // 业务路径结束后不再有 Trace 上下文。
    expect(traces.current()).toBeNull();
    logger.log("info", "request.completed");

    const events = lines.map((line) => (JSON.parse(line) as Record<string, unknown>).event);
    expect(events).toEqual(["scene.commit.started", "scene.commit.ok", "request.completed"]);
    const snapshot = metrics.snapshot();
    expect(snapshot.counters).toEqual([
      { name: "bellis_scene_commit_total", labels: { result: "committed" }, value: 1 },
    ]);
    expect(snapshot.histograms[0]?.count).toBe(1);
    expect(lines.join("\n")).not.toContain("undefined");
  });

  it("demonstrates P2 dispatcher usage: bounded labels and snapshot export", () => {
    const metrics = createInMemoryMetrics({ maxSeriesPerMetric: 4 });
    metrics.gauge("bellis_outbox_pending", { topic: "scene.committed" }).set(3);
    metrics.counter("bellis_outbox_delivery_total", { result: "delivered" }).inc(3);
    metrics.gauge("bellis_db_worker_queue_depth").set(0);
    const exported = JSON.stringify(metrics.snapshot());
    expect(exported).toContain("bellis_outbox_pending");
    expect(exported).toContain("bellis_outbox_delivery_total");
    expect(exported).toContain("bellis_db_worker_queue_depth");
  });
});
