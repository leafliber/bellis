import type { MetricsPort } from "@bellis/observability";

/**
 * WS 连接计数与规范指标（bellis_ws_connections{channel}）。
 * Gauge 是共享序列：由这里集中维护计数，适配器只 acquire/release。
 */
export type WsChannel = "control" | "media";

export class ConnectionMetrics {
  readonly #metrics: MetricsPort;
  readonly #counts: Record<WsChannel, number> = { control: 0, media: 0 };

  constructor(metrics: MetricsPort) {
    this.#metrics = metrics;
  }

  acquire(channel: WsChannel): void {
    this.#counts[channel] += 1;
    this.#metrics.gauge("bellis_ws_connections", { channel }).set(this.#counts[channel]);
  }

  release(channel: WsChannel): void {
    this.#counts[channel] = Math.max(0, this.#counts[channel] - 1);
    this.#metrics.gauge("bellis_ws_connections", { channel }).set(this.#counts[channel]);
  }
}
