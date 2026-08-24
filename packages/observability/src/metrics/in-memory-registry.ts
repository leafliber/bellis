import type {
  CounterMetric,
  GaugeMetric,
  HistogramMetric,
  MetricLabels,
  MetricsPort,
} from "../metrics.js";
import {
  BLOCKED_METRIC_LABEL_NAMES,
  METRIC_NAME_PATTERN,
  PHASE_1_METRIC_DEFINITIONS,
} from "./definitions.js";
import type { MetricDefinition, MetricKind } from "./definitions.js";

/**
 * 内存 Metrics Registry（docs/phase-1-reference.md）。
 *
 * - 只接受 PHASE_1_METRIC_DEFINITIONS 中声明的指标：未知指标名、类型不匹配、
 *   未允许 Label、非法 Label 值、非有限数值与负 Counter 增量都被稳定拒绝
 *   （丢弃本次操作、计数并回调 onError），绝不抛错阻塞业务路径。
 *   敌意 Label 对象（抛错 Getter、Proxy 陷阱）同样被拒绝而不是抛出。
 * - Series 总量受 maxSeriesPerMetric / maxTotalSeries 上限约束，超限拒绝
 *   该新 Series 的创建并记录一次性告警；既有 Series 的更新不受影响。
 * - snapshot() 返回深冻结的不可变副本，不暴露内部 Map。
 */

export interface MetricsRejection {
  readonly reason:
    | "unknown-metric"
    | "kind-mismatch"
    | "label-not-allowed"
    | "invalid-label-value"
    | "invalid-value"
    | "series-limit";
  readonly metric: string;
  readonly message: string;
}

export interface MetricsOptions {
  /** 单个指标允许的最大 Series 数；默认 128。 */
  readonly maxSeriesPerMetric?: number;
  /** 全 Registry 允许的最大 Series 总数；默认 1024。 */
  readonly maxTotalSeries?: number;
  /** 拒绝回调（测试与告警装配用）；回调抛错不会传播到业务路径。 */
  readonly onError?: (rejection: MetricsRejection) => void;
}

export interface CounterSeriesSnapshot {
  readonly name: string;
  readonly labels: Readonly<MetricLabels>;
  readonly value: number;
}

export interface GaugeSeriesSnapshot {
  readonly name: string;
  readonly labels: Readonly<MetricLabels>;
  readonly value: number;
}

export interface HistogramBucketSnapshot {
  readonly upperBound: number;
  readonly count: number;
}

export interface HistogramSeriesSnapshot {
  readonly name: string;
  readonly labels: Readonly<MetricLabels>;
  readonly count: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
  readonly buckets: readonly HistogramBucketSnapshot[];
}

/** 稳定、只读、可 JSON 序列化的本地快照。 */
export interface MetricSnapshot {
  readonly counters: readonly CounterSeriesSnapshot[];
  readonly gauges: readonly GaugeSeriesSnapshot[];
  readonly histograms: readonly HistogramSeriesSnapshot[];
  readonly rejectedOperations: number;
  readonly seriesCount: number;
}

export interface InMemoryMetrics extends MetricsPort {
  snapshot(): MetricSnapshot;
  reset(): void;
}

interface CounterSeries {
  labels: MetricLabels;
  value: number;
}

interface GaugeSeries {
  labels: MetricLabels;
  value: number;
}

interface HistogramSeries {
  labels: MetricLabels;
  count: number;
  sum: number;
  min: number;
  max: number;
  bucketCounts: number[];
}

interface MetricState {
  definition: MetricDefinition;
  /** 创建时快照的 Label Allowlist：不受外部对定义数组的运行期改写影响。 */
  allowlist: ReadonlySet<string>;
  /** 创建时快照的 Histogram 桶边界。 */
  buckets: readonly number[];
  counters: Map<string, CounterSeries>;
  gauges: Map<string, GaugeSeries>;
  histograms: Map<string, HistogramSeries>;
}

const DEFAULT_MAX_SERIES_PER_METRIC = 128;
const DEFAULT_MAX_TOTAL_SERIES = 1024;
const MAX_LABEL_VALUE_LENGTH = 256;

const noopCounter: CounterMetric = { inc: () => {} };
const noopGauge: GaugeMetric = { set: () => {} };
const noopHistogram: HistogramMetric = { observe: () => {} };

/** 稳定键：按 Label 名排序后 JSON 序列化，Label 顺序不影响 Series 归属。 */
function seriesKey(labels: MetricLabels): string {
  const sortedEntries = Object.entries(labels).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(sortedEntries);
}

export function createInMemoryMetrics(options?: MetricsOptions): InMemoryMetrics {
  const maxSeriesPerMetric = options?.maxSeriesPerMetric ?? DEFAULT_MAX_SERIES_PER_METRIC;
  const maxTotalSeries = options?.maxTotalSeries ?? DEFAULT_MAX_TOTAL_SERIES;
  if (!Number.isInteger(maxSeriesPerMetric) || maxSeriesPerMetric < 1) {
    throw new RangeError("maxSeriesPerMetric must be a positive integer");
  }
  if (!Number.isInteger(maxTotalSeries) || maxTotalSeries < 1) {
    throw new RangeError("maxTotalSeries must be a positive integer");
  }

  const states = new Map<string, MetricState>();
  const blockedLabels = new Set(BLOCKED_METRIC_LABEL_NAMES);
  for (const definition of PHASE_1_METRIC_DEFINITIONS) {
    if (!METRIC_NAME_PATTERN.test(definition.name)) {
      throw new RangeError(`invalid metric name in definitions: ${definition.name}`);
    }
    if (states.has(definition.name)) {
      throw new RangeError(`duplicate metric definition: ${definition.name}`);
    }
    for (const label of definition.labels) {
      if (blockedLabels.has(label)) {
        throw new RangeError(
          `metric ${definition.name} declares blocked high-cardinality label: ${label}`,
        );
      }
    }
    if (definition.kind === "histogram") {
      const buckets = definition.buckets ?? [];
      let ascending = buckets.length > 0;
      for (let i = 0; i < buckets.length; i += 1) {
        const bound = buckets[i];
        const previous = i > 0 ? buckets[i - 1] : undefined;
        if (
          bound === undefined ||
          !Number.isFinite(bound) ||
          bound < 0 ||
          (previous !== undefined && bound <= previous)
        ) {
          ascending = false;
          break;
        }
      }
      if (!ascending) {
        throw new RangeError(`histogram ${definition.name} requires ascending finite buckets`);
      }
    }
    states.set(definition.name, {
      definition,
      allowlist: new Set(definition.labels),
      buckets: [...(definition.buckets ?? [])],
      counters: new Map(),
      gauges: new Map(),
      histograms: new Map(),
    });
  }

  let rejectedOperations = 0;
  const alarmedSeriesLimit = new Set<string>();

  function reject(rejection: MetricsRejection): void {
    rejectedOperations += 1;
    try {
      options?.onError?.(rejection);
    } catch {
      // 回调失败不影响业务路径。
    }
  }

  function seriesLimitAlarm(metric: string, message: string): void {
    // 每次拒绝都计入 rejectedOperations；onError 告警每指标只发一次。
    rejectedOperations += 1;
    if (alarmedSeriesLimit.has(metric)) {
      return;
    }
    alarmedSeriesLimit.add(metric);
    try {
      options?.onError?.({ reason: "series-limit", metric, message });
    } catch {
      // 回调失败不影响业务路径。
    }
  }

  function totalSeriesCount(): number {
    let total = 0;
    for (const state of states.values()) {
      total += state.counters.size + state.gauges.size + state.histograms.size;
    }
    return total;
  }

  function resolveSeries(
    name: string,
    kind: MetricKind,
    labels: MetricLabels | undefined,
  ): { seriesKey: string; normalizedLabels: MetricLabels } | null {
    const state = states.get(name);
    if (state === undefined) {
      reject({ reason: "unknown-metric", metric: name, message: `unknown metric: ${name}` });
      return null;
    }
    if (state.definition.kind !== kind) {
      reject({
        reason: "kind-mismatch",
        metric: name,
        message: `metric ${name} is a ${state.definition.kind}, not a ${kind}`,
      });
      return null;
    }
    const normalized: Record<string, string> = {};
    // Object.entries 会读取每个自有属性：抛错 Getter / Proxy get·ownKeys 陷阱
    // 在这里被拦截为一次拒绝，绝不向业务路径传播（评审 2-P1）。
    let entries: [string, unknown][];
    try {
      entries = Object.entries(labels ?? {});
    } catch {
      reject({
        reason: "invalid-label-value",
        metric: name,
        message: `labels object could not be read for metric ${name}`,
      });
      return null;
    }
    for (const [key, value] of entries) {
      if (!state.allowlist.has(key)) {
        reject({
          reason: "label-not-allowed",
          metric: name,
          message: `label ${key} is not allowed for metric ${name}`,
        });
        return null;
      }
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > MAX_LABEL_VALUE_LENGTH
      ) {
        reject({
          reason: "invalid-label-value",
          metric: name,
          message: `label ${key} must be a string of 1..${MAX_LABEL_VALUE_LENGTH} characters`,
        });
        return null;
      }
      normalized[key] = value;
    }
    return { seriesKey: seriesKey(normalized), normalizedLabels: normalized };
  }

  function seriesMap<K>(state: MetricState, key: string, create: () => K): K | null {
    const map =
      state.definition.kind === "counter"
        ? state.counters
        : state.definition.kind === "gauge"
          ? state.gauges
          : state.histograms;
    const existing = (map as Map<string, K>).get(key);
    if (existing !== undefined) {
      return existing;
    }
    if (map.size >= maxSeriesPerMetric || totalSeriesCount() >= maxTotalSeries) {
      seriesLimitAlarm(
        state.definition.name,
        `series limit reached for metric ${state.definition.name}; new series rejected`,
      );
      return null;
    }
    const created = create();
    (map as Map<string, K>).set(key, created);
    return created;
  }

  const registry: InMemoryMetrics = {
    counter(name: string, labels?: MetricLabels): CounterMetric {
      try {
        const resolved = resolveSeries(name, "counter", labels);
        if (resolved === null) {
          return noopCounter;
        }
        const state = states.get(name) as MetricState;
        const key = resolved.seriesKey;
        return {
          inc: (value = 1) => {
            try {
              if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
                reject({
                  reason: "invalid-value",
                  metric: name,
                  message: `counter increment must be a finite non-negative number, got ${String(value)}`,
                });
                return;
              }
              const series = seriesMap<CounterSeries>(state, key, () => ({
                labels: resolved.normalizedLabels,
                value: 0,
              }));
              if (series !== null) {
                // 两个有限数相加仍可能溢出为 Infinity；聚合结果必须保持有限，
                // 否则快照经 JSON 序列化会变成 null（评审 P2-5）。
                const next = series.value + value;
                if (!Number.isFinite(next)) {
                  reject({
                    reason: "invalid-value",
                    metric: name,
                    message: `counter aggregate overflow: ${series.value} + ${value}`,
                  });
                  return;
                }
                series.value = next;
              }
            } catch {
              rejectedOperations += 1;
            }
          },
        };
      } catch {
        // 最终兜底：工厂方法对任何敌意输入都返回 No-op，不阻塞业务路径。
        rejectedOperations += 1;
        return noopCounter;
      }
    },
    gauge(name: string, labels?: MetricLabels): GaugeMetric {
      try {
        const resolved = resolveSeries(name, "gauge", labels);
        if (resolved === null) {
          return noopGauge;
        }
        const state = states.get(name) as MetricState;
        const key = resolved.seriesKey;
        return {
          set: (value) => {
            try {
              if (typeof value !== "number" || !Number.isFinite(value)) {
                reject({
                  reason: "invalid-value",
                  metric: name,
                  message: `gauge value must be a finite number, got ${String(value)}`,
                });
                return;
              }
              const series = seriesMap<GaugeSeries>(state, key, () => ({
                labels: resolved.normalizedLabels,
                value: 0,
              }));
              if (series !== null) {
                series.value = value;
              }
            } catch {
              rejectedOperations += 1;
            }
          },
        };
      } catch {
        rejectedOperations += 1;
        return noopGauge;
      }
    },
    histogram(name: string, labels?: MetricLabels): HistogramMetric {
      try {
        const resolved = resolveSeries(name, "histogram", labels);
        if (resolved === null) {
          return noopHistogram;
        }
        const state = states.get(name) as MetricState;
        const key = resolved.seriesKey;
        return {
          observe: (value) => {
            try {
              if (typeof value !== "number" || !Number.isFinite(value)) {
                reject({
                  reason: "invalid-value",
                  metric: name,
                  message: `histogram observation must be a finite number, got ${String(value)}`,
                });
                return;
              }
              const series = seriesMap<HistogramSeries>(state, key, () => ({
                labels: resolved.normalizedLabels,
                count: 0,
                sum: 0,
                min: Number.POSITIVE_INFINITY,
                max: Number.NEGATIVE_INFINITY,
                bucketCounts: Array.from<number, number>({ length: state.buckets.length }, () => 0),
              }));
              if (series === null) {
                return;
              }
              // 与 Counter 相同：sum 聚合必须保持有限，溢出则拒绝本次观测。
              const nextSum = series.sum + value;
              if (!Number.isFinite(nextSum)) {
                reject({
                  reason: "invalid-value",
                  metric: name,
                  message: `histogram sum overflow: ${series.sum} + ${value}`,
                });
                return;
              }
              series.count += 1;
              series.sum = nextSum;
              series.min = Math.min(series.min, value);
              series.max = Math.max(series.max, value);
              for (let i = 0; i < state.buckets.length; i += 1) {
                const bound = state.buckets[i];
                if (bound !== undefined && value <= bound) {
                  series.bucketCounts[i] = (series.bucketCounts[i] ?? 0) + 1;
                  break;
                }
              }
            } catch {
              rejectedOperations += 1;
            }
          },
        };
      } catch {
        rejectedOperations += 1;
        return noopHistogram;
      }
    },
    snapshot(): MetricSnapshot {
      const counters: CounterSeriesSnapshot[] = [];
      const gauges: GaugeSeriesSnapshot[] = [];
      const histograms: HistogramSeriesSnapshot[] = [];
      for (const state of states.values()) {
        for (const series of state.counters.values()) {
          counters.push({
            name: state.definition.name,
            labels: series.labels,
            value: series.value,
          });
        }
        for (const series of state.gauges.values()) {
          gauges.push({ name: state.definition.name, labels: series.labels, value: series.value });
        }
        for (const series of state.histograms.values()) {
          const buckets = state.buckets.map((upperBound, i) => ({
            upperBound,
            count: series.bucketCounts[i] ?? 0,
          }));
          histograms.push({
            name: state.definition.name,
            labels: series.labels,
            count: series.count,
            sum: series.sum,
            min: series.count === 0 ? 0 : series.min,
            max: series.count === 0 ? 0 : series.max,
            buckets,
          });
        }
      }
      const snapshot = {
        counters,
        gauges,
        histograms,
        rejectedOperations,
        seriesCount: totalSeriesCount(),
      };
      return deepFreeze(snapshot);
    },
    reset(): void {
      for (const state of states.values()) {
        state.counters.clear();
        state.gauges.clear();
        state.histograms.clear();
      }
      rejectedOperations = 0;
      alarmedSeriesLimit.clear();
    },
  };
  return registry;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
