import type { CueLane, SyncGroup } from "@bellis/contracts";
import type { StageLaneReady } from "./ports.js";

/** Pure check of Stage preparation results. Hard failures reject the scene;
 * soft absence is recorded. Stage owns all waits, timeouts and cancellation.
 */

export type BarrierVerdict =
  | {
      readonly verdict: "ready";
      /** soft/detached 组缺席（未报告或 unavailable）的 Lane，结果必须记录。 */
      readonly absentLanes: readonly CueLane[];
      readonly unavailable: readonly StageLaneReady[];
    }
  | {
      readonly verdict: "hard_unavailable";
      readonly lanes: readonly StageLaneReady[];
      readonly missingHardLanes: readonly CueLane[];
    };

export interface PrepareBarrierOptions {
  readonly groups: readonly SyncGroup[];
  /** @deprecated 仅保留源码兼容；soft 准备计时由 Stage 拥有。 */
  readonly softTimeoutUs?: bigint;
}

export class PrepareBarrier {
  readonly #reported = new Map<CueLane, StageLaneReady>();
  readonly #hardLanes = new Set<CueLane>();
  readonly #waitableLanes = new Set<CueLane>();

  constructor(options: PrepareBarrierOptions) {
    for (const group of options.groups) {
      for (const lane of group.lanes) {
        if (group.level === "hard") {
          this.#hardLanes.add(lane);
          this.#waitableLanes.add(lane);
        } else if (group.level === "soft") {
          this.#waitableLanes.add(lane);
        }
        // detached：不参与等待判定。
      }
    }
  }

  /** 上报（或覆盖）一个 Lane 的准备结果；未知 Lane 被忽略。 */
  reportLane(result: StageLaneReady): void {
    if (!this.#waitableLanes.has(result.lane) && !this.#reported.has(result.lane)) {
      return;
    }
    this.#reported.set(result.lane, result);
  }

  /** Pure validation of a bounded bulk report; Stage owns preparation deadlines.
   * Time/force arguments remain accepted for existing callers and do not schedule work.
   */
  judge(
    _nowUs?: bigint,
    _elapsedBaseUs?: bigint,
    _options?: { readonly force?: boolean },
  ): BarrierVerdict {
    const unavailable: StageLaneReady[] = [];
    const missingHardLanes: CueLane[] = [];
    for (const lane of this.#hardLanes) {
      const report = this.#reported.get(lane);
      if (report === undefined) {
        missingHardLanes.push(lane);
      } else if (report.status !== "ready") {
        unavailable.push(report);
      }
    }
    if (unavailable.length > 0 || missingHardLanes.length > 0) {
      return { verdict: "hard_unavailable", lanes: unavailable, missingHardLanes };
    }

    const absentLanes: CueLane[] = [];
    for (const lane of this.#waitableLanes) {
      if (this.#hardLanes.has(lane)) {
        continue;
      }
      const report = this.#reported.get(lane);
      if (report === undefined || report.status !== "ready") {
        absentLanes.push(lane);
        if (report !== undefined) {
          unavailable.push(report);
        }
      }
    }
    return { verdict: "ready", absentLanes, unavailable };
  }
}
