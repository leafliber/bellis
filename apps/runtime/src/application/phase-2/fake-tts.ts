import type { SpeechProvider } from "../performance/speech-provider.js";
import {
  PHASE_2_PCM_BYTES_PER_SAMPLE,
  PHASE_2_PCM_CHANNELS,
  PHASE_2_PCM_FRAME_BYTES,
  PHASE_2_PCM_FRAME_DURATION_US,
  PHASE_2_PCM_SAMPLES_PER_FRAME,
  PHASE_2_PCM_SAMPLE_RATE_HZ,
  type SpeechIntent,
} from "@bellis/contracts";

/**
 * 确定性 Fake TTS（docs/phase-2-development-guide.md §8.1）。
 *
 * - 输入只接受 SpeechIntent（单一发言来源）；输出固定 PCM 基线格式
 *   （48kHz/mono/S16LE）与词边界时间标记；
 * - 波形、时长与分块对相同输入逐字节确定（FNV-1a 派生相位，无随机源、
 *   无墙钟）；验证调度、背压、取消与播放，不评价音质；
 * - 不把 PCM、全文或敏感输入写入日志（调用方负责）。
 *
 * 合成规则（冻结，改变输出需同步测试黄金样本）：
 * - 每字符 160ms 发音 + 句尾 240ms 静音（最少 480ms）；
 * - 基频 = 180 + (字符码 mod 12) × 20 Hz，按字符分段的正弦 + 固定包络，
 *   相位由全文本哈希决定，样本级可重放。
 */

export interface FakeTtsResult {
  /** 完整 PCM（S16LE/48k/mono），长度恒为帧对齐（20ms 的整数倍）。 */
  readonly pcm: Uint8Array;
  readonly durationUs: bigint;
  /** 词（按空白切分）边界微秒，长度 = 词数。 */
  readonly wordStartOffsetsUs: readonly bigint[];
  readonly frameCount: number;
}

const MS_PER_CHAR = 160;
const TAIL_SILENCE_MS = 240;
const MIN_TOTAL_MS = 480;

function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function charDurationMs(code: number): number {
  // CJK 全宽字符按 1.5 倍时长（确定性：只依赖码点）。
  return code >= 0x2e80 ? MS_PER_CHAR * 1.5 : MS_PER_CHAR;
}

export function synthesizeSpeech(speech: SpeechIntent): FakeTtsResult {
  const text = speech.text;
  const segments: { startMs: number; durationMs: number; frequencyHz: number }[] = [];
  let cursorMs = 0;
  const wordStarts: number[] = [];
  let inWord = false;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const isWhitespace = /\s/.test(char);
    if (isWhitespace) {
      inWord = false;
      cursorMs += 40; // 词间短停顿
      continue;
    }
    if (!inWord) {
      wordStarts.push(cursorMs);
      inWord = true;
    }
    segments.push({
      startMs: cursorMs,
      durationMs: charDurationMs(code),
      frequencyHz: 180 + (code % 12) * 20,
    });
    cursorMs += charDurationMs(code);
  }
  const totalMs = Math.max(MIN_TOTAL_MS, cursorMs + TAIL_SILENCE_MS);
  const frameCount = Math.ceil(totalMs / 20);
  const totalSamples = frameCount * PHASE_2_PCM_SAMPLES_PER_FRAME;
  const pcm = new Uint8Array(totalSamples * PHASE_2_PCM_BYTES_PER_SAMPLE * PHASE_2_PCM_CHANNELS);
  const phase = (fnv1a32(text) % 1000) / 1000;
  const view = new DataView(pcm.buffer);

  for (const segment of segments) {
    const startSample = Math.floor((segment.startMs * PHASE_2_PCM_SAMPLE_RATE_HZ) / 1000);
    const samples = Math.floor((segment.durationMs * PHASE_2_PCM_SAMPLE_RATE_HZ) / 1000);
    for (let i = 0; i < samples; i += 1) {
      const index = startSample + i;
      if (index >= totalSamples) {
        break;
      }
      // 固定梯形包络（10ms 起落），幅度 -12dBFS。
      const t = i / samples;
      const envelope = Math.min(1, t / 0.15, (1 - t) / 0.15) * 0.25;
      const angle = 2 * Math.PI * segment.frequencyHz * (i / PHASE_2_PCM_SAMPLE_RATE_HZ) + phase;
      const value = Math.round(Math.sin(angle) * envelope * 32767);
      view.setInt16(index * PHASE_2_PCM_BYTES_PER_SAMPLE, value, true);
    }
  }

  return {
    pcm,
    durationUs: BigInt(frameCount) * PHASE_2_PCM_FRAME_DURATION_US,
    wordStartOffsetsUs: wordStarts.map((ms) => BigInt(ms) * 1000n),
    frameCount,
  };
}

/** 按帧切片（只读视图，不复制）。 */
export function frameAt(result: FakeTtsResult, frameIndex: number): Uint8Array | null {
  if (frameIndex < 0 || frameIndex >= result.frameCount) {
    return null;
  }
  const start = frameIndex * PHASE_2_PCM_FRAME_BYTES;
  return result.pcm.subarray(start, start + PHASE_2_PCM_FRAME_BYTES);
}

export const FAKE_TTS_FRAME_BYTES = PHASE_2_PCM_FRAME_BYTES;

/** Lazy demo generator: one frame allocated at a time, identical to buffered fixtures. */
export const fakeSpeechProvider: SpeechProvider = {
  async *stream(speech, signal) {
    const segments: { start: number; length: number; frequency: number }[] = [];
    let cursorMs = 0;
    for (const char of speech.text) {
      const code = char.codePointAt(0) ?? 0;
      if (/\s/.test(char)) {
        cursorMs += 40;
        continue;
      }
      const durationMs = charDurationMs(code);
      segments.push({
        start: Math.floor(cursorMs * 48),
        length: Math.floor(durationMs * 48),
        frequency: 180 + (code % 12) * 20,
      });
      cursorMs += durationMs;
    }
    const frameCount = Math.ceil(Math.max(MIN_TOTAL_MS, cursorMs + TAIL_SILENCE_MS) / 20);
    const phase = (fnv1a32(speech.text) % 1000) / 1000;
    let segmentIndex = 0;
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      signal.throwIfAborted();
      const bytes = new Uint8Array(PHASE_2_PCM_FRAME_BYTES);
      const view = new DataView(bytes.buffer);
      const firstSample = frameIndex * PHASE_2_PCM_SAMPLES_PER_FRAME;
      for (let offset = 0; offset < PHASE_2_PCM_SAMPLES_PER_FRAME; offset += 1) {
        const sample = firstSample + offset;
        while (
          segments[segmentIndex] !== undefined &&
          sample >= segments[segmentIndex]!.start + segments[segmentIndex]!.length
        )
          segmentIndex += 1;
        const segment = segments[segmentIndex];
        if (segment === undefined || sample < segment.start) continue;
        const i = sample - segment.start;
        const t = i / segment.length;
        const envelope = Math.min(1, t / 0.15, (1 - t) / 0.15) * 0.25;
        const angle = 2 * Math.PI * segment.frequency * (i / PHASE_2_PCM_SAMPLE_RATE_HZ) + phase;
        view.setInt16(offset * 2, Math.round(Math.sin(angle) * envelope * 32767), true);
      }
      yield bytes;
    }
  },
};
