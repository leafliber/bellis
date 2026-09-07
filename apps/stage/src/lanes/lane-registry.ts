import type { Cue, CueLane } from "@bellis/contracts";

/**
 * Stage Lane Adapter Port 与注册表（docs/archive/phase-2/development-guide.md §7/§8.4）。
 *
 * - 每条 Lane（audio/subtitle/avatar…）实现同一 Port：prepare 只验证/缓冲，
 *   start 在生效时刻之后才产生用户可见效果，stop 在预算内停止并释放。
 * - 注册表是有界集合：同名 Lane 后注册覆盖先注册（显式装配顺序），
 *   close() 时逆序关闭全部 Adapter。
 * - P2 交付 Port 与注册表；真实 Adapter（AudioWorklet/字幕/Live2D）在 P3
 *   接入，测试使用 Fake Adapter 验证命令、顺序与释放。
 */

export interface LanePrepareResult {
  readonly ready: boolean;
  readonly reason?: string;
}

export interface StageLaneAdapter {
  readonly lane: CueLane;
  /** Prepare：只允许验证与缓冲资源；signal 触发即放弃并释放。 */
  prepare(sceneId: string, cues: readonly Cue[], signal: AbortSignal): Promise<LanePrepareResult>;
  /** 生效：atStageUs 为映射后的本地目标时刻（到达或已过）。 */
  start(
    sceneId: string,
    atStageUs: bigint,
    cues: readonly Cue[],
    onStarted?: (atStageUs?: bigint) => void,
  ): Promise<void>;
  /** 停止并释放（取消/关闭路径）；reason 为稳定机器码。 */
  stop(sceneId: string, reason: string): Promise<void>;
  /** Lane 全部完成后的资源回收。 */
  finish(sceneId: string): Promise<void>;
  close(): Promise<void>;
}

export class LaneRegistry {
  readonly #adapters = new Map<CueLane, StageLaneAdapter>();
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  register(adapter: StageLaneAdapter): void {
    if (this.#closed) {
      throw new Error("lane_registry_closed");
    }
    this.#adapters.set(adapter.lane, adapter);
  }

  get(lane: CueLane): StageLaneAdapter | undefined {
    return this.#adapters.get(lane);
  }

  lanes(): readonly CueLane[] {
    return [...this.#adapters.keys()];
  }

  /** 逆序关闭全部 Adapter（后注册先关闭），并清空注册表。 */
  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const adapters = [...this.#adapters.values()].toReversed();
    this.#adapters.clear();
    for (const adapter of adapters) {
      await adapter.close().catch(() => {});
    }
  }
}
