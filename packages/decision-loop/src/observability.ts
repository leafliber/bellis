/**
 * decision-loop 的最小可观测接口（结构兼容 @bellis/observability 的
 * LoggerPort/MetricsPort——本包不依赖该包，依赖方向遵守
 * phase-3-development-guide.md §4：contracts ← decision-loop）。
 */
export interface LoopLogger {
  log(level: "trace" | "debug" | "info" | "warn" | "error", event: string, fields?: unknown): void;
}

export interface LoopMetrics {
  counter(name: string, labels?: Readonly<Record<string, string>>): { inc(value?: number): void };
  histogram(
    name: string,
    labels?: Readonly<Record<string, string>>,
  ): { observe(value: number): void };
}
