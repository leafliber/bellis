import type { Mode } from './supervision.ts';

/** 控制通道上的信号：停止与模式变化。不经过决策模型、插件事件分发或普通队列。 */
export type ControlSignal =
  | { kind: 'stop'; reason: string }
  | { kind: 'mode'; mode: Mode; reason: string };

/**
 * 控制通道：关键平面（发声仲裁、Stage 服务、OBS 控制）在这里订阅停止信号。
 * 同步调用每个订阅者；单个订阅者出错只记录，不影响其他订阅者收到信号。
 */
export class ControlChannel {
  readonly #listeners = new Set<(signal: ControlSignal) => void>();
  readonly #onError: (error: unknown) => void;

  constructor(onError: (error: unknown) => void) {
    this.#onError = onError;
  }

  subscribe(listener: (signal: ControlSignal) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  broadcast(signal: ControlSignal): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(signal);
      } catch (error) {
        this.#onError(error);
      }
    }
  }
}
