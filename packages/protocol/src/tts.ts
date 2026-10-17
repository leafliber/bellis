import Type, { type Static } from 'typebox';

/**
 * 本地 TTS sidecar 的控制面消息（R-10、R-11、D-21）。
 *
 * - 握手（`sidecar.describe`、`sidecar.health`）立即完成；模型在 sidecar 里后台加载，
 *   `tts.info` 报告当前状态，状态变化时 sidecar 发 `tts.status` 通知。
 * - 音频不走 JSON：sidecar 经通道的二进制帧送回，每帧是 4 字节大端流编号加 16 位有符号小端单声道 PCM；
 *   流编号由宿主在 `tts.synthesize` 中指定，用来把音频归到这次请求。
 * - 强制对齐的字级时间戳经 `tts.words` 通知送回（这一句目前已知的全部时间戳，整体替换上一次）。
 * - `tts.synthesize` 的应答在这次合成的全部音频帧与时间戳之后到达，标志流结束；中途取消用 `rpc.cancel`。
 */

const closed = { additionalProperties: false } as const;

export const TtsMethod = {
  /** 激活时查询一次：后端、派生的辅助进程与模型状态。 */
  Info: 'tts.info',
  Synthesize: 'tts.synthesize',
  /** 通知（sidecar → 宿主）：模型状态变化。 */
  Status: 'tts.status',
  /** 通知（sidecar → 宿主）：一句的字级时间戳。 */
  Words: 'tts.words',
} as const;

/** 音频帧帧首的流编号字节数。 */
export const TTS_STREAM_HEADER_BYTES = 4;

/** 模型尚未就绪时 `tts.synthesize` 返回的错误码（JSON-RPC 的服务端保留区间）。 */
export const TTS_NOT_READY = -32001;

export const TtsStatus = Type.Object(
  {
    /** `loading`：模型加载中；`ready`：可以合成；`failed`：加载失败，不会再变化。 */
    state: Type.Union([Type.Literal('loading'), Type.Literal('ready'), Type.Literal('failed')]),
    detail: Type.Optional(Type.String({ maxLength: 200 })),
    /** 输出 PCM 的采样率（单声道、16 位有符号小端）；就绪后才有。 */
    sampleRate: Type.Optional(Type.Integer({ minimum: 8000, maximum: 48000 })),
  },
  closed,
);
export type TtsStatus = Static<typeof TtsStatus>;

export const TtsInfoResult = Type.Object(
  {
    /** 合成后端，例如 `fake`、`qwen3`。 */
    backend: Type.String({ pattern: '^[a-z][a-z0-9-]*$', maxLength: 32 }),
    /** sidecar 派生、随它一起退出的辅助进程（诊断用，演练时据此核对它们已退出）。 */
    processes: Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 64 }),
    status: TtsStatus,
  },
  closed,
);
export type TtsInfoResult = Static<typeof TtsInfoResult>;

export const TtsSynthesizeParams = Type.Object(
  {
    stream: Type.Integer({ minimum: 1, maximum: 0xffff_ffff }),
    /** 一句的朗读文本（已规范化）。按句合成，长度有上限，宿主为每个流缓冲的音频也就有上限。 */
    text: Type.String({ minLength: 1, maxLength: 500 }),
  },
  closed,
);
export type TtsSynthesizeParams = Static<typeof TtsSynthesizeParams>;

export const TtsSynthesizeResult = Type.Object(
  {
    /** 这次合成送出的总采样数，宿主据此核对没有丢帧。 */
    samples: Type.Integer({ minimum: 0 }),
  },
  closed,
);
export type TtsSynthesizeResult = Static<typeof TtsSynthesizeResult>;

/** 一个字或词的时间戳：相对这一句音频开头的毫秒。 */
export const TtsWord = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: 64 }),
    startMs: Type.Number({ minimum: 0 }),
    endMs: Type.Number({ minimum: 0 }),
  },
  closed,
);
export type TtsWord = Static<typeof TtsWord>;

export const TtsWordsParams = Type.Object(
  {
    stream: Type.Integer({ minimum: 1, maximum: 0xffff_ffff }),
    words: Type.Array(TtsWord, { maxItems: 500 }),
  },
  closed,
);
export type TtsWordsParams = Static<typeof TtsWordsParams>;
