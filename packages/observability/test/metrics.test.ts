import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  BLOCKED_METRIC_LABEL_NAMES,
  PHASE_1_METRIC_DEFINITIONS,
  createInMemoryMetrics,
} from "../src/index.js";
import type { MetricsRejection } from "../src/index.js";

const PHASE_1_METRIC_NAMES = [
  "bellis_ws_connections",
  "bellis_ws_queue_messages",
  "bellis_ws_queue_bytes",
  "bellis_ws_dropped_messages_total",
  "bellis_clock_rtt_us",
  "bellis_clock_offset_us",
  "bellis_db_operation_duration_ms",
  "bellis_db_worker_queue_depth",
  "bellis_outbox_pending",
  "bellis_outbox_delivery_total",
  "bellis_scene_commit_total",
  "bellis_scene_commit_duration_ms",
];

describe("phase 1 metric definitions", () => {
  it("covers exactly the twelve required metrics", () => {
    expect(PHASE_1_METRIC_DEFINITIONS.map((d) => d.name).toSorted()).toEqual(
      [...PHASE_1_METRIC_NAMES].toSorted(),
    );
  });

  it("declares histograms with ascending buckets and no blocked labels anywhere", () => {
    const blocked = new Set(BLOCKED_METRIC_LABEL_NAMES);
    for (const definition of PHASE_1_METRIC_DEFINITIONS) {
      for (const label of definition.labels) {
        expect(blocked.has(label)).toBe(false);
      }
      if (definition.kind === "histogram") {
        const buckets = definition.buckets ?? [];
        expect(buckets.length).toBeGreaterThan(0);
        for (let i = 1; i < buckets.length; i += 1) {
          expect(buckets[i] ?? 0).toBeGreaterThan(buckets[i - 1] ?? Number.NaN);
        }
      }
    }
  });
});

describe("InMemoryMetrics semantics", () => {
  it("counters only accumulate, gauges move both ways, histograms aggregate", () => {
    const metrics = createInMemoryMetrics();
    const commit = metrics.counter("bellis_scene_commit_total", { result: "committed" });
    commit.inc();
    commit.inc(2.5);
    metrics.counter("bellis_scene_commit_total", { result: "committed" }).inc();
    metrics.gauge("bellis_ws_connections", { channel: "control" }).set(3);
    metrics.gauge("bellis_ws_connections", { channel: "control" }).set(2);
    metrics.gauge("bellis_clock_offset_us").set(-120);
    const duration = metrics.histogram("bellis_scene_commit_duration_ms");
    duration.observe(1);
    duration.observe(2);
    duration.observe(600);

    const snapshot = metrics.snapshot();
    expect(snapshot.counters).toEqual([
      { name: "bellis_scene_commit_total", labels: { result: "committed" }, value: 4.5 },
    ]);
    expect(snapshot.gauges).toContainEqual({
      name: "bellis_ws_connections",
      labels: { channel: "control" },
      value: 2,
    });
    expect(snapshot.gauges).toContainEqual({
      name: "bellis_clock_offset_us",
      labels: {},
      value: -120,
    });
    const histogram = snapshot.histograms.find((h) => h.name === "bellis_scene_commit_duration_ms");
    expect(histogram?.count).toBe(3);
    expect(histogram?.sum).toBe(603);
    expect(histogram?.min).toBe(1);
    expect(histogram?.max).toBe(600);
    // 边界含入：1 落入 ≤1 桶，2 落入 ≤2.5 桶，600 超出最后边界（隐式 +Inf）。
    const buckets = new Map((histogram?.buckets ?? []).map((b) => [b.upperBound, b.count]));
    expect(buckets.get(1)).toBe(1);
    expect(buckets.get(2.5)).toBe(1);
    expect([...buckets.values()].reduce((a, b) => a + b, 0)).toBe(2);
    expect(snapshot.rejectedOperations).toBe(0);
  });

  it("label order does not create duplicate series (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 100 }),
        (firstInc, secondInc) => {
          const metrics = createInMemoryMetrics();
          metrics
            .counter("bellis_ws_dropped_messages_total", { channel: "control", reason: "overflow" })
            .inc(firstInc);
          metrics
            .counter("bellis_ws_dropped_messages_total", { reason: "overflow", channel: "control" })
            .inc(secondInc);
          const snapshot = metrics.snapshot();
          expect(snapshot.counters).toHaveLength(1);
          expect(snapshot.counters[0]?.value).toBe(firstInc + secondInc);
          expect(snapshot.seriesCount).toBe(1);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("rejects unknown metrics, kind mismatches and disallowed labels without throwing", () => {
    const rejections: MetricsRejection[] = [];
    const metrics = createInMemoryMetrics({ onError: (r) => rejections.push(r) });
    metrics.counter("bellis_nope_total").inc(5);
    metrics.counter("bellis_ws_connections").inc();
    metrics.gauge("bellis_scene_commit_total").set(1);
    metrics
      .counter("bellis_ws_dropped_messages_total", { channel: "control", traceId: "0123" })
      .inc();
    metrics.counter("bellis_ws_dropped_messages_total", { channel: "" }).inc();
    const snapshot = metrics.snapshot();
    expect(snapshot.rejectedOperations).toBe(5);
    expect(rejections.map((r) => r.reason)).toEqual([
      "unknown-metric",
      "kind-mismatch",
      "kind-mismatch",
      "label-not-allowed",
      "invalid-label-value",
    ]);
    expect(snapshot.counters).toHaveLength(0);
  });

  it("rejects negative counter increments and non-finite values", () => {
    const rejections: MetricsRejection[] = [];
    const metrics = createInMemoryMetrics({ onError: (r) => rejections.push(r) });
    const commit = metrics.counter("bellis_scene_commit_total", { result: "error" });
    commit.inc(-1);
    commit.inc(Number.POSITIVE_INFINITY);
    commit.inc(Number.NaN);
    metrics.gauge("bellis_outbox_pending", { topic: "scene.committed" }).set(Number.NaN);
    metrics.histogram("bellis_clock_rtt_us").observe(Number.NEGATIVE_INFINITY);
    commit.inc(3);
    expect(metrics.snapshot().rejectedOperations).toBe(5);
    expect(metrics.snapshot().counters[0]?.value).toBe(3);
    expect(rejections.every((r) => r.reason === "invalid-value")).toBe(true);
  });

  it("enforces series limits per metric and globally with one-time alarms", () => {
    const rejections: MetricsRejection[] = [];
    const metrics = createInMemoryMetrics({
      maxSeriesPerMetric: 2,
      maxTotalSeries: 3,
      onError: (r) => rejections.push(r),
    });
    metrics
      .counter("bellis_ws_dropped_messages_total", { channel: "control", reason: "overflow" })
      .inc();
    metrics
      .counter("bellis_ws_dropped_messages_total", { channel: "control", reason: "closed" })
      .inc();
    // 单指标上限 2：第三个 Series 被拒，但既有 Series 仍可更新。
    metrics
      .counter("bellis_ws_dropped_messages_total", { channel: "control", reason: "invalid" })
      .inc(7);
    metrics
      .counter("bellis_ws_dropped_messages_total", { channel: "control", reason: "overflow" })
      .inc();
    // 全局上限 3：其他指标仍可补足到 3，此后任何新 Series 都被拒。
    metrics.counter("bellis_scene_commit_total", { result: "committed" }).inc();
    metrics.counter("bellis_scene_commit_total", { result: "duplicate" }).inc(9);
    metrics.gauge("bellis_outbox_pending", { topic: "scene.committed" }).set(1);
    const snapshot = metrics.snapshot();
    expect(snapshot.seriesCount).toBe(3);
    const overflowSeries = snapshot.counters.find((c) => c.labels.reason === "overflow");
    expect(overflowSeries?.value).toBe(2);
    expect(snapshot.counters.find((c) => c.labels.result === "duplicate")).toBeUndefined();
    expect(snapshot.gauges).toHaveLength(0);
    expect(snapshot.rejectedOperations).toBe(3);
    const limitAlarms = rejections.filter((r) => r.reason === "series-limit");
    expect(limitAlarms).toHaveLength(3);
    expect(limitAlarms.map((a) => a.metric)).toEqual([
      "bellis_ws_dropped_messages_total",
      "bellis_scene_commit_total",
      "bellis_outbox_pending",
    ]);
  });

  it("snapshot is a deeply frozen immutable copy", () => {
    const metrics = createInMemoryMetrics();
    metrics.counter("bellis_scene_commit_total", { result: "committed" }).inc(2);
    const snapshot = metrics.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.counters)).toBe(true);
    expect(Object.isFrozen(snapshot.counters[0])).toBe(true);
    expect(Object.isFrozen(snapshot.counters[0]?.labels)).toBe(true);
    expect(() => {
      (snapshot.counters[0] as { value: number }).value = 999;
    }).toThrow();
    // 快照可 JSON 序列化（本地导出/健康端点使用）。
    expect(() => JSON.stringify(snapshot)).not.toThrow();
    // 快照修改不影响 Registry 内部状态。
    metrics.counter("bellis_scene_commit_total", { result: "committed" }).inc(1);
    expect(metrics.snapshot().counters[0]?.value).toBe(3);
  });

  it("reset clears series and rejection state", () => {
    const metrics = createInMemoryMetrics();
    metrics.counter("bellis_scene_commit_total").inc();
    metrics.counter("bellis_unknown").inc();
    expect(metrics.snapshot().rejectedOperations).toBe(1);
    metrics.reset();
    const snapshot = metrics.snapshot();
    expect(snapshot.counters).toHaveLength(0);
    expect(snapshot.histograms).toHaveLength(0);
    expect(snapshot.rejectedOperations).toBe(0);
    expect(snapshot.seriesCount).toBe(0);
  });

  it("survives an onError callback that throws", () => {
    const metrics = createInMemoryMetrics({
      onError: () => {
        throw new Error("alarm channel broken");
      },
    });
    expect(() => metrics.counter("bellis_nope").inc()).not.toThrow();
    expect(metrics.snapshot().rejectedOperations).toBe(1);
  });

  it("rejects invalid options at assembly time", () => {
    expect(() => createInMemoryMetrics({ maxSeriesPerMetric: 0 })).toThrow(RangeError);
    expect(() => createInMemoryMetrics({ maxTotalSeries: 1.5 })).toThrow(RangeError);
  });
});
