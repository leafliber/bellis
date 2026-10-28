import type { Mode } from './supervision.ts';

/** 控制通道上的信号：停止、模式变化与操作员的否决和放行。不经过决策模型、插件事件分发或普通队列。 */
export type ControlSignal =
  | { kind: 'stop'; reason: string }
  /**
   * 急停的 OBS 应急动作（静音 Stage 源、切安全场景）完成；obsOk 为全部成功。紧跟在对应的 stop 之后，
   * 同一次应急动作只发一次。发声仲裁据此决定写回是否扣掉呈现延迟（发声文档“播放游标与写回”）。
   */
  | { kind: 'emergency-completed'; reason: string; obsOk: boolean }
  | { kind: 'mode'; mode: Mode; reason: string }
  /** M1 中否决等待放行的句子；key 为空时否决全部，并放弃它们所属发言剩下的句子（由放行环节转告仲裁）。 */
  | { kind: 'veto'; key: string | undefined; reason: string }
  /** M1 中放行等待中的句子（逐句放行，或提前结束固定延迟）；key 为空时放行全部。 */
  | { kind: 'release'; key: string | undefined; reason: string };

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
