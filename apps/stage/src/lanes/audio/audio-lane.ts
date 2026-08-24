import type { Cue, CueLane } from "@bellis/contracts";
import type { LanePrepareResult, StageLaneAdapter } from "../lane-registry.js";

/**
 * 音频 Lane 主线程适配器（docs/phase-2-development-guide.md §8.2）。
 *
 * - 浏览器自动播放限制：AudioContext 未成功 resume（未 Arm）时 prepare
 *   返回 audio_not_armed——绝不虚报 Ready；
 * - prepare 等待预缓冲达标（默认 6 帧 = 120ms）才返回 ready：PCM 帧经
 *   Media WS 到达并 appendFrame 送入 Worklet 有界缓冲（缓冲不是生效：
 *   出声只由 start 时的 switch 消息决定）；signal 中止即放弃；
 * - Cancel 在 Worklet 预算内淡出并只清空目标 Scene；
 * - 音频环境经 Port 注入：Node 测试用 Fake 验证消息协议，真实
 *   AudioWorklet 由 P5 Chromium Smoke 验证。
 */

export interface WorkletMessage {
  readonly v: 1;
  readonly op: "frame" | "switch" | "cancel" | "clear" | "error" | "stats";
  readonly sceneId?: string;
  readonly samples?: Int16Array;
  readonly underruns?: number;
  readonly code?: string;
}

/** 音频环境 Port：生产实现包装 AudioContext + AudioWorkletNode。 */
export interface AudioEnvironment {
  /** Arm：创建并 resume AudioContext；失败（自动播放限制）返回 false。 */
  arm(): Promise<boolean>;
  /** 加载 Worklet 并连接节点（幂等）；未 Arm 时抛错。 */
  ensureNode(): Promise<void>;
  postToWorklet(message: WorkletMessage): void;
  onWorkletMessage(handler: ((message: WorkletMessage) => void) | null): void;
  close(): Promise<void>;
}

export interface AudioLaneOptions {
  readonly environment: AudioEnvironment;
  /** Ready 前置：已缓冲帧数阈值（默认 6 帧 = 120ms 预缓冲）。 */
  readonly minPreparedFrames?: number;
}

interface AudioScene {
  frames: number;
  waiters: Array<(satisfied: boolean) => void>;
}

export class AudioLaneAdapter implements StageLaneAdapter {
  readonly lane: CueLane = "audio";
  readonly #environment: AudioEnvironment;
  readonly #minPreparedFrames: number;
  readonly #scenes = new Map<string, AudioScene>();
  #armed = false;
  #underruns = 0;
  #closed = false;

  constructor(options: AudioLaneOptions) {
    this.#environment = options.environment;
    this.#minPreparedFrames = options.minPreparedFrames ?? 6;
    this.#environment.onWorkletMessage((message) => {
      if (message.op === "stats" && message.underruns !== undefined) {
        this.#underruns = message.underruns;
      }
    });
  }

  get armed(): boolean {
    return this.#armed;
  }

  get underruns(): number {
    return this.#underruns;
  }

  /** 用户手势 Arm 入口（StageApp.armAudio 之后调用）。 */
  async arm(): Promise<boolean> {
    if (this.#closed) {
      return false;
    }
    this.#armed = await this.#environment.arm();
    return this.#armed;
  }

  async prepare(
    sceneId: string,
    _cues: readonly Cue[],
    signal: AbortSignal,
  ): Promise<LanePrepareResult> {
    if (!this.#armed) {
      return { ready: false, reason: "audio_not_armed" };
    }
    try {
      await this.#environment.ensureNode();
    } catch {
      return { ready: false, reason: "prepare_failed" };
    }
    const record = this.#scenes.get(sceneId) ?? { frames: 0, waiters: [] };
    this.#scenes.set(sceneId, record);
    if (record.frames >= this.#minPreparedFrames) {
      return { ready: true };
    }
    const satisfied = await new Promise<boolean>((resolve) => {
      record.waiters.push(resolve);
      signal.addEventListener(
        "abort",
        () => {
          resolve(false);
        },
        { once: true },
      );
    });
    return satisfied
      ? { ready: true }
      : { ready: false, reason: signal.aborted ? "cancelled" : "prebuffer_timeout" };
  }

  /** Media WS 帧到达：送入 Worklet 缓冲（不生效），达标时放行 prepare。 */
  appendFrame(sceneId: string, samples: Int16Array): void {
    if (this.#closed) {
      return;
    }
    const record = this.#scenes.get(sceneId) ?? { frames: 0, waiters: [] };
    this.#scenes.set(sceneId, record);
    record.frames += 1;
    this.#environment.postToWorklet({ v: 1, op: "frame", sceneId, samples });
    if (record.frames >= this.#minPreparedFrames) {
      const waiters = record.waiters;
      record.waiters = [];
      for (const resolve of waiters) {
        resolve(true);
      }
    }
  }

  get bufferedFrames(): ReadonlyMap<string, number> {
    const snapshot = new Map<string, number>();
    for (const [sceneId, record] of this.#scenes) {
      snapshot.set(sceneId, record.frames);
    }
    return snapshot;
  }

  async start(sceneId: string, _atStageUs: bigint, _cues: readonly Cue[]): Promise<void> {
    // Commit 生效时刻：原子切换播放 generation。
    this.#environment.postToWorklet({ v: 1, op: "switch", sceneId });
  }

  async stop(sceneId: string, _reason: string): Promise<void> {
    this.#environment.postToWorklet({ v: 1, op: "cancel", sceneId });
    this.#scenes.delete(sceneId);
  }

  async finish(sceneId: string): Promise<void> {
    this.#environment.postToWorklet({ v: 1, op: "cancel", sceneId });
    this.#scenes.delete(sceneId);
  }

  /** 连接代际变化/关闭：全部缓冲清空（静音）。 */
  clearAll(): void {
    this.#environment.postToWorklet({ v: 1, op: "clear" });
    for (const record of this.#scenes.values()) {
      for (const resolve of record.waiters) {
        resolve(false);
      }
    }
    this.#scenes.clear();
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.clearAll();
    this.#environment.onWorkletMessage(null);
    await this.#environment.close();
  }
}
