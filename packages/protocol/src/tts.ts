import Type, { type Static } from 'typebox';

/**
 * 本地 TTS sidecar 的控制面消息（R-10、D-21）。
 *
 * 音频不走 JSON：sidecar 经通道的二进制帧送回，每帧是 4 字节大端流编号加 16 位有符号小端单声道 PCM；
 * 流编号由宿主在 `tts.synthesize` 中指定，用来把音频归到这次请求。`tts.synthesize` 的应答在这次合成的
 * 全部音频帧之后到达，标志流结束；中途取消用 `rpc.cancel`。
 */

const closed = { additionalProperties: false } as const;

export const TtsMethod = {
  /** 激活时查询一次：输出格式与后端。 */
  Info: 'tts.info',
  Synthesize: 'tts.synthesize',
} as const;

/** 音频帧帧首的流编号字节数。 */
export const TTS_STREAM_HEADER_BYTES = 4;

export const TtsInfoResult = Type.Object(
  {
    /** 输出 PCM 的采样率；单声道、16 位有符号小端。 */
    sampleRate: Type.Integer({ minimum: 8000, maximum: 48000 }),
    /** 合成后端，例如 `fake`。 */
    backend: Type.String({ pattern: '^[a-z][a-z0-9-]*$', maxLength: 32 }),
    /** sidecar 派生、随它一起退出的辅助进程（诊断用，演练时据此核对它们已退出）。 */
    processes: Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 64 }),
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
