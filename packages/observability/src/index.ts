/**
 * @bellis/observability — Trace、日志与指标。
 * Gate 1 交付最小 Port 与 No-op 实现；P3 在保持 Port 兼容的前提下补充
 * W3C Trace 上下文、Pino Logger、字段级 Redaction 与内存 Metrics。
 */
export { createNoopLogger } from "./logger.js";
export type { LogFields, LogLevel, LoggerPort } from "./logger.js";
export { createPinoLogger } from "./logger/pino-logger.js";
export type { LoggerDestination, LoggerOptions } from "./logger/pino-logger.js";
export {
  SENSITIVE_LOG_FIELD_NAMES,
  canonicalFieldName,
  isSensitiveFieldName,
  redactValue,
  serializeErrorForLog,
} from "./logger/redaction.js";
export { createNoopMetrics } from "./metrics.js";
export type {
  CounterMetric,
  GaugeMetric,
  HistogramMetric,
  MetricLabels,
  MetricsPort,
} from "./metrics.js";
export {
  BLOCKED_METRIC_LABEL_NAMES,
  METRIC_NAME_PATTERN,
  PHASE_1_METRIC_DEFINITIONS,
} from "./metrics/definitions.js";
export type { MetricDefinition, MetricKind } from "./metrics/definitions.js";
export { createInMemoryMetrics } from "./metrics/in-memory-registry.js";
export type {
  CounterSeriesSnapshot,
  GaugeSeriesSnapshot,
  HistogramBucketSnapshot,
  HistogramSeriesSnapshot,
  InMemoryMetrics,
  MetricSnapshot,
  MetricsOptions,
  MetricsRejection,
} from "./metrics/in-memory-registry.js";
export {
  childTraceContext,
  createCryptoTraceRandomSource,
  createTraceContext,
} from "./trace/trace-context.js";
export type { TraceRandomSource } from "./trace/trace-context.js";
export { createTraceContextManager } from "./trace/context-manager.js";
export type { TraceContextManager } from "./trace/context-manager.js";
export { formatTraceparent, parseTraceparent } from "./trace/traceparent.js";
export type { ParsedTraceparent } from "./trace/traceparent.js";
