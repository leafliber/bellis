import type { MonotonicClock } from "@bellis/contracts";
import type { ClockEstimate } from "@bellis/transport/browser";

/**
 * Stage Cue Timeline（docs/archive/phase-2/development-guide.md §7.2）。
 *
 * - Runtime Commit 时间经当前连接的 Offset Estimate 映射为 Stage 本地时刻：
 *   `localUs = runtimeUs - runtimeOffsetUs`（offset 为 Runtime 相对本地的偏移）。
 * - 各 Lane 以同一目标时刻调度，不各自读取 Date.now()。
 * - 主线程长任务后超过容忍窗口的非关键 Cue 不补播（直接丢弃并计数）；
 *   关键 Cue 迟到立即触发并标记 late（由 Lane 决定是否安全执行）。
 * - 所有调度项可整组取消；close() 拒绝一切新调度并取消全部在途项。
 */

export interface TimelineScheduleItem {
  readonly lane: string;
  /** 关键（hard）Lane：迟到仍触发并标记 late；非关键：超容忍窗口丢弃。 */
  readonly critical: boolean;
  readonly onDropped?: () => void;
  readonly fire: (info: { late: boolean; lateByUs: bigint }) => void;
}

export interface ScheduledScene {
  readonly sceneId: string;
  readonly targetLocalUs: bigint;
  cancel(): void;
}

export interface CueTimelineOptions {
  /** 迟到容忍窗口（微秒，默认 50ms）。 */
  readonly lateToleranceUs?: bigint;
  /** 单 Scene 最大在途调度项（有界）。 */
  readonly maxItemsPerScene?: number;
}

interface InflightItem {
  readonly sceneId: string;
  readonly timer: AbortController;
  cancelled: boolean;
}

export class CueTimeline {
  readonly #clock: MonotonicClock;
  readonly #lateToleranceUs: bigint;
  readonly #maxItemsPerScene: number;
  readonly #inflight = new Map<string, InflightItem[]>();
  #closed = false;
  #droppedTotal = 0;

  constructor(clock: MonotonicClock, options: CueTimelineOptions = {}) {
    this.#clock = clock;
    this.#lateToleranceUs = options.lateToleranceUs ?? 50_000n;
    this.#maxItemsPerScene = options.maxItemsPerScene ?? 64;
  }

  get droppedLateCues(): number {
    return this.#droppedTotal;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Runtime 时刻 → Stage 本地时刻（无估计时返回 null：尚未 clock_ready）。 */
  mapRuntimeToLocal(runtimeUs: bigint, estimate: ClockEstimate): bigint {
    return runtimeUs - estimate.runtimeOffsetUs;
  }

  /** 在目标本地时刻触发一组 Lane；返回可整组取消的句柄。 */
  schedule(
    sceneId: string,
    targetLocalUs: bigint,
    items: readonly TimelineScheduleItem[],
  ): ScheduledScene {
    if (this.#closed) {
      throw new Error("cue_timeline_closed");
    }
    const existing = this.#inflight.get(sceneId) ?? [];
    if (existing.length + items.length > this.#maxItemsPerScene) {
      throw new Error(`cue_timeline_item_limit_reached for scene ${sceneId}`);
    }
    for (const item of items) {
      const timer = new AbortController();
      const record: InflightItem = { sceneId, timer, cancelled: false };
      existing.push(record);
      this.#inflight.set(sceneId, existing);
      void this.#clock
        .sleepUntil(targetLocalUs, timer.signal)
        .then(
          () => {
            if (record.cancelled || this.#closed) {
              return;
            }
            this.#remove(record);
            const lateBy = this.#clock.nowUs() - targetLocalUs;
            if (lateBy > this.#lateToleranceUs) {
              if (!item.critical) {
                this.#droppedTotal += 1;
                item.onDropped?.();
                return;
              }
              item.fire({ late: true, lateByUs: lateBy });
              return;
            }
            item.fire({ late: false, lateByUs: lateBy });
          },
          () => {
            this.#remove(record);
          },
        )
        .catch(() => {});
    }
    return {
      sceneId,
      targetLocalUs,
      cancel: () => {
        this.cancelScene(sceneId);
      },
    };
  }

  /** 取消一个 Scene 的全部在途调度（取消语义，不是触发）。 */
  cancelScene(sceneId: string): void {
    const items = this.#inflight.get(sceneId);
    if (items === undefined) {
      return;
    }
    this.#inflight.delete(sceneId);
    for (const item of items) {
      item.cancelled = true;
      item.timer.abort(new Error("cancelled"));
    }
  }

  /** 关闭：取消全部在途项并拒绝新调度。 */
  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const [sceneId, items] of this.#inflight) {
      this.#inflight.delete(sceneId);
      for (const item of items) {
        item.cancelled = true;
        item.timer.abort(new Error("timeline_closed"));
      }
    }
  }

  #remove(record: InflightItem): void {
    const items = this.#inflight.get(record.sceneId);
    if (items === undefined) {
      return;
    }
    const index = items.indexOf(record);
    if (index !== -1) {
      items.splice(index, 1);
    }
    if (items.length === 0) {
      this.#inflight.delete(record.sceneId);
    }
  }
}
