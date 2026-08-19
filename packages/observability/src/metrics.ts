/**
 * 最小 Metrics Port（Gate 1 空壳，phase-1-build-guide.md §6.3、§10.3）。
 * Phase 1 指标名单见 §10.3（bellis_ws_* / bellis_clock_* / bellis_db_* /
 * bellis_outbox_* / bellis_scene_*）；本阶段只要求本地内存聚合与可选
 * OTLP Exporter 接口，由 P3 交付。高基数字段必须受到限制。
 */
export type MetricLabels = Readonly<Record<string, string>>;

export interface CounterMetric {
  inc(value?: number): void;
}

export interface GaugeMetric {
  set(value: number): void;
}

export interface HistogramMetric {
  observe(value: number): void;
}

export interface MetricsPort {
  counter(name: string, labels?: MetricLabels): CounterMetric;
  gauge(name: string, labels?: MetricLabels): GaugeMetric;
  histogram(name: string, labels?: MetricLabels): HistogramMetric;
}

/** No-op 实现：生产装配的默认占位。 */
export function createNoopMetrics(): MetricsPort {
  const counter: CounterMetric = { inc: () => {} };
  const gauge: GaugeMetric = { set: () => {} };
  const histogram: HistogramMetric = { observe: () => {} };
  return {
    counter: () => counter,
    gauge: () => gauge,
    histogram: () => histogram,
  };
}
