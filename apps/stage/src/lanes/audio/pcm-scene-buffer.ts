/**
 * 音频场景缓冲（纯逻辑，无 Worklet/DOM 依赖——Node 单元测试与
 * AudioWorklet 处理器共用同一实现，不复制算法）。
 *
 * - 每 Scene 一份线性 Int16 缓冲（写入按帧追加，容量 = maxBufferedUs 上限）；
 * - 播放按 Scene generation 原子切换：switchScene 后 pull 只读新 Scene；
 * - 下越输出静音并计数，不复用旧样本；
 * - cancelScene 只清空目标 Scene 并做线性淡出，不影响其他 Scene；
 * - Commit 前数据可先写入（缓冲不是生效）；真正的出声由
 *   AudioWorkletNode 连接 + switchScene 决定。
 */

export interface PcmSceneBufferOptions {
  /** 单 Scene 最大缓冲时长（微秒，默认 2_000_000 = Stage maxBufferedUs）。 */
  readonly maxBufferedUs?: bigint;
  readonly sampleRateHz?: number;
}

interface SceneBuffer {
  samples: Int16Array;
  written: number;
  read: number;
  underruns: number;
  fading: boolean;
  fadeRemaining: number;
  fadeTotal: number;
}

const FADE_OUT_SAMPLES_DEFAULT = 480; // 10ms @48k

export class PcmSceneBuffer {
  readonly #maxSamples: number;
  readonly #sampleRateHz: number;
  readonly #scenes = new Map<string, SceneBuffer>();
  #activeScene: string | null = null;
  #droppedScenes = 0;

  constructor(options: PcmSceneBufferOptions = {}) {
    this.#sampleRateHz = options.sampleRateHz ?? 48_000;
    const maxBufferedUs = options.maxBufferedUs ?? 2_000_000n;
    this.#maxSamples = Number((maxBufferedUs * BigInt(this.#sampleRateHz)) / 1_000_000n);
  }

  get activeScene(): string | null {
    return this.#activeScene;
  }

  get droppedScenes(): number {
    return this.#droppedScenes;
  }

  /** 追加一帧（Int16 交织样本，mono）；超容量丢弃并返回 false。 */
  appendFrame(sceneId: string, samples: Int16Array): boolean {
    let scene = this.#scenes.get(sceneId);
    if (scene === undefined) {
      scene = {
        samples: new Int16Array(this.#maxSamples),
        written: 0,
        read: 0,
        underruns: 0,
        fading: false,
        fadeRemaining: 0,
        fadeTotal: 0,
      };
      this.#scenes.set(sceneId, scene);
    }
    if (scene.written + samples.length > scene.samples.length) {
      return false;
    }
    scene.samples.set(samples, scene.written);
    scene.written += samples.length;
    return true;
  }

  /** 原子切换播放的 Scene generation（AudioWorklet 侧在 Commit 时刻调用）。 */
  switchScene(sceneId: string): void {
    this.#activeScene = sceneId;
  }

  /** 播放缓冲存量时长（微秒，按已写-已读）。 */
  bufferedUs(sceneId: string): bigint {
    const scene = this.#scenes.get(sceneId);
    if (scene === undefined) {
      return 0n;
    }
    return BigInt(Math.floor(((scene.written - scene.read) / this.#sampleRateHz) * 1_000_000));
  }

  underrunCount(sceneId: string): number {
    return this.#scenes.get(sceneId)?.underruns ?? 0;
  }

  /**
   * 拉取 count 个样本写入 out（返回实际填充数）。活动 Scene 下越时输出
   * 静音并计数；淡出中的样本乘线性衰减，衰减完即停（后续静音）。
   */
  pull(out: Int16Array, count: number): number {
    const sceneId = this.#activeScene;
    if (sceneId === null) {
      out.fill(0, 0, count);
      return count;
    }
    const scene = this.#scenes.get(sceneId);
    if (scene === undefined) {
      out.fill(0, 0, count);
      return count;
    }
    let filled = 0;
    while (filled < count) {
      const available = scene.written - scene.read;
      if (available <= 0) {
        // 下越：静音填充，不复用旧样本。
        out.fill(0, filled, count);
        scene.underruns += 1;
        return count;
      }
      const take = Math.min(count - filled, available);
      const source = scene.samples.subarray(scene.read, scene.read + take);
      if (scene.fading && scene.fadeRemaining > 0) {
        for (let i = 0; i < take; i += 1) {
          const factor = Math.min(1, scene.fadeRemaining / scene.fadeTotal);
          out[filled + i] = Math.round((source[i] ?? 0) * factor);
          scene.fadeRemaining -= 1;
        }
      } else if (scene.fading) {
        out.fill(0, filled, count);
        return count;
      } else {
        out.set(source, filled);
      }
      scene.read += take;
      filled += take;
    }
    return filled;
  }

  /** 取消目标 Scene：淡出预算后丢弃其样本（其他 Scene 不受影响）。 */
  cancelScene(sceneId: string, fadeSamples = FADE_OUT_SAMPLES_DEFAULT): void {
    const scene = this.#scenes.get(sceneId);
    if (scene === undefined) {
      return;
    }
    scene.fading = true;
    scene.fadeRemaining = Math.min(fadeSamples, scene.written - scene.read);
    scene.fadeTotal = Math.max(1, scene.fadeRemaining);
    // 预算耗尽即整段丢弃：淡出样本已在缓冲内，后续 append 拒绝。
    if (scene.fadeRemaining <= 0) {
      this.#scenes.delete(sceneId);
      this.#droppedScenes += 1;
      if (this.#activeScene === sceneId) {
        this.#activeScene = null;
      }
    }
  }

  /** 释放一个 Scene 的全部缓冲（播放完成/连接关闭）。 */
  releaseScene(sceneId: string): void {
    if (this.#scenes.delete(sceneId)) {
      this.#droppedScenes += 1;
    }
    if (this.#activeScene === sceneId) {
      this.#activeScene = null;
    }
  }
}
