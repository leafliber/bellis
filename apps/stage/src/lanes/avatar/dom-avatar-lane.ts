import type { Cue, CueLane, MonotonicClock } from "@bellis/contracts";
import {
  RecordingAvatarAdapter,
  type AvatarCapabilities,
  type AvatarCommand,
} from "./avatar-lane.js";
import type { LanePrepareResult, StageLaneAdapter } from "../lane-registry.js";

/**
 * 浏览器 Avatar Lane（docs/phase-2-development-guide.md §8.4）。
 *
 * Phase 2 浏览器路径 = Recording Adapter（命令/顺序/释放与 CI 同源验证）
 * + 最小 DOM 呈现（语义 motion/expression 文本徽标，无帧级参数、无未授权
 * Cubism 资源；真实 Cubism Adapter 属后续阶段显式授权装配）。
 *
 * start() 的 Promise 在动作**呈现窗口结束**时兑现（intent.durationMs，
 * Compiler 透传；缺失时回退默认时长）——徽标回 idle，scene.finished
 * 不再被立即兑现。
 */

/** 意图缺失 durationMs 时的呈现窗口回退（与 Fake Model 默认动作时长一致）。 */
const DEFAULT_MOTION_DURATION_MS = 1_200;

export class DomAvatarLane implements StageLaneAdapter {
  readonly lane: CueLane = "avatar";
  readonly #recorder: RecordingAvatarAdapter;
  readonly #badge: HTMLElement;
  readonly #clock: MonotonicClock;
  readonly #running = new Map<string, AbortController>();
  #closed = false;

  constructor(capabilities: AvatarCapabilities, badge: HTMLElement, clock: MonotonicClock) {
    this.#recorder = new RecordingAvatarAdapter(capabilities);
    this.#badge = badge;
    this.#clock = clock;
  }

  get commands(): readonly AvatarCommand[] {
    return this.#recorder.commands;
  }

  private present(motion: string | undefined, expression: string | undefined): void {
    const parts = [
      ...(motion === undefined ? [] : [`motion:${motion}`]),
      ...(expression === undefined ? [] : [`expression:${expression}`]),
    ];
    this.#badge.textContent = parts.length > 0 ? parts.join(" · ") : "idle";
  }

  /** 意图声明的呈现时长（毫秒）；缺失/非法回退默认。 */
  private motionDurationMs(cues: readonly Cue[]): number {
    for (const cue of cues) {
      const intent = cue.intent as { durationMs?: unknown };
      if (
        typeof intent.durationMs === "number" &&
        Number.isInteger(intent.durationMs) &&
        intent.durationMs >= 0
      ) {
        return intent.durationMs;
      }
    }
    return DEFAULT_MOTION_DURATION_MS;
  }

  async prepare(
    sceneId: string,
    cues: readonly Cue[],
    signal: AbortSignal,
  ): Promise<LanePrepareResult> {
    return this.#recorder.prepare(sceneId, cues, signal);
  }

  async start(sceneId: string, atStageUs: bigint, cues: readonly Cue[]): Promise<void> {
    await this.#recorder.start(sceneId, atStageUs, cues);
    const intent = (cues[0]?.intent ?? {}) as { motion?: string; expression?: string };
    this.present(intent.motion, intent.expression);
    const endAtUs = atStageUs + BigInt(this.motionDurationMs(cues)) * 1000n;
    const timer = new AbortController();
    this.#running.set(sceneId, timer);
    try {
      await this.#clock.sleepUntil(endAtUs, timer.signal);
    } catch {
      return; // 停止/关闭打断：呈现窗口未走完（取消语义）。
    } finally {
      if (this.#running.get(sceneId) === timer) {
        this.#running.delete(sceneId);
        this.present(undefined, undefined);
      }
    }
  }

  async stop(sceneId: string, reason: string): Promise<void> {
    this.#running.get(sceneId)?.abort(new Error(`avatar_stopped:${sceneId}`));
    this.#running.delete(sceneId);
    await this.#recorder.stop(sceneId, reason);
    this.present(undefined, undefined);
  }

  async finish(sceneId: string): Promise<void> {
    this.#running.get(sceneId)?.abort(new Error(`avatar_finished:${sceneId}`));
    this.#running.delete(sceneId);
    await this.#recorder.finish(sceneId);
    this.present(undefined, undefined);
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.present(undefined, undefined);
    for (const timer of this.#running.values()) {
      timer.abort(new Error("avatar_lane_closed"));
    }
    this.#running.clear();
    await this.#recorder.close();
  }
}
