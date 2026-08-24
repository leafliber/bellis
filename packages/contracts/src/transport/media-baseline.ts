/**
 * Phase 2 媒体格式基线（docs/phase-2-development-guide.md §5.4，ADR 0003）。
 *
 * Phase 2 只要求一种可测试音频格式：48 kHz、mono、signed 16-bit
 * little-endian PCM，20 ms 一帧。该 contentType 字符串在 P0 冻结；
 * Stage Capabilities 的 audio.contentTypes 必须包含它才能宣告 Audio Lane。
 *
 * Fake TTS 产出的确定性波形验证调度、背压、取消与播放，不评价音质。
 * 压缩编码、重采样矩阵或真实 Provider 专用格式必须另立 ADR。
 */
export const PHASE_2_PCM_CONTENT_TYPE = "audio/pcm-s16le-48000-mono";

export const PHASE_2_PCM_SAMPLE_RATE_HZ = 48_000;

export const PHASE_2_PCM_CHANNELS = 1;

/** 每样本 2 字节（signed 16-bit little-endian）。 */
export const PHASE_2_PCM_BYTES_PER_SAMPLE = 2;

/** 每帧 20 ms = 960 样本。 */
export const PHASE_2_PCM_SAMPLES_PER_FRAME = 960;

export const PHASE_2_PCM_FRAME_DURATION_US = 20_000;

/** 960 样本 × 2 字节 = 1920 字节。 */
export const PHASE_2_PCM_FRAME_BYTES = PHASE_2_PCM_SAMPLES_PER_FRAME * PHASE_2_PCM_BYTES_PER_SAMPLE;
