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
 * - close() 释放节点与上下文（页面隐藏/卸载零残留）。
 */

const WORKLET_PROCESSOR_NAME = "bellis-pcm-scene";

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
  #moduleLoaded = false;
  #workletHandler: ((message: WorkletMessage) => void) | null = null;
  #closed = false;
  #lastError: string | null = null;

  /** 最近一次 Arm/ensureNode 错误（诊断句柄暴露给 E2E）。 */
  get lastError(): string | null {
    return this.#lastError;
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
      this.#workletHandler?.(event.data as WorkletMessage);
    };
    // 连接即开始拉取（Worklet 内无活动 Scene 时输出静音）。
    node.connect(context.destination);
    this.#node = node;
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
    this.#workletHandler = null;
    const node = this.#node;
    this.#node = null;
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
