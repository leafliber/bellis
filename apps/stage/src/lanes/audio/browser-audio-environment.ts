/* AudioWorklet MessagePort 的 postMessage 没有 targetOrigin。 */
/* oxlint-disable unicorn/require-post-message-target-origin */
/* AudioWorkletNode.port 以 on* setter 为接口（Worklet Port 形态）。 */
/* oxlint-disable unicorn/prefer-add-event-listener */
import type { AudioEnvironment, WorkletMessage } from "./audio-lane.js";

/**
 * 浏览器音频环境（AudioContext + AudioWorklet，docs/phase-2-development-guide.md §8.2）。
 *
 * - Arm = 用户手势内创建 48kHz AudioContext 并 resume（自动播放限制是
 *   正式前置条件，失败如实返回 false）；
 * - Worklet 模块按环境解析：dev 由 Vite 服务 TS 源（按需转换）；
 *   产物为独立 lib 构建（/stage/worklet/bellis-pcm-scene.js，算法与
 *   Node 测试共用 PcmSceneBuffer，不复制实现）；
 * - Commit 前不连接 destination：节点创建即静音，只有 AudioLane 的
 *   switch 消息切换 generation 后才出声（缓冲不是生效）；
 * - 出声链路串接 AnalyserNode：周期采样输出 RMS（Commit 后音频能量是
 *   E2E 的真实出声证据），有界环形缓冲；
 * - close() 释放节点与上下文（页面隐藏/卸载零残留）。
 */

const WORKLET_PROCESSOR_NAME = "bellis-pcm-scene";
/** 能量采样周期与环形缓冲上限（50ms × 2400 ≈ 2 分钟）。 */
const ENERGY_SAMPLE_INTERVAL_MS = 50;
const ENERGY_RING_CAPACITY = 2_400;

export interface AudioEnergySample {
  readonly at: number;
  readonly rms: number;
}

function workletModuleUrl(): string {
  // dev：Vite 服务 TS 源（按需转换）；build：独立 lib 产物。两者都必须
  // 挂在 base（/stage/）下——AudioWorklet 的模块解析不允许跳出 base。
  return import.meta.env.DEV
    ? `${import.meta.env.BASE_URL}src/lanes/audio/worklet-processor.ts`
    : `${import.meta.env.BASE_URL}worklet/bellis-pcm-scene.js`;
}

export class BrowserAudioEnvironment implements AudioEnvironment {
  #context: AudioContext | null = null;
  #node: AudioWorkletNode | null = null;
  #analyser: AnalyserNode | null = null;
  #energyTimer: ReturnType<typeof setInterval> | null = null;
  readonly #energy: AudioEnergySample[] = [];
  #moduleLoaded = false;
  #workletHandler: ((message: WorkletMessage) => void) | null = null;
  #closed = false;
  #lastError: string | null = null;

  /** 最近一次 Arm/ensureNode 错误（诊断句柄暴露给 E2E）。 */
  get lastError(): string | null {
    return this.#lastError;
  }

  /** 输出能量采样（RMS，50ms 周期；有界环形缓冲快照）。 */
  energyTrace(): readonly AudioEnergySample[] {
    return [...this.#energy];
  }

  async arm(): Promise<boolean> {
    if (this.#closed) {
      return false;
    }
    if (this.#context === null) {
      try {
        this.#context = new AudioContext({ sampleRate: 48_000, latencyHint: "interactive" });
      } catch (error) {
        this.#lastError = `context:${String(error)}`;
        return false;
      }
    }
    if (this.#context.state === "suspended") {
      try {
        await this.#context.resume();
      } catch {
        return false;
      }
    }
    return this.#context.state === "running";
  }

  async ensureNode(): Promise<void> {
    const context = this.#context;
    if (context === null) {
      throw new Error("audio_not_armed");
    }
    if (this.#node !== null) {
      return;
    }
    if (!this.#moduleLoaded) {
      try {
        await context.audioWorklet.addModule(workletModuleUrl());
        this.#moduleLoaded = true;
      } catch (error) {
        this.#lastError = `addModule:${String(error)}`;
        throw error;
      }
    }
    let node: AudioWorkletNode;
    try {
      node = new AudioWorkletNode(context, WORKLET_PROCESSOR_NAME, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
    } catch (error) {
      this.#lastError = `node:${String(error)}`;
      throw error;
    }
    node.port.onmessage = (event: MessageEvent) => {
      const message = event.data as WorkletMessage;
      if (
        (message.op === "started" || message.op === "progress") &&
        message.renderedAtAudioSeconds !== undefined
      ) {
        // Map the render clock into performance.now's domain; excludes device output latency.
        const atMs =
          performance.now() + (message.renderedAtAudioSeconds - context.currentTime) * 1000;
        this.#workletHandler?.({
          ...message,
          renderedAtStageUs: BigInt(Math.round(Math.max(0, atMs) * 1000)),
          startedAtStageUs: BigInt(Math.max(0, Math.round(atMs * 1000))),
        });
      } else this.#workletHandler?.(message);
    };
    // 出声链路串接 AnalyserNode（直通音频）：Commit 后的输出能量是
    // 「PCM 真实出声」的浏览器侧证据。
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    node.connect(analyser);
    analyser.connect(context.destination);
    this.#analyser = analyser;
    this.#node = node;
    this.#startEnergySampling();
  }

  #startEnergySampling(): void {
    if (this.#energyTimer !== null) {
      return;
    }
    const buffer = new Float32Array(this.#analyser?.fftSize ?? 1024);
    this.#energyTimer = setInterval(() => {
      const analyser = this.#analyser;
      if (analyser === null) {
        return;
      }
      analyser.getFloatTimeDomainData(buffer);
      let sumSquares = 0;
      for (const value of buffer) {
        sumSquares += value * value;
      }
      const rms = Math.sqrt(sumSquares / buffer.length);
      this.#energy.push({ at: performance.now(), rms });
      while (this.#energy.length > ENERGY_RING_CAPACITY) {
        this.#energy.shift();
      }
    }, ENERGY_SAMPLE_INTERVAL_MS);
  }

  postToWorklet(message: WorkletMessage): void {
    this.#node?.port.postMessage(message);
  }

  onWorkletMessage(handler: ((message: WorkletMessage) => void) | null): void {
    this.#workletHandler = handler;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    if (this.#energyTimer !== null) {
      clearInterval(this.#energyTimer);
      this.#energyTimer = null;
    }
    this.#workletHandler = null;
    const node = this.#node;
    this.#node = null;
    this.#analyser = null;
    if (node !== null) {
      node.port.onmessage = null;
      node.disconnect();
    }
    const context = this.#context;
    this.#context = null;
    if (context !== null) {
      await context.close().catch(() => {});
    }
  }
}
