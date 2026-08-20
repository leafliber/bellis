import { describe, expect, it } from "vitest";
import { createNoopLogger } from "../src/logger.js";
import { createNoopMetrics } from "../src/metrics.js";

describe("noop logger", () => {
  it("accepts log calls without throwing", () => {
    const logger = createNoopLogger();
    logger.log("info", "runtime.started", { port: 17890 });
    logger.log("error", "db.failed", { code: "SQLITE_BUSY" });
    expect(logger.child({ sessionId: "s1" })).toBeDefined();
  });
});

describe("noop metrics", () => {
  it("accepts metric updates without throwing", () => {
    const metrics = createNoopMetrics();
    metrics.counter("bellis_scene_commit_total").inc();
    metrics.counter("bellis_scene_commit_total", { result: "ok" }).inc(2);
    metrics.gauge("bellis_ws_queue_messages").set(12);
    metrics.histogram("bellis_clock_rtt_us").observe(1500);
    expect(metrics).toBeDefined();
  });
});
