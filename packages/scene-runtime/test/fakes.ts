import type { ScenePlan } from "@bellis/contracts";
import { VirtualClock } from "@bellis/testkit";
import type {
  CancelOutcome,
  DurableCommitResult,
  SceneLifecycleRecord,
  SceneRepositoryPort,
  StagePort,
  StageReady,
} from "../src/index.js";

/**
 * 可脚本化的 Stage/Repository 假件：只替换外部能力，不绕开被测的
 * Compiler/Director 逻辑（docs/phase-2-development-guide.md §3.10）。
 */

export interface StageCall {
  readonly op: "prepare" | "commit" | "cancel";
  readonly sceneId?: string;
  readonly commitAtRuntimeUs?: bigint;
  readonly reason?: string;
}

export class FakeStagePort implements StagePort {
  readonly calls: StageCall[] = [];
  /** sceneId → prepare 结果或抛出值；缺省全部 ready。 */
  readonly prepareBehaviors = new Map<string, StageReady | Error>();
  /** sceneId → commit 行为（默认成功）。 */
  readonly commitBehaviors = new Map<string, Error>();
  /** sceneId → cancel 行为（默认 stopped）。 */
  readonly cancelBehaviors = new Map<string, CancelOutcome | Error>();
  /** 外部控制的 prepare 挂起（按 sceneId resolve）。 */
  readonly #pendingPrepares = new Map<
    string,
    { resolve: (ready: StageReady) => void; reject: (error: unknown) => void }
  >();

  #defaultReady(plan: ScenePlan): StageReady {
    return {
      lanes: plan.scene.groups.flatMap((group) =>
        group.lanes.map((lane) => ({ lane, status: "ready", cueIds: [] })),
      ),
      preparedAtStageUs: 0n,
    };
  }

  prepare(plan: ScenePlan, _deadlineUs: bigint, signal: AbortSignal): Promise<StageReady> {
    this.calls.push({ op: "prepare", sceneId: plan.scene.sceneId });
    const behavior = this.prepareBehaviors.get(plan.scene.sceneId);
    if (behavior instanceof Error) {
      return Promise.reject(behavior);
    }
    if (behavior !== undefined) {
      return Promise.resolve(behavior);
    }
    return new Promise<StageReady>((resolve, reject) => {
      this.#pendingPrepares.set(plan.scene.sceneId, { resolve, reject });
      signal.addEventListener(
        "abort",
        () => {
          this.#pendingPrepares.delete(plan.scene.sceneId);
          reject(signal.reason ?? new Error("aborted"));
        },
        { once: true },
      );
    });
  }

  /** 测试驱动：放行某个挂起的 prepare。 */
  settlePrepare(sceneId: string, ready?: StageReady): void {
    const pending = this.#pendingPrepares.get(sceneId);
    if (pending !== undefined) {
      this.#pendingPrepares.delete(sceneId);
      pending.resolve(ready ?? { lanes: [], preparedAtStageUs: 0n });
    }
  }

  /** 测试驱动：立即完成的 prepare（不挂起）。 */
  prepareImmediate(plan: ScenePlan, ready?: StageReady): void {
    this.prepareBehaviors.set(plan.scene.sceneId, ready ?? this.#defaultReady(plan));
    const pending = this.#pendingPrepares.get(plan.scene.sceneId);
    if (pending !== undefined) {
      this.#pendingPrepares.delete(plan.scene.sceneId);
      pending.resolve(this.#defaultReady(plan));
    }
  }

  commit(sceneId: string, commitAtRuntimeUs: bigint, _signal: AbortSignal): Promise<void> {
    this.calls.push({ op: "commit", sceneId, commitAtRuntimeUs });
    const behavior = this.commitBehaviors.get(sceneId);
    if (behavior !== undefined) {
      return Promise.reject(behavior);
    }
    return Promise.resolve();
  }

  cancel(sceneId: string, reason: string, _signal: AbortSignal): Promise<CancelOutcome> {
    this.calls.push({ op: "cancel", sceneId, reason });
    const behavior = this.cancelBehaviors.get(sceneId);
    if (behavior instanceof Error) {
      return Promise.reject(behavior);
    }
    if (behavior !== undefined) {
      return Promise.resolve(behavior);
    }
    return Promise.resolve({ status: "stopped" });
  }
}

export class FakeRepositoryPort implements SceneRepositoryPort {
  readonly commits: unknown[] = [];
  readonly lifecycle: SceneLifecycleRecord[] = [];
  commitError: Error | null = null;
  nextCommittedAtMs = 1_755_600_000_000;

  commit(_input: unknown, _signal: AbortSignal): Promise<DurableCommitResult> {
    if (this.commitError !== null) {
      return Promise.reject(this.commitError);
    }
    this.commits.push(_input);
    return Promise.resolve({
      sceneId: "ignored",
      committedAtMs: this.nextCommittedAtMs,
      duplicate: false,
    });
  }

  appendLifecycle(record: SceneLifecycleRecord, _signal: AbortSignal): Promise<void> {
    this.lifecycle.push(record);
    return Promise.resolve();
  }
}

export function testClock(): VirtualClock {
  return new VirtualClock();
}

export function readyFor(plan: ScenePlan, overrides?: Partial<StageReady>): StageReady {
  const lanes = plan.scene.groups.flatMap((group) =>
    group.lanes.map((lane) => ({ lane, status: "ready" as const, cueIds: [] })),
  );
  return { lanes, preparedAtStageUs: 0n, ...overrides };
}

export function unavailableFor(plan: ScenePlan, lane: string, reason: string): StageReady {
  return {
    lanes: plan.scene.groups.flatMap((group) =>
      group.lanes.map((l) =>
        l === lane
          ? { lane: l, status: "unavailable", reason, cueIds: [] }
          : { lane: l, status: "ready", cueIds: [] },
      ),
    ),
    preparedAtStageUs: 0n,
  };
}
