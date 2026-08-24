import type { CueLane, SyncGroup } from "@bellis/contracts";
import type { StageLaneReady } from "./ports.js";

/**
 * Prepare Barrier（docs/phase-2-development-guide.md §6.2）。
 *
 * 按 Sync Group 判定准备结果，不执行 I/O：
 * - Hard 组：组内全部 Lane ready 才满足；任一 unavailable 即整组失败；
 *   已报告 Lane 之外的缺失 hard Lane 在 force 判定时视为不可用。
 * - Soft 组：Lane 可缺席（unavailable 或未报告），缺席被记录，不阻塞
 *   ready 判定；softTimeoutUs 之后仍未报告的 Lane 视为缺席
 *  （incremental 上报场景；单次 bulk 上报时立即结算）。
 * - Detached 组：不阻塞判定，Lane 状态只做记录。
 *
 * 判定是纯函数式求值：reportLane 更新快照，judge 依据当前快照与 nowUs
 * 计算 verdict；同一快照 + 同一 nowUs 恒得到同一 verdict。
 */

export type BarrierVerdict =
  | { readonly verdict: "pending" }
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
  /** soft 组等待上限（微秒；从 barrier 创建时刻起算的时长）。 */
  readonly softTimeoutUs: bigint;
}

export class PrepareBarrier {
  readonly #softTimeoutUs: bigint;
  readonly #reported = new Map<CueLane, StageLaneReady>();
  readonly #hardLanes = new Set<CueLane>();
  readonly #waitableLanes = new Set<CueLane>();

  constructor(options: PrepareBarrierOptions) {
    this.#softTimeoutUs = options.softTimeoutUs;
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

  /**
   * 是否已结算：全部 hard Lane 已报告，且（全部 soft Lane 已报告，或
   * 已超过 soft 超时）。
   */
  #settled(nowUs: bigint, elapsedBaseUs: bigint): boolean {
    for (const lane of this.#hardLanes) {
      if (!this.#reported.has(lane)) {
        return false;
      }
    }
    const softTimedOut = nowUs - elapsedBaseUs >= this.#softTimeoutUs;
    if (softTimedOut) {
      return true;
    }
    for (const lane of this.#waitableLanes) {
      if (!this.#reported.has(lane)) {
        return false;
      }
    }
    return true;
  }

  /**
   * 判定当前结果。force=true 时（bulk 上报后一次性判定），未报告的
   * hard Lane 视为不可用、soft Lane 视为缺席，不再等待。
   */
  judge(
    nowUs: bigint,
    elapsedBaseUs: bigint,
    options?: { readonly force?: boolean },
  ): BarrierVerdict {
    const force = options?.force ?? false;
    if (!force && !this.#settled(nowUs, elapsedBaseUs)) {
      return { verdict: "pending" };
    }

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
