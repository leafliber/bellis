/**
 * Stage 服务与 OBS 浏览器源中的页面之间的线上格式（R-08）。
 *
 * 文本消息是 JSON，`kind` 与 `ToPage` / `FromPage` 一致，另加认证用的 hello、resume、welcome。
 * 音频是二进制消息：2 字节大端的头长度 + UTF-8 JSON 头（句编号与许可令牌）+ 16 位小端 PCM。
 * 页面是半可信的：认证过，但它发来的每条消息仍按下面的 Schema 校验，不合格即断开。
 * 发给页面的字幕映射（`PageTiming`）的内容来自 TTS 提供方，Stage 服务发送前同样按 Schema 校验。
 */
import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';

const closed = { additionalProperties: false } as const;
const SentenceId = Type.String({ minLength: 1, maxLength: 200 });
const Played = Type.Integer({ minimum: 0 });

/**
 * 页面的首条消息：出示 URL 片段里的一次性令牌，附带 OBS 与浏览器内核的版本。
 * 页面刷新后片段已被去掉，没有令牌时 token 为 null，宿主据此重新下发 URL。
 */
export const PageHello = Type.Object(
  {
    kind: Type.Literal('hello'),
    token: Type.Union([Type.String({ pattern: '^[A-Za-z0-9_-]{22}$' }), Type.Null()]),
    /** `window.obsstudio.pluginVersion`，不在 OBS 中时为 null。 */
    obs: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
    userAgent: Type.String({ maxLength: 512 }),
    sampleRate: Type.Number({ minimum: 1 }),
  },
  closed,
);
export type PageHello = Static<typeof PageHello>;

/** 连接断开后，页面用内存里的会话密钥重连；页面刷新后密钥即丢失，只能等宿主重新下发 URL。 */
export const PageResume = Type.Object(
  { kind: Type.Literal('resume'), sessionKey: Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' }) },
  closed,
);
export type PageResume = Static<typeof PageResume>;

export const PageFirst = Type.Union([PageHello, PageResume]);
export type PageFirst = Static<typeof PageFirst>;

/** 认证后页面发来的消息，与 `FromPage` 一一对应。 */
export const PageEvent = Type.Union([
  Type.Object({ kind: Type.Literal('started'), sentenceId: SentenceId }, closed),
  Type.Object({ kind: Type.Literal('cursor'), sentenceId: SentenceId, played: Played }, closed),
  Type.Object({ kind: Type.Literal('underrun'), sentenceId: SentenceId, played: Played }, closed),
  Type.Object({ kind: Type.Literal('ended'), sentenceId: SentenceId, played: Played }, closed),
  Type.Object(
    {
      kind: Type.Literal('truncated'),
      sentenceId: SentenceId,
      played: Played,
      reason: Type.String({ maxLength: 200 }),
    },
    closed,
  ),
  Type.Object({ kind: Type.Literal('muted'), reason: Type.String({ maxLength: 200 }) }, closed),
  Type.Object({ kind: Type.Literal('heartbeat-ack') }, closed),
]);
export type PageEvent = Static<typeof PageEvent>;

export const isPageFirst = Compile(PageFirst);
export const isPageEvent = Compile(PageEvent);

/** 呈现延迟的上限（毫秒）。 */
export const MAX_PRESENTATION_DELAY_MS = 300;

/**
 * 宿主发给页面的呈现延迟（Stage 文档“对齐”）：页面把字幕按播放游标推进的时刻整体推迟这么多毫秒，
 * 播完后的清除同样推迟；截断、令牌变化与自静音仍立即清除。Stage 服务发送前按此校验。
 */
export const PagePresentation = Type.Object(
  {
    kind: Type.Literal('presentation'),
    delayMs: Type.Integer({ minimum: 0, maximum: MAX_PRESENTATION_DELAY_MS }),
  },
  closed,
);
export type PagePresentation = Static<typeof PagePresentation>;
export const isPagePresentation = Compile(PagePresentation);

/** 页面 AudioContext 的 latencyHint：缺省 interactive，playback 留作退路（见 stage-page-obs）。 */
export const LatencyHint = Type.Union([Type.Literal('playback'), Type.Literal('interactive')]);
export type LatencyHint = Static<typeof LatencyHint>;

const Seconds = Type.Union([Type.Number({ minimum: 0, maximum: 1e9 }), Type.Null()]);
const Millis = Type.Union([Type.Number({ minimum: -1e12, maximum: 1e12 }), Type.Null()]);

/**
 * 诊断（缺省关闭，见 stage-page-obs 的 statsEveryMs）：页面按间隔回报浏览器自报的音频输出时延，
 * 供音画对齐的实验与录像实测对照。只记日志，不转给 Stage 服务，与 `FromPage` 无关。
 * 时间都是页面自己的：AudioContext 的秒与 performance.now() 的毫秒；浏览器不提供的为 null。
 */
export const PageStats = Type.Object(
  {
    kind: Type.Literal('stats'),
    latencyHint: LatencyHint,
    sampleRate: Type.Number({ minimum: 1 }),
    baseLatency: Seconds,
    outputLatency: Seconds,
    /** AudioContext.currentTime：已渲染到的位置。 */
    currentTime: Type.Number({ minimum: 0, maximum: 1e9 }),
    /** getOutputTimestamp()：正由输出设备呈现的那一帧在 AudioContext 时间线上的位置与呈现时刻。 */
    outputContextTime: Seconds,
    outputPerformanceTime: Millis,
    performanceNow: Type.Number({ minimum: 0, maximum: 1e12 }),
  },
  closed,
);
export type PageStats = Static<typeof PageStats>;
export const isPageStats = Compile(PageStats);

/** 一句字幕映射的码点数上限；分句每句不超过 60 个码点，本地 TTS 每句不超过 500 个朗读码点。 */
export const MAX_SUBTITLE_CHARS = 1000;

/**
 * 宿主发给页面的字幕时间映射（文本消息）：字幕文本第 k 个码点从这一句的第 `starts[k]` 个原始采样开始显示，
 * 按 k 不减；可以比字幕的码点少，映射还没覆盖到的码点暂不显示。映射有变化时整份重发。
 * 规则见 Stage 文档的“字幕”；Stage 服务发送前按此校验，只为令牌有效、还在 Stage 上的句子发送。
 */
export const PageTiming = Type.Object(
  {
    kind: Type.Literal('timing'),
    sentenceId: SentenceId,
    token: Type.Integer({ minimum: 0 }),
    starts: Type.Array(Played, { maxItems: MAX_SUBTITLE_CHARS }),
  },
  closed,
);
export type PageTiming = Static<typeof PageTiming>;
export const isPageTiming = Compile(PageTiming);

/** 宿主认证页面后的答复；会话密钥只存在页面内存里。 */
export interface Welcome {
  kind: 'welcome';
  sessionKey: string;
}

export interface AudioHeader {
  sentenceId: string;
  token: number;
}

/** 编码一帧音频。 */
export function encodeAudio(header: AudioHeader, pcm: Int16Array): Buffer {
  const head = Buffer.from(JSON.stringify(header), 'utf8');
  const frame = Buffer.alloc(2 + head.length + pcm.length * 2);
  frame.writeUInt16BE(head.length, 0);
  head.copy(frame, 2);
  for (let i = 0; i < pcm.length; i++)
    frame.writeInt16LE(pcm[i] as number, 2 + head.length + i * 2);
  return frame;
}
