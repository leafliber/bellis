import type { Cue, CueLane } from "@bellis/contracts";
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
 */
export class DomAvatarLane implements StageLaneAdapter {
  readonly lane: CueLane = "avatar";
  readonly #recorder: RecordingAvatarAdapter;
  readonly #badge: HTMLElement;

  constructor(capabilities: AvatarCapabilities, badge: HTMLElement) {
    this.#recorder = new RecordingAvatarAdapter(capabilities);
    this.#badge = badge;
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
  }

  async stop(sceneId: string, reason: string): Promise<void> {
    await this.#recorder.stop(sceneId, reason);
    this.present(undefined, undefined);
  }

  async finish(sceneId: string): Promise<void> {
    await this.#recorder.finish(sceneId);
    this.present(undefined, undefined);
  }

  async close(): Promise<void> {
    this.present(undefined, undefined);
    await this.#recorder.close();
  }
}
