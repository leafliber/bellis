import type { Cue, CueLane } from "@bellis/contracts";
import type { LanePrepareResult, StageLaneAdapter } from "../lane-registry.js";

/**
 * Avatar Lane（docs/phase-2-development-guide.md §8.4）。
 *
 * Phase 2 交付 Port 语义 + 录制适配器（CI 路径：验证命令、顺序、资源
 * 释放与 drift；不渲染真实模型）。浏览器 Cubism Adapter 边界：只接收
 * 语义 motion/expression/channel，不接收 LLM 帧级参数；未授权 SDK/模型
 * 资源不进入仓库（真实装配在 P5 以显式配置的已授权资源手工 Smoke）。
 */

export interface AvatarCapabilities {
  readonly adapter: string;
  readonly motions: readonly string[];
  readonly expressions: readonly string[];
}

export type AvatarCommand =
  | {
      readonly kind: "prepare";
      readonly sceneId: string;
      readonly motions: readonly string[];
      readonly expressions: readonly string[];
    }
  | {
      readonly kind: "start";
      readonly sceneId: string;
      readonly atStageUs: string;
      readonly motion?: string;
      readonly expression?: string;
    }
  | { readonly kind: "stop"; readonly sceneId: string; readonly reason: string }
  | { readonly kind: "close" };

/** 浏览器侧稳定 Port（P5 的 Cubism Adapter 实现同一接口）。 */
export interface AvatarLaneAdapter extends StageLaneAdapter {
  capabilities(): AvatarCapabilities;
}

/** 录制适配器：记录全部命令与顺序，供 CI 断言（§8.4）。 */
export class RecordingAvatarAdapter implements AvatarLaneAdapter {
  readonly lane: CueLane = "avatar";
  readonly #supportedMotions: ReadonlySet<string>;
  readonly #supportedExpressions: ReadonlySet<string>;
  readonly commands: AvatarCommand[] = [];
  readonly #prepared = new Set<string>();
  #closed = false;

  constructor(capabilities: AvatarCapabilities) {
    this.#supportedMotions = new Set(capabilities.motions);
    this.#supportedExpressions = new Set(capabilities.expressions);
  }

  capabilities(): AvatarCapabilities {
    return {
      adapter: "recording",
      motions: [...this.#supportedMotions],
      expressions: [...this.#supportedExpressions],
    };
  }

  async prepare(
    sceneId: string,
    cues: readonly Cue[],
    _signal: AbortSignal,
  ): Promise<LanePrepareResult> {
    if (this.#closed) {
      return { ready: false, reason: "prepare_failed" };
    }
    const motions: string[] = [];
    const expressions: string[] = [];
    for (const cue of cues) {
      const intent = cue.intent as { motion?: unknown; expression?: unknown };
      if (typeof intent.motion === "string") {
        motions.push(intent.motion);
      }
      if (typeof intent.expression === "string") {
        expressions.push(intent.expression);
      }
    }
    const unknown = [
      ...motions.filter((motion) => !this.#supportedMotions.has(motion)).map((m) => `motion:${m}`),
      ...expressions
        .filter((expression) => !this.#supportedExpressions.has(expression))
        .map((e) => `expression:${e}`),
    ];
    this.commands.push({ kind: "prepare", sceneId, motions, expressions });
    if (unknown.length > 0) {
      return { ready: false, reason: "motion_not_found" };
    }
    this.#prepared.add(sceneId);
    return { ready: true };
  }

  async start(sceneId: string, atStageUs: bigint, cues: readonly Cue[]): Promise<void> {
    const first = cues[0];
    const intent = (first?.intent ?? {}) as { motion?: string; expression?: string };
    this.commands.push({
      kind: "start",
      sceneId,
      atStageUs: atStageUs.toString(),
      ...(intent.motion === undefined ? {} : { motion: intent.motion }),
      ...(intent.expression === undefined ? {} : { expression: intent.expression }),
    });
    this.#prepared.delete(sceneId);
  }

  async stop(sceneId: string, reason: string): Promise<void> {
    this.commands.push({ kind: "stop", sceneId, reason });
    this.#prepared.delete(sceneId);
  }

  async finish(sceneId: string): Promise<void> {
    this.commands.push({ kind: "stop", sceneId, reason: "finished" });
    this.#prepared.delete(sceneId);
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.commands.push({ kind: "close" });
    this.#prepared.clear();
  }
}
