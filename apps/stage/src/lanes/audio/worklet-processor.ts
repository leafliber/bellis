import { PcmSceneBuffer } from "./pcm-scene-buffer.js";

/**
 * AudioWorklet 处理器（Worklet 全局作用域模块，P5 由 Chromium 加载）。
 *
 * Worklet 全局环境不携带 DOM lib 类型：此处声明最小环境契约
 * （registerProcessor/AudioWorkletProcessor/port），真实实现由浏览器提供。
 *
 * 与主线程的消息协议（版本化）：
 * - { v: 1, op: "frame", sceneId, samples: Int16Array }：追加 PCM；
 * - { v: 1, op: "switch", sceneId }：Commit 时刻原子切换播放 generation；
 * - { v: 1, op: "cancel", sceneId }：预算内淡出并释放目标 Scene；
 * - { v: 1, op: "clear" }：连接代际变化/关闭，全部丢弃（静音）。
 * 未知版本/未知 op 稳定忽略并回执 error 事件；上报告在
 * { v: 1, op: "stats", underruns, activeScene } 周期回报。
 *
 * 逻辑核心是 PcmSceneBuffer（与 Node 测试共用）；本文件只做
 * Worklet 样本格式（Float32 输出）转换与消息分发。
 */

/* Worklet MessagePort 的 postMessage 没有 targetOrigin；onmessage 为 Port 形态。 */
/* oxlint-disable unicorn/require-post-message-target-origin */
/* oxlint-disable unicorn/prefer-add-event-listener */

declare function registerProcessor(name: string, ctor: new () => object): void;

interface WorkletPort {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

/**
 * 处理器基类取自 Worklet 全局作用域的 AudioWorkletProcessor（运行期由
 * 浏览器提供；编译期以构造器类型描述）。不能用 `declare abstract class`
 * ——declare 声明会被整体擦除，产物里的 extends 将指向不存在的绑定，
 * registerProcessor 不会注册处理器（AudioWorkletNode 构造失败）。
 */
const ProcessorBase = (
  globalThis as unknown as {
    AudioWorkletProcessor: abstract new () => { readonly port: WorkletPort };
  }
).AudioWorkletProcessor;

const PROTOCOL_VERSION = 1;

interface WorkletState {
  buffer: PcmSceneBuffer;
}

const state: WorkletState = {
  buffer: new PcmSceneBuffer({ maxBufferedUs: 2_000_000n, sampleRateHz: 48_000 }),
};

class PcmSceneProcessor extends ProcessorBase {
  #underrunsReported = 0;

  constructor() {
    super();
    this.port.onmessage = (event: { data: unknown }) => {
      const message = event.data as {
        v?: number;
        op?: string;
        sceneId?: string;
        samples?: Int16Array;
      };
      if (message.v !== PROTOCOL_VERSION) {
        this.port.postMessage({ v: PROTOCOL_VERSION, op: "error", code: "unsupported_version" });
        return;
      }
      switch (message.op) {
        case "frame":
          if (typeof message.sceneId === "string" && message.samples instanceof Int16Array) {
            sceneIds.add(message.sceneId);
            const accepted = state.buffer.appendFrame(message.sceneId, message.samples);
            if (!accepted) {
              this.port.postMessage({ v: PROTOCOL_VERSION, op: "error", code: "buffer_full" });
            }
          }
          break;
        case "switch":
          if (typeof message.sceneId === "string") {
            state.buffer.switchScene(message.sceneId);
          }
          break;
        case "cancel":
          if (typeof message.sceneId === "string") {
            state.buffer.cancelScene(message.sceneId);
          }
          break;
        case "clear":
          for (const sceneId of sceneIds) {
            state.buffer.releaseScene(sceneId);
          }
          sceneIds.clear();
          break;
        default:
          this.port.postMessage({ v: PROTOCOL_VERSION, op: "error", code: "unknown_op" });
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0]?.[0];
    if (output === undefined) {
      return true;
    }
    const frames = output.length;
    const pcm = new Int16Array(frames);
    state.buffer.pull(pcm, frames);
    for (let i = 0; i < frames; i += 1) {
      output[i] = (pcm[i] ?? 0) / 32768;
    }
    const active = state.buffer.activeScene;
    if (active !== null) {
      const underruns = state.buffer.underrunCount(active);
      if (underruns > this.#underrunsReported) {
        this.#underrunsReported = underruns;
        this.port.postMessage({ v: PROTOCOL_VERSION, op: "stats", underruns, activeScene: active });
      }
    }
    return true;
  }
}

/** 并行 sceneId 集合：clear 时枚举释放（PcmSceneBuffer 不暴露键枚举）。 */
const sceneIds = new Set<string>();

registerProcessor("bellis-pcm-scene", PcmSceneProcessor);
