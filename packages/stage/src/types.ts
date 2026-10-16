import { defineService } from '@bellis/kernel';

/** Stage 音频输出许可对应的资源名。 */
export const STAGE_AUDIO = 'stage.audio';

/** Stage 服务发给页面的消息。P1 起经 WebSocket 传给 OBS 浏览器源（音频为二进制帧）。 */
export type ToPage =
  /**
   * 当前的 Stage 音频输出许可令牌与时长；null 表示已吊销或无人持有。
   * 续约时以同一令牌重发；页面在时长内收不到续约即视为许可过期，自行停止（不依赖持有者配合）。
   */
  | { kind: 'token'; token: number | null; ttlMs: number }
  | { kind: 'begin'; sentenceId: string; token: number; subtitle: string; sampleRate: number }
  | { kind: 'audio'; sentenceId: string; token: number; pcm: Int16Array }
  /** 这一句不会再有更多音频。 */
  | { kind: 'end'; sentenceId: string; token: number }
  /** 立即停止播放这一句。 */
  | { kind: 'truncate'; sentenceId: string }
  | { kind: 'heartbeat' };

/** 页面回报的播放事件。`played` 为该句实际播出的采样数（欠载补零不计入）。 */
export type FromPage =
  | { kind: 'started'; sentenceId: string }
  | { kind: 'cursor'; sentenceId: string; played: number }
  | { kind: 'underrun'; sentenceId: string; played: number }
  | { kind: 'ended'; sentenceId: string; played: number }
  | { kind: 'truncated'; sentenceId: string; played: number; reason: string }
  | { kind: 'muted'; reason: string }
  | { kind: 'heartbeat-ack' };

/** Stage 服务与页面之间的链路。 */
export interface PageLink {
  /**
   * 页面是否已连上并认证。真实页面在 OBS 加载 URL 之前为 false；模拟页面不提供，视为一直就绪。
   */
  readonly ready?: boolean;
  send(message: ToPage): void;
  onMessage(listener: (message: FromPage) => void): () => void;
}

export const StagePageService = defineService<PageLink>('stage-page', 1);

export interface SentenceInfo {
  id: string;
  subtitle: string;
  sampleRate: number;
}

/** 一句话的最终播放结果，以页面回报为准。 */
export interface PlaybackResult {
  sentenceId: string;
  played: number;
  complete: boolean;
  reason?: string;
}

export interface Stage {
  /**
   * 播放一句：只在许可令牌有效时转发音频，令牌失效即停止转发并要求页面截断。
   * 结果来自页面的回报；页面无响应时以 Stage 不可用结束。
   */
  play(
    sentence: SentenceInfo,
    audio: AsyncIterable<Int16Array>,
    token: number,
  ): Promise<PlaybackResult>;
  truncate(sentenceId: string): void;
  onEvent(listener: (event: FromPage) => void): () => void;
}

export const StageService = defineService<Stage>('stage', 1);
