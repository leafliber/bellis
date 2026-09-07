/**
 * 音频场景缓冲（纯逻辑，无 Worklet/DOM 依赖——Node 单元测试与
 * AudioWorklet 处理器共用同一实现，不复制算法）。
 *
 * - 每 Scene 一份帧块队列（写入按帧追加；容量按**当前未播占用**执行
 *   = maxBufferedUs，已消费的帧块立即释放——累计写入量不占用容量，
 *   长音频不会被静默截断）；
 * - 播放按 Scene generation 原子切换：switchScene 后 pull 只读新 Scene；
 * - 下越输出静音并计数，不复用旧样本（EOS 后耗尽的静音是预期尾态，
 *   不计下越，且每 Scene 恰好报告一次「已耗尽」）；
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
  /** 待播帧块队列（队首可能部分消费，见 chunkOffset）。 */
  chunks: Int16Array[];
  chunkOffset: number;
  /** 当前未播样本数（容量执行的账目）。 */
  buffered: number;
  /** Source samples actually rendered; silence and cancel fade are excluded. */
  rendered: number;
  /** Once a source chunk is lost, later counts cannot prove a contiguous prefix. */
  lossy: boolean;
  underruns: number;
  fading: boolean;
  fadeRemaining: number;
  fadeTotal: number;
  /** 流终止标记（endScene）：耗尽后输出静音不计下越。 */
  ended: boolean;
  /** 耗尽事件已入队（每 Scene 至多一次）。 */
  endedNotified: boolean;
}

const FADE_OUT_SAMPLES_DEFAULT = 480; // 10ms @48k

export class PcmSceneBuffer {
  readonly #maxSamples: number;
  readonly #sampleRateHz: number;
  readonly #scenes = new Map<string, SceneBuffer>();
  /** Cancel 墓碑：拒绝控制/媒体跨连接乱序造成的迟到追加与切换。 */
  readonly #cancelledScenes = new Set<string>();
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

  #newScene(): SceneBuffer {
    return {
      chunks: [],
      chunkOffset: 0,
      buffered: 0,
      rendered: 0,
      lossy: false,
      underruns: 0,
      fading: false,
      fadeRemaining: 0,
      fadeTotal: 0,
      ended: false,
      endedNotified: false,
    };
  }

  /** 追加一帧（Int16 交织样本，mono）；超出未播容量或 EOS 后拒绝。 */
  appendFrame(sceneId: string, samples: Int16Array): boolean {
    if (this.#cancelledScenes.has(sceneId)) {
      return false;
    }
    let scene = this.#scenes.get(sceneId);
    if (scene === undefined) {
      scene = this.#newScene();
      this.#scenes.set(sceneId, scene);
    }
    if (scene.ended || scene.buffered + samples.length > this.#maxSamples) {
      scene.lossy = true;
      return false;
    }
    // 复制入队：调用方的帧缓冲不驻留引用（Memory 共享边界）。
    scene.chunks.push(samples.slice());
    scene.buffered += samples.length;
    return true;
  }

  /** 原子切换播放的 Scene generation（AudioWorklet 侧在 Commit 时刻调用）。 */
  switchScene(sceneId: string): void {
    if (this.#cancelledScenes.has(sceneId)) {
      return;
    }
    this.#activeScene = sceneId;
  }

  /** 播放缓冲存量时长（微秒，按未播占用）。 */
  bufferedUs(sceneId: string): bigint {
    const scene = this.#scenes.get(sceneId);
    if (scene === undefined) {
      return 0n;
    }
    return BigInt(Math.floor((scene.buffered / this.#sampleRateHz) * 1_000_000));
  }

  underrunCount(sceneId: string): number {
    return this.#scenes.get(sceneId)?.underruns ?? 0;
  }

  renderedSamples(sceneId: string): number {
    return this.#scenes.get(sceneId)?.rendered ?? 0;
  }

  hasContiguousRendering(sceneId: string): boolean {
    const scene = this.#scenes.get(sceneId);
    return scene !== undefined && !scene.lossy && !this.#cancelledScenes.has(sceneId);
  }

  /**
   * 拉取 count 个样本写入 out（返回实际填充数）。活动 Scene 下越时输出
   * 静音并计数（EOS 后的静音是预期尾态，不计下越）；淡出中的样本乘
   * 线性衰减，衰减完即停（后续静音）。
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
      if (scene.buffered <= 0) {
        out.fill(0, filled, count);
        if (scene.ended) {
          // EOS 后耗尽：预期尾态（播放完成），静音不计下越。
          this.#markEnded(scene, sceneId);
        } else {
          scene.underruns += 1;
        }
        return count;
      }
      const head = scene.chunks[0];
      if (head === undefined) {
        // 账目与队列失配是不可达状态；防御性按耗尽处理。
        out.fill(0, filled, count);
        if (!scene.ended) {
          scene.underruns += 1;
        }
        return count;
      }
      const available = head.length - scene.chunkOffset;
      let take = Math.min(count - filled, available);
      if (scene.fading) {
        // 淡出绝不能越过预算：旧实现按整个 AudioWorklet quantum 递减，
        // fadeRemaining 过零后产生负增益（反相音频），且永不释放缓冲。
        take = Math.min(take, scene.fadeRemaining);
      }
      if (scene.fading && take > 0) {
        for (let i = 0; i < take; i += 1) {
          const factor = scene.fadeRemaining / scene.fadeTotal;
          out[filled + i] = Math.round((head[scene.chunkOffset + i] ?? 0) * factor);
          scene.fadeRemaining -= 1;
        }
      } else if (scene.fading) {
        out.fill(0, filled, count);
        this.#release(scene, sceneId);
        return count;
      } else {
        out.set(head.subarray(scene.chunkOffset, scene.chunkOffset + take), filled);
        scene.rendered += take;
      }
      scene.chunkOffset += take;
      scene.buffered -= take;
      filled += take;
      if (scene.chunkOffset >= head.length) {
        scene.chunks.shift();
        scene.chunkOffset = 0;
      }
      if (scene.fading && scene.fadeRemaining <= 0) {
        out.fill(0, filled, count);
        this.#release(scene, sceneId);
        return count;
      }
      if (scene.buffered <= 0 && scene.ended) {
        this.#markEnded(scene, sceneId);
      }
    }
    return filled;
  }

  /** 取消目标 Scene：淡出预算后丢弃其样本（其他 Scene 不受影响）。 */
  cancelScene(sceneId: string, fadeSamples = FADE_OUT_SAMPLES_DEFAULT): void {
    this.#cancelledScenes.add(sceneId);
    const scene = this.#scenes.get(sceneId);
    if (scene === undefined) {
      if (this.#activeScene === sceneId) {
        this.#activeScene = null;
      }
      return;
    }
    // Prepare 后、Commit 前尚未生效的缓冲没有用户可听副作用，无需淡出；
    // 若等待 pull 才释放，该 Scene 永远不会成为 active，缓冲会永久驻留。
    if (this.#activeScene !== sceneId || fadeSamples <= 0 || scene.buffered <= 0) {
      this.#release(scene, sceneId);
      return;
    }
    scene.fading = true;
    scene.fadeRemaining = Math.min(fadeSamples, scene.buffered);
    scene.fadeTotal = Math.max(1, scene.fadeRemaining);
  }

  /** 流终止（EOS）：返回是否已可立即报告耗尽（无样本或已放完）。 */
  endScene(sceneId: string): boolean {
    if (this.#cancelledScenes.has(sceneId)) {
      return true;
    }
    const scene = this.#scenes.get(sceneId);
    if (scene === undefined) {
      // 从未收到该 Scene 的帧：无内容可放，视为已耗尽。
      return true;
    }
    scene.ended = true;
    if (scene.buffered <= 0) {
      this.#markEnded(scene, sceneId);
      return true;
    }
    return false;
  }

  /** 取出已耗尽的 Scene 列表（每 Scene 至多报告一次）。 */
  drainEndedScenes(): string[] {
    return this.#ended.splice(0, this.#ended.length);
  }

  #ended: string[] = [];

  /** 释放一个 Scene 的全部缓冲（播放完成/连接关闭）。 */
  releaseScene(sceneId: string): void {
    const scene = this.#scenes.get(sceneId);
    if (scene !== undefined) {
      this.#release(scene, sceneId);
      return;
    }
    if (this.#activeScene === sceneId) {
      this.#activeScene = null;
    }
  }

  /** 连接代际变化：释放全部缓冲与 Cancel 墓碑。 */
  clearAll(): void {
    for (const [sceneId, scene] of this.#scenes) {
      this.#release(scene, sceneId);
    }
    this.#cancelledScenes.clear();
    this.#activeScene = null;
  }

  #release(scene: SceneBuffer, sceneId: string): void {
    scene.chunks = [];
    scene.chunkOffset = 0;
    scene.buffered = 0;
    this.#scenes.delete(sceneId);
    this.#droppedScenes += 1;
    if (this.#activeScene === sceneId) {
      this.#activeScene = null;
    }
  }

  #markEnded(scene: SceneBuffer, sceneId: string): void {
    if (scene.endedNotified) {
      return;
    }
    scene.endedNotified = true;
    this.#ended.push(sceneId);
  }
}
