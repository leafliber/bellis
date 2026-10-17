/**
 * S-01 的 OBS 录制分析：OBS 输出端是否断流、出现异常峰值或音高漂移。
 *   node spikes/s01-stage/analyze-recording.ts <录制文件> [--tone 440] [--segment-seconds 秒]
 * 用 ffmpeg 把第一条音轨解码成单声道 48kHz 浮点流，逐段处理，不整段读入内存。
 * 测试音是 0.2 振幅的正弦（约 -14dBFS）；录到的其他声音（系统提示音等）也会算进去，
 * 判读时对照探针时间线与桌面音频的音量表。
 *
 * 两种分析：
 * - 连续测试音（S-01 探针）：`analyzeRecording`，全程应当有声，任何无声段都是断流。
 * - 按句播出的测试音（真实宿主的模拟 TTS）：`analyzeSegments`，句与句之间本来就有空白，每句的相位从 0 开始。
 *   以不短于 1ms 的无声切分句段，逐段统计相位跳变（两端各 5ms 的编码振铃不计）与音高；时长与预期一句
 *   不符的句段即句内断流（一句被断成两段）、截断或两句之间没有空白。录制开头与结尾的句段可能不完整，
 *   单独标出、不计入不符。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SAMPLE_RATE = 48_000;
/** 低于这个振幅视为无声；正弦过零附近的无声段远短于 1ms。 */
const SILENCE = 0.005;
const GAP_MIN_SAMPLES = SAMPLE_RATE / 1000;
/** 测试音振幅 0.2，超过 0.5 视为异常峰值。 */
const SPIKE = 0.5;
/** 只在测试音确实存在时统计过零点：近期峰值低于这个值（静音、底噪）不计。 */
const TONE_FLOOR = 0.05;
const WINDOW_SECONDS = 10;
const MAX_LISTED = 200;
/** 句段两端不统计相位跳变的范围。 */
const EDGE_SAMPLES = (5 * SAMPLE_RATE) / 1000;

/** 把录制的第一条音轨解码成单声道 48kHz 浮点，逐块交给 onSamples。 */
async function decode(file: string, onSamples: (samples: Float32Array) => void): Promise<void> {
  const ffmpeg = spawn(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(SAMPLE_RATE)].concat([
      '-f',
      'f32le',
      'pipe:1',
    ]),
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  let stderr = '';
  ffmpeg.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  let carry: Buffer = Buffer.alloc(0);
  for await (const chunk of ffmpeg.stdout as AsyncIterable<Buffer>) {
    const data = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    const usable = data.length - (data.length % 4);
    const samples = new Float32Array(usable / 4);
    for (let i = 0; i < samples.length; i++) samples[i] = data.readFloatLE(i * 4);
    onSamples(samples);
    carry = data.subarray(usable);
  }
  const code = await new Promise<number | null>((done) => ffmpeg.once('close', done));
  if (code !== 0) throw new Error(`ffmpeg 失败（${code}）：${stderr.trim()}`);
}

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;
const cents = (hz: number, toneHz: number) => 1200 * Math.log2(hz / toneHz);

export interface RecordingAnalysis {
  file: string;
  seconds: number;
  gaps: { count: number; totalMs: number; listed: Array<{ atSeconds: number; ms: number }> };
  spikes: { count: number; listed: Array<{ atSeconds: number; value: number }> };
  /** 过零间隔偏离窗口中位数超过 1 个样本：相位跳变，断流或中途剪掉一段都会造成。 */
  discontinuities: { count: number; listed: Array<{ atSeconds: number; samples: number }> };
  /** 每个窗口的估计频率；窗口内有断流时仍会给出，判读时对照断流列表。 */
  windows: Array<{ atSeconds: number; hz: number | null; rms: number }>;
  hz: { min: number; max: number; maxCentsOff: number } | null;
}

export async function analyzeRecording(file: string, toneHz = 440): Promise<RecordingAnalysis> {
  let n = 0;
  let previous = 0;
  let silentRun = 0;
  /** 按样本衰减的近期峰值，半衰期约一个测试音周期。 */
  let peak = 0;
  const gaps: RecordingAnalysis['gaps'] = { count: 0, totalMs: 0, listed: [] };
  const spikes: RecordingAnalysis['spikes'] = { count: 0, listed: [] };
  const discontinuities: RecordingAnalysis['discontinuities'] = { count: 0, listed: [] };
  const windows: RecordingAnalysis['windows'] = [];
  let windowStart = 0;
  let lastCrossing: number | undefined;
  /** 窗口内相邻上升过零点的间隔（样本数）与其位置；取中位数估计频率，不受断流影响。 */
  let intervals: Array<[interval: number, at: number]> = [];
  let sumSquares = 0;

  const closeWindow = () => {
    const samples = n - windowStart;
    if (samples === 0) return;
    const sorted = intervals.map(([interval]) => interval).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const hz = median ? SAMPLE_RATE / median : null;
    if (median) {
      for (const [interval, at] of intervals) {
        if (Math.abs(interval - median) <= 1) continue;
        discontinuities.count += 1;
        if (discontinuities.listed.length < MAX_LISTED)
          discontinuities.listed.push({
            atSeconds: round(at / SAMPLE_RATE, 3),
            samples: round(interval, 1),
          });
      }
    }
    windows.push({
      atSeconds: windowStart / SAMPLE_RATE,
      hz: hz === null ? null : round(hz, 3),
      rms: round(Math.sqrt(sumSquares / samples), 4),
    });
    windowStart = n;
    intervals = [];
    sumSquares = 0;
  };
  const endGap = () => {
    if (silentRun >= GAP_MIN_SAMPLES) {
      gaps.count += 1;
      const ms = (silentRun * 1000) / SAMPLE_RATE;
      gaps.totalMs += ms;
      if (gaps.listed.length < MAX_LISTED)
        gaps.listed.push({ atSeconds: (n - silentRun) / SAMPLE_RATE, ms });
    }
    silentRun = 0;
  };

  await decode(file, (samples) => {
    for (const x of samples) {
      if (Math.abs(x) < SILENCE) silentRun += 1;
      else endGap();
      if (Math.abs(x) > SPIKE) {
        spikes.count += 1;
        if (spikes.listed.length < MAX_LISTED)
          spikes.listed.push({ atSeconds: n / SAMPLE_RATE, value: round(x, 3) });
      }
      peak = Math.max(Math.abs(x), peak * 0.995);
      if (previous < 0 && x >= 0 && peak > TONE_FLOOR) {
        // 上升过零点，线性插值到样本之间。
        const at = n - 1 + previous / (previous - x);
        if (lastCrossing !== undefined) intervals.push([at - lastCrossing, at]);
        lastCrossing = at;
      }
      sumSquares += x * x;
      previous = x;
      n += 1;
      if (n - windowStart >= WINDOW_SECONDS * SAMPLE_RATE) closeWindow();
    }
  });
  endGap();
  closeWindow();

  // 只用基本是测试音的窗口估计音高：频率在 ±5% 内。
  const tonal = windows
    .map((w) => w.hz)
    .filter((hz): hz is number => hz !== null && Math.abs(hz / toneHz - 1) < 0.05);
  return {
    file,
    seconds: n / SAMPLE_RATE,
    gaps,
    spikes,
    discontinuities,
    windows,
    hz:
      tonal.length === 0
        ? null
        : {
            min: Math.min(...tonal),
            max: Math.max(...tonal),
            maxCentsOff: round(Math.max(...tonal.map((hz) => Math.abs(cents(hz, toneHz)))), 3),
          },
  };
}

export interface Segment {
  atSeconds: number;
  seconds: number;
  hz: number | null;
  rms: number;
  /** 段内过零间隔偏离本段中位数超过 1 个样本的次数。 */
  discontinuities: number;
  /** 录制开头或结尾的句段，可能不完整。 */
  edge: boolean;
}

export interface SegmentAnalysis {
  file: string;
  seconds: number;
  toneHz: number;
  /** 预期一句的时长；不给时不判断时长是否相符。 */
  expectedSeconds: number | null;
  toleranceMs: number;
  segments: { count: number; listed: Segment[] };
  /** 句段之间的空白。 */
  gaps: { count: number; minMs: number | null; p50Ms: number | null; maxMs: number | null };
  /** 时长与预期一句不符的句段（不含首尾）：句内断流、截断或两句之间没有空白都会造成。 */
  mismatched: { count: number; listed: Segment[] };
  spikes: { count: number; listed: Array<{ atSeconds: number; value: number }> };
  discontinuities: { count: number; listed: Array<{ atSeconds: number; samples: number }> };
  /** 各句段的音高（只用频率在 ±5% 内的句段）。 */
  hz: { min: number; max: number; maxCentsOff: number; segments: number } | null;
}

export interface SegmentOptions {
  toneHz?: number;
  expectedSeconds?: number;
  /** 句段时长与预期相差多少以内算相符，默认 10ms。 */
  toleranceMs?: number;
  /** 最后一段按不完整处理（录制以急停截断的一句收尾时）。 */
  trailingEdge?: boolean;
}

export async function analyzeSegments(
  file: string,
  options: SegmentOptions = {},
): Promise<SegmentAnalysis> {
  const toneHz = options.toneHz ?? 440;
  const toleranceMs = options.toleranceMs ?? 10;
  let n = 0;
  let previous = 0;
  let silentRun = 0;
  const segments: Segment[] = [];
  const gapMs: number[] = [];
  const spikes: SegmentAnalysis['spikes'] = { count: 0, listed: [] };
  const discontinuities: SegmentAnalysis['discontinuities'] = { count: 0, listed: [] };
  /** 当前句段：起点、平方和与相邻上升过零点的间隔（样本数）及其位置；无声中为 undefined。 */
  let current:
    | {
        start: number;
        sumSquares: number;
        lastCrossing: number | undefined;
        intervals: Array<[interval: number, at: number]>;
      }
    | undefined;
  let lastEnd: number | undefined;

  const closeSegment = (end: number) => {
    if (!current) return;
    const { start } = current;
    const samples = end - start;
    // 句首句尾是突起突止的，编码器在这里有振铃：两端各 5ms 内的过零间隔不计。
    const inner = current.intervals.filter(
      ([, at]) => at - start >= EDGE_SAMPLES && end - at >= EDGE_SAMPLES,
    );
    const sorted = inner.map(([interval]) => interval).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    let jumps = 0;
    if (median) {
      for (const [interval, at] of inner) {
        if (Math.abs(interval - median) <= 1) continue;
        jumps += 1;
        discontinuities.count += 1;
        if (discontinuities.listed.length < MAX_LISTED)
          discontinuities.listed.push({
            atSeconds: round(at / SAMPLE_RATE, 3),
            samples: round(interval, 1),
          });
      }
    }
    segments.push({
      atSeconds: round(current.start / SAMPLE_RATE, 3),
      seconds: round(samples / SAMPLE_RATE, 4),
      hz: median ? round(SAMPLE_RATE / median, 3) : null,
      rms: round(Math.sqrt(current.sumSquares / Math.max(1, samples)), 4),
      discontinuities: jumps,
      edge: current.start === 0,
    });
    lastEnd = end;
    current = undefined;
  };

  await decode(file, (samples) => {
    for (const x of samples) {
      if (Math.abs(x) < SILENCE) {
        silentRun += 1;
        // 无声满 1ms 才算句段结束；结束点是这段无声的起点。
        if (current && silentRun >= GAP_MIN_SAMPLES) closeSegment(n - silentRun + 1);
      } else {
        if (!current) {
          if (lastEnd !== undefined) gapMs.push(((n - lastEnd) * 1000) / SAMPLE_RATE);
          current = { start: n, sumSquares: 0, lastCrossing: undefined, intervals: [] };
        }
        silentRun = 0;
      }
      if (Math.abs(x) > SPIKE) {
        spikes.count += 1;
        if (spikes.listed.length < MAX_LISTED)
          spikes.listed.push({ atSeconds: round(n / SAMPLE_RATE, 3), value: round(x, 3) });
      }
      if (current) {
        current.sumSquares += x * x;
        if (previous < 0 && x >= 0) {
          const at = n - 1 + previous / (previous - x);
          if (current.lastCrossing !== undefined)
            current.intervals.push([at - current.lastCrossing, at]);
          current.lastCrossing = at;
        }
      }
      previous = x;
      n += 1;
    }
  });
  // 录制结束时仍在句中，或调用方知道最后一句被截断（例如以急停收尾）：最后一段不完整。
  const cutAtEnd = current !== undefined || options.trailingEdge === true;
  closeSegment(n - (current ? silentRun : 0));
  const last = segments.at(-1);
  if (last && cutAtEnd) last.edge = true;

  const expected = options.expectedSeconds;
  const mismatched =
    expected === undefined
      ? []
      : segments.filter(
          (segment) => !segment.edge && Math.abs(segment.seconds - expected) * 1000 > toleranceMs,
        );
  const tonal = segments
    .map((segment) => segment.hz)
    .filter((hz): hz is number => hz !== null && Math.abs(hz / toneHz - 1) < 0.05);
  const sortedGaps = [...gapMs].sort((a, b) => a - b);
  return {
    file,
    seconds: n / SAMPLE_RATE,
    toneHz,
    expectedSeconds: expected ?? null,
    toleranceMs,
    segments: { count: segments.length, listed: segments },
    gaps: {
      count: sortedGaps.length,
      minMs: sortedGaps.length ? round(sortedGaps[0] as number, 2) : null,
      p50Ms: sortedGaps.length
        ? round(sortedGaps[Math.floor(sortedGaps.length / 2)] as number, 2)
        : null,
      maxMs: sortedGaps.length ? round(sortedGaps.at(-1) as number, 2) : null,
    },
    mismatched: { count: mismatched.length, listed: mismatched.slice(0, MAX_LISTED) },
    spikes,
    discontinuities,
    hz:
      tonal.length === 0
        ? null
        : {
            min: Math.min(...tonal),
            max: Math.max(...tonal),
            maxCentsOff: round(Math.max(...tonal.map((hz) => Math.abs(cents(hz, toneHz)))), 3),
            segments: tonal.length,
          },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      tone: { type: 'string', default: '440' },
      'segment-seconds': { type: 'string' },
    },
  });
  const file = positionals[0];
  if (!file)
    throw new Error('用法：analyze-recording.ts <录制文件> [--tone 440] [--segment-seconds 秒]');
  const toneHz = Number(values.tone);
  if (values['segment-seconds'] !== undefined) {
    const result = await analyzeSegments(file, {
      toneHz,
      expectedSeconds: Number(values['segment-seconds']),
    });
    console.log(
      JSON.stringify(
        { ...result, segments: { count: result.segments.count, listed: undefined } },
        null,
        2,
      ),
    );
  } else {
    const result = await analyzeRecording(file, toneHz);
    console.log(JSON.stringify({ ...result, windows: result.windows.length }, null, 2));
  }
}
