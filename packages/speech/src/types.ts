import { defineExtension, defineService } from '@bellis/kernel';

/** 发声请求的来源，由确定性代码按触发来源填写，决策模型不能指定（D-33）。 */
export type SpeechSource =
  | 'safety'
  | 'vote-result'
  | 'scheduled'
  | 'game-reaction'
  | 'danmaku-reply'
  | 'chatter';

/** 优先级从高到低：安全播报、投票结果、定时播报、游戏关键反应、弹幕回复、闲聊。 */
export const PRIORITY: Readonly<Record<SpeechSource, number>> = {
  safety: 6,
  'vote-result': 5,
  scheduled: 4,
  'game-reaction': 3,
  'danmaku-reply': 2,
  chatter: 1,
};

/** 可以抢占正在进行的发言的来源；弹幕回复与闲聊只能排队或过期。 */
export const PREEMPTING: ReadonlySet<SpeechSource> = new Set([
  'safety',
  'vote-result',
  'scheduled',
  'game-reaction',
]);

export interface SpeechRequest {
  /** 去重键：同一件事不重复说。 */
  id: string;
  source: SpeechSource;
  /** 文本，可以是流（决策模型边生成边送入）。 */
  text: string | AsyncIterable<string>;
  /** 时钟上的过期时刻，过期即丢弃。 */
  expiresAt: number;
  /** 这段发言允许在哪里被抢占：句边界或立即。 */
  preempt: 'sentence' | 'immediate';
  /** 产生它的输入（例如弹幕编号），用于意图来源。 */
  inputs: readonly string[];
  /** 是否混入了不可信输入。 */
  untrusted: boolean;
}

export type UtteranceEnd =
  | 'complete'
  | 'expired'
  | 'duplicate'
  | 'preempted'
  | 'stopped'
  | 'denied'
  | 'unavailable';

/** 一段发言的结果：只记录观众实际听到的部分。 */
export interface UtteranceOutcome {
  id: string;
  source: SpeechSource;
  /** 观众实际听到的字幕文本。 */
  heard: string;
  /** 最后一句在中途被打断且没有时间映射时为 true：只知道被打断，不猜具体位置。 */
  interruptedMidSentence: boolean;
  end: UtteranceEnd;
  reason?: string;
  skipped: Array<{ index: number; reason: string }>;
}

export interface Speech {
  request(request: SpeechRequest): Promise<UtteranceOutcome>;
  /** 软收尾：不再开始新的句子，当前句播完即止，撤销尚未播出的句子。 */
  softStop(reason: string): void;
  /** 观众实际听到的近期发言（供决策模型上下文使用）。 */
  heard(): readonly UtteranceOutcome[];
}

export const SpeechService = defineService<Speech>('speech', 1);

/** 一句话的两份文本。`align[i]` 是朗读文本第 i 个码点对应的字幕文本码点下标。 */
export interface Sentence {
  index: number;
  subtitle: string;
  spoken: string;
  align: readonly number[];
}

export interface PreCheckInput {
  utteranceId: string;
  source: SpeechSource;
  sentence: Sentence;
  /** 上一句的字幕文本，作为判定的上下文。 */
  previous: string | undefined;
}

/** 发声前检查只能放行（弃权）或拦下。 */
export type PreCheckVerdict = { block: string };

/** 发声前检查扩展点（串行）：审核插件启用时注册在这里（D-18）。 */
export const PreCheck = defineExtension<'serial', PreCheckInput, PreCheckVerdict>(
  'speech.pre-check',
  'serial',
);

export interface Synthesis {
  sampleRate: number;
  /** 这一句合成后的总采样数；流式合成时未知则为 undefined。 */
  totalSamples: number | undefined;
  /** 采样偏移 → 朗读文本码点下标，按采样偏移递增；没有映射时为 undefined。 */
  timing: ReadonlyArray<{ sample: number; char: number }> | undefined;
  frames: AsyncIterable<Int16Array>;
}

export interface Tts {
  synthesize(spoken: string, signal: AbortSignal): Promise<Synthesis>;
}

export const TtsService = defineService<Tts>('tts', 1);

/** 审核插件在启用时提供的服务；仲裁据此确认审核确实在场。 */
export interface ModerationStatus {
  readonly onError: 'skip' | 'pass';
}

export const ModerationService = defineService<ModerationStatus>('moderation', 1);
