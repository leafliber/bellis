/**
 * 字幕、口型与音频偏差的录像分析（P1 出口“字幕、口型与音频的偏差在 OBS 录制中实测”）。
 *
 *   node spikes/av-offset/analyze.ts <录像> --mode tone|speech --subtitle x,y,w,h --mouth-search x,y,w,h
 *        [--exclude x,y,w,h]… [--out 结果.json] [--debug-dir 目录]
 *
 * 区域是录像画面的像素。只看录像本身：画面与音轨都是 OBS 混好、观众看到的样子，不需要对齐宿主的时钟。
 *
 * - 音频：每句的出声与结束时刻。测试音（tone）用 S-01 的分析器按句段切分（440Hz、振幅 0.05 以上），
 *   精确到 1ms；真实语音（speech）按 10ms 窗的 RMS 高于 -40dBFS 切分，句内短于 350ms 的停顿并入同一句。
 *   音轨按录像时间线对齐（见 DecodeOptions.timeline），与画面帧的时间戳同一个原点。
 * - 字幕：字幕带内每帧“与无字幕参考帧相差超过 32 级亮度的像素占比”。参考帧取句间安静时段（离任何句段
 *   0.4 秒以上）的帧逐像素取中位数。每句按句前安静时的占比（关）与句中占比（开）定阈值：
 *   第一次超过 10% 的帧为“出现”，超过 90% 的帧为“显示完”，之后第一次低于 50% 的帧为“清除”。
 *   Stage 页面现在整句一次显示（started 时显示、ended 时清空），出现与显示完应当是同一帧。
 * - 口型：在形象区域里找对口型最敏感的像素。由录音按形象插件的映射（20ms RMS，下限 0.01、上限 0.2，
 *   线性映射到 0–1）算出“应有的嘴型”，先按块（块均值）与它在几个时延上求相关，定出嘴部附近，
 *   再在那一小块里逐像素求相关，取相关最强的像素合成嘴型信号（正为张开）。每句：
 *   张开 = 越过句前闭合与句中张开水平之间 50% 的第一帧；闭合 = 句尾之后越过 50% 回落的第一帧；
 *   时延 = 嘴型信号与“应有的嘴型”的归一化互相关在 -300…+500ms 内的峰值（2ms 步长，平顶取中点）。
 *
 * 帧时刻取 ffmpeg 解码后每帧的显示时间戳（showinfo），即观众看到这一帧的时刻。字幕出现等“第一帧”类的量
 * 是该帧时刻减去音频时刻：画面上的变化发生在这一帧与上一帧之间，所以单次测量的分辨率是一帧
 * （30fps 时 33.3ms），对“系统在何时改了画面”的估计有 0 到 1 帧的量化误差。互相关时延是连续量的估计，
 * 对阶跃（测试音）误差在半帧以内，对连续的包络（语音）更细。
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { constants, setPriority } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { analyzeSegments, decode } from '../s01-stage/analyze-recording.ts';
import { intersect, parseRect, type Rect } from './layout.ts';

const AUDIO_RATE = 48_000;
/** 字幕带里亮度差超过这么多级才算“变了”。 */
const SUBTITLE_DIFF = 32;
/** 离句段这么远（秒）才算安静，参考帧与闭合水平都从安静时段取。 */
const QUIET_MARGIN = 0.4;
/** 定位嘴部时试的时延（毫秒）。 */
const LOCATE_LAGS_MS = [-200, -100, 0, 100, 200, 300, 400];
/** 互相关时延的搜索范围与步长（毫秒）。 */
const LAG_RANGE_MS: readonly [number, number] = [-300, 500];
const LAG_STEP_MS = 2;
/** 第一轮按块定位时块的数目上限：块边长随搜索区域放大。 */
const LOCATE_BLOCKS = 20_000;
/** 第二轮逐像素的窗口边长上限（录像像素）。 */
const MOUTH_WINDOW = 96;
/**
 * 嘴部与“应有的嘴型”的相关至少这么强才算找到。合成反例里来回移动的彩色块偶然能到 0.26；
 * 合成的嘴在 0.95 左右。看过定位图确认无误时可以用 --min-mouth-r 放宽。
 */
const MIN_MOUTH_R = 0.5;
/** 与形象插件 avatar-vts 的缺省配置一致：RMS 下限、上限与包络窗口。 */
const MOUTH_MAPPING = { floor: 0.01, ceiling: 0.2, windowMs: 20 };

export type Mode = 'tone' | 'speech';

export interface AnalyzeOptions {
  mode: Mode;
  /** 字幕带；不给时不分析字幕。 */
  subtitle?: Rect;
  /** 找嘴部的范围；不给时不分析口型。 */
  mouthSearch?: Rect;
  /** 找嘴部时排除的范围（例如字幕带）。 */
  exclude?: Rect[];
  toneHz?: number;
  /** 嘴部的相关低于它即视为没找到（缺省 MIN_MOUTH_R）。 */
  minMouthR?: number;
  /** 写定位图的目录。 */
  debugDir?: string;
}

export interface VideoProbe {
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  videoStart: number | null;
  audioCodec: string | null;
  audioStart: number | null;
  duration: number;
}

export interface Summary {
  n: number;
  missing: number;
  min: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export interface SentenceResult {
  index: number;
  onset: number;
  end: number;
  seconds: number;
  /** 与上一句段之间的空白（毫秒）；第一句为 null。超过 1.5 秒时页面先放唤醒信号。 */
  gapBeforeMs: number | null;
  edge: boolean;
  subtitle: {
    firstVisibleMs: number | null;
    fullMs: number | null;
    clearedMs: number | null;
    contrast: number;
    note?: string;
  } | null;
  mouth: {
    openMs: number | null;
    openInterpMs: number | null;
    closeMs: number | null;
    closeInterpMs: number | null;
    lagMs: number | null;
    lagR: number | null;
    contrast: number;
    note?: string;
  } | null;
}

const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

function percentile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? null;
}

/** 样本数、缺失数与分位数（与其它演练的取法一致：第 floor(q·n) 个）。 */
export function summarize(values: ReadonlyArray<number | null>): Summary {
  const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const sorted = [...present].sort((a, b) => a - b);
  const r = (v: number | null) => (v === null ? null : round(v));
  return {
    n: sorted.length,
    missing: values.length - sorted.length,
    min: r(sorted[0] ?? null),
    p50: r(percentile(sorted, 0.5)),
    p95: r(percentile(sorted, 0.95)),
    p99: r(percentile(sorted, 0.99)),
    max: r(sorted.at(-1) ?? null),
  };
}

function median(values: readonly number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  return percentile(sorted, 0.5);
}

/** 稳健的标准差：中位数绝对偏差乘 1.4826。 */
function robustSd(values: readonly number[]): number {
  const m = median(values);
  if (m === null) return 0;
  return 1.4826 * (median(values.map((v) => Math.abs(v - m))) ?? 0);
}

/** 分析用的 ffmpeg 以低于正常的优先级运行，不和同机的实测抢 CPU。 */
function lowPriority(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // 设不了优先级不影响结果。
  }
}

function run(command: string, args: readonly string[]): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    lowPriority(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', fail);
    child.on('close', (code) =>
      code === 0 ? done(stdout) : fail(new Error(`${command} 失败（${code}）：${stderr.trim()}`)),
    );
  });
}

export async function probe(file: string): Promise<VideoProbe> {
  const out = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,start_time:format=duration',
    '-of',
    'json',
    file,
  ]);
  const parsed = JSON.parse(out) as {
    streams: Array<Record<string, string | number | undefined>>;
    format: { duration?: string };
  };
  const video = parsed.streams.find((s) => s.codec_type === 'video');
  const audio = parsed.streams.find((s) => s.codec_type === 'audio');
  if (!video) throw new Error('录像里没有视频流');
  const rate = (text: unknown) => {
    const [n, d] = String(text ?? '0/0')
      .split('/')
      .map(Number);
    return n && d ? n / d : 0;
  };
  const start = (value: unknown) => (value === undefined ? null : Number(value));
  return {
    width: Number(video.width),
    height: Number(video.height),
    fps: rate(video.avg_frame_rate) || rate(video.r_frame_rate),
    videoCodec: String(video.codec_name),
    videoStart: start(video.start_time),
    audioCodec: audio ? String(audio.codec_name) : null,
    audioStart: audio ? start(audio.start_time) : null,
    duration: Number(parsed.format.duration ?? 0),
  };
}

interface FrameGeometry {
  /** 实际裁出的范围（录像像素，宽高是块边长的整数倍）。 */
  rect: Rect;
  block: number;
  width: number;
  height: number;
  frames: number;
}

/**
 * 逐帧读出录像中一块区域的亮度（8 位），block 大于 1 时每个输出像素是 block×block 的块均值。
 * 帧按显示顺序交给 onFrame，附带显示时间戳（秒，录像时间线）。
 */
export async function readFrames(
  file: string,
  area: Rect,
  block: number,
  onFrame: (pts: number, pixels: Uint8Array) => void,
): Promise<FrameGeometry> {
  const b = Math.max(1, Math.floor(block));
  const width = Math.floor(area.w / b);
  const height = Math.floor(area.h / b);
  if (width < 1 || height < 1) throw new Error(`区域太小：${JSON.stringify(area)}`);
  const rect = { x: Math.round(area.x), y: Math.round(area.y), w: width * b, h: height * b };
  const filters = ['format=gray', `crop=${rect.w}:${rect.h}:${rect.x}:${rect.y}:exact=1`];
  if (b > 1) filters.push(`scale=${width}:${height}:flags=area`);
  filters.push('showinfo');
  const ffmpeg = spawn(
    'ffmpeg',
    [
      ...['-hide_banner', '-nostdin', '-nostats', '-v', 'info', '-threads', '2'],
      ...['-filter_threads', '1', '-i', file, '-map', '0:v:0', '-vf', filters.join(',')],
      ...['-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  lowPriority(ffmpeg);
  const closed = new Promise<number | null>((done, fail) => {
    ffmpeg.once('error', fail);
    ffmpeg.once('close', done);
  });
  // 启动失败时先记下，读完输出后再抛出。
  void closed.catch(() => undefined);
  const size = width * height;
  const pts: number[] = [];
  const pending: Uint8Array[] = [];
  let delivered = 0;
  const flush = () => {
    for (;;) {
      const at = pts[delivered];
      const frame = pending[0];
      if (at === undefined || frame === undefined) return;
      pending.shift();
      delivered += 1;
      onFrame(at, frame);
    }
  };
  const tail: string[] = [];
  createInterface({ input: ffmpeg.stderr }).on('line', (line) => {
    const m = /showinfo.*\bn:\s*(\d+)\s+pts:\s*-?\d+\s+pts_time:\s*(-?[\d.]+(?:e[-+]?\d+)?)/.exec(
      line,
    );
    if (m) {
      pts[Number(m[1])] = Number(m[2]);
      flush();
    } else if (!line.includes('showinfo')) {
      tail.push(line);
      if (tail.length > 30) tail.shift();
    }
  });
  let carry: Buffer = Buffer.alloc(0);
  for await (const chunk of ffmpeg.stdout as AsyncIterable<Buffer>) {
    const data = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    let offset = 0;
    while (data.length - offset >= size) {
      pending.push(new Uint8Array(data.subarray(offset, offset + size)));
      offset += size;
    }
    carry = Buffer.from(data.subarray(offset));
    flush();
  }
  const code = await closed;
  flush();
  if (code !== 0) throw new Error(`ffmpeg 失败（${code}）：${tail.join('\n')}`);
  if (pending.length > 0) throw new Error(`${pending.length} 帧没有拿到时间戳`);
  return { rect, block: b, width, height, frames: delivered };
}

/** 音轨（录像时间线）：每毫秒的平方和的前缀和，用来取任意时间窗的 RMS。 */
export interface AudioTrack {
  prefix: Float64Array;
  ms: number;
}

export async function audioTrack(file: string): Promise<AudioTrack> {
  const perMs = AUDIO_RATE / 1000;
  const bins: number[] = [];
  let sum = 0;
  let count = 0;
  await decode(
    file,
    (samples) => {
      for (const x of samples) {
        sum += x * x;
        count += 1;
        if (count === perMs) {
          bins.push(sum);
          sum = 0;
          count = 0;
        }
      }
    },
    { timeline: true },
  );
  const prefix = new Float64Array(bins.length + 1);
  for (let i = 0; i < bins.length; i++) prefix[i + 1] = (prefix[i] ?? 0) + (bins[i] ?? 0);
  return { prefix, ms: bins.length };
}

/** [from, to) 秒内的 RMS（相对满幅）。 */
export function rmsOf(track: AudioTrack, from: number, to: number): number {
  const a = Math.min(track.ms, Math.max(0, Math.round(from * 1000)));
  const b = Math.min(track.ms, Math.max(0, Math.round(to * 1000)));
  if (b <= a) return 0;
  const energy = (track.prefix[b] ?? 0) - (track.prefix[a] ?? 0);
  return Math.sqrt(Math.max(0, energy) / ((b - a) * (AUDIO_RATE / 1000)));
}

/** 按形象插件的映射，由录音算出 t 秒时“应有的嘴型”（0–1）。 */
export function expectedMouth(track: AudioTrack, t: number): number {
  const half = MOUTH_MAPPING.windowMs / 2000;
  const rms = rmsOf(track, t - half, t + half);
  const { floor, ceiling } = MOUTH_MAPPING;
  return Math.min(1, Math.max(0, (rms - floor) / (ceiling - floor)));
}

export interface AudioSegment {
  onset: number;
  end: number;
  /** 录像开头或结尾处的句段，可能不完整。 */
  edge: boolean;
}

async function toneSegments(file: string, toneHz: number): Promise<AudioSegment[]> {
  const analysis = await analyzeSegments(file, { toneHz, timeline: true });
  return analysis.segments.listed
    .filter((s) => s.seconds >= 0.1)
    .map((s) => ({ onset: s.atSeconds, end: round(s.atSeconds + s.seconds, 4), edge: s.edge }));
}

/** 语音按 10ms 窗的 RMS 切句：高于阈值为有声，短于 mergeMs 的停顿并入，短于 minMs 的丢弃。 */
export function speechSegments(
  track: AudioTrack,
  options: { thresholdDb?: number; mergeMs?: number; minMs?: number } = {},
): AudioSegment[] {
  const threshold = 10 ** ((options.thresholdDb ?? -40) / 20);
  const mergeMs = options.mergeMs ?? 350;
  const minMs = options.minMs ?? 200;
  const windowMs = 10;
  const runs: Array<[number, number]> = [];
  let start: number | undefined;
  for (let t = 0; t + windowMs <= track.ms; t++) {
    const voiced = rmsOf(track, t / 1000, (t + windowMs) / 1000) >= threshold;
    if (voiced && start === undefined) start = t;
    if (!voiced && start !== undefined) {
      runs.push([start, t - 1 + windowMs]);
      start = undefined;
    }
  }
  if (start !== undefined) runs.push([start, track.ms]);
  const merged: Array<[number, number]> = [];
  for (const run of runs) {
    const last = merged.at(-1);
    if (last && run[0] - last[1] < mergeMs) last[1] = run[1];
    else merged.push([run[0], run[1]]);
  }
  return merged
    .filter(([a, b]) => b - a >= minMs)
    .map(([a, b]) => ({ onset: a / 1000, end: b / 1000, edge: a === 0 || b >= track.ms }));
}

function quiet(t: number, segments: readonly AudioSegment[]): boolean {
  return !segments.some((s) => t >= s.onset - QUIET_MARGIN && t <= s.end + QUIET_MARGIN);
}

interface Track {
  times: number[];
  values: number[];
}

/** 时间在 [from, to] 内的帧的值。 */
function valuesIn(track: Track, from: number, to: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < track.times.length; k++) {
    const t = track.times[k] ?? 0;
    if (t >= from && t <= to) out.push(track.values[k] ?? 0);
  }
  return out;
}

function firstIndexAtOrAfter(track: Track, t: number): number {
  let lo = 0;
  let hi = track.times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((track.times[mid] ?? 0) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 在 [from, to] 内找第一次越过阈值的帧（上升或下降）：前一帧在阈值的另一侧。 */
function crossing(
  track: Track,
  from: number,
  to: number,
  threshold: number,
  rising: boolean,
): number | undefined {
  for (let k = Math.max(1, firstIndexAtOrAfter(track, from)); k < track.times.length; k++) {
    if ((track.times[k] ?? 0) > to) return undefined;
    const v = track.values[k] ?? 0;
    const before = track.values[k - 1] ?? 0;
    if (rising ? v >= threshold && before < threshold : v <= threshold && before > threshold)
      return k;
  }
  return undefined;
}

/** 越过阈值处在相邻两帧之间线性插值的时刻。 */
function interpolated(track: Track, k: number, threshold: number): number {
  const t1 = track.times[k] ?? 0;
  const t0 = track.times[k - 1] ?? t1;
  const v1 = track.values[k] ?? 0;
  const v0 = track.values[k - 1] ?? v1;
  if (v1 === v0) return t1;
  return t0 + ((threshold - v0) / (v1 - v0)) * (t1 - t0);
}

/** 字幕带每帧与参考帧相差的像素占比。 */
async function subtitleTrack(
  file: string,
  rect: Rect,
  segments: readonly AudioSegment[],
  video: VideoProbe,
): Promise<{ track: Track; referenceFrames: number }> {
  // 第一遍：隔帧留样，取安静时段的帧逐像素求中位数作参考。
  const estimate = Math.max(1, Math.round(video.duration * video.fps));
  const every = Math.max(1, Math.floor(estimate / 300));
  const kept: Array<{ pts: number; pixels: Uint8Array }> = [];
  let index = 0;
  const geometry = await readFrames(file, rect, 1, (pts, pixels) => {
    if (index % every === 0) kept.push({ pts, pixels });
    index += 1;
  });
  const calm = kept.filter((f) => quiet(f.pts, segments));
  if (calm.length < 3) throw new Error('录像里没有足够的安静帧作字幕参考');
  const step = Math.max(1, Math.floor(calm.length / 61));
  const chosen = calm.filter((_, i) => i % step === 0).slice(0, 61);
  const size = geometry.width * geometry.height;
  const reference = new Uint8Array(size);
  const column = new Uint8Array(chosen.length);
  for (let p = 0; p < size; p++) {
    for (let i = 0; i < chosen.length; i++) column[i] = chosen[i]?.pixels[p] ?? 0;
    column.sort();
    reference[p] = column[column.length >> 1] ?? 0;
  }
  // 第二遍：每帧变了的像素占比。
  const track: Track = { times: [], values: [] };
  await readFrames(file, rect, 1, (pts, pixels) => {
    let changed = 0;
    for (let p = 0; p < size; p++) {
      if (Math.abs((pixels[p] ?? 0) - (reference[p] ?? 0)) > SUBTITLE_DIFF) changed += 1;
    }
    track.times.push(pts);
    track.values.push(changed / size);
  });
  return { track, referenceFrames: chosen.length };
}

interface MouthTrack {
  track: Track;
  /** 第一轮定位用的块边长与最强块的相关、时延。 */
  locate: { block: number; r: number; lagMs: number; rect: Rect };
  /** 第二轮选中的像素范围（录像像素）与个数、最强的相关。 */
  rect: Rect;
  pixels: number;
  r: number;
}

/** 两轮定位嘴部并合成嘴型信号；找不到时返回原因。 */
async function mouthTrack(
  file: string,
  search: Rect,
  exclude: readonly Rect[],
  audio: AudioTrack,
  minR: number,
): Promise<MouthTrack | { error: string }> {
  // 第一轮：块均值与几个时延下“应有的嘴型”求相关。
  const block = Math.max(2, Math.ceil(Math.sqrt((search.w * search.h) / LOCATE_BLOCKS)));
  const lags = LOCATE_LAGS_MS.map((ms) => ms / 1000);
  const L = lags.length;
  let blocks = 0;
  let width = 0;
  let s1 = new Float64Array(0);
  let s2 = new Float64Array(0);
  let sx = new Float64Array(0);
  const gx = new Float64Array(L);
  const gxx = new Float64Array(L);
  const xs = new Float64Array(L);
  let n = 0;
  const geometry = await readFrames(file, search, block, (t, pixels) => {
    if (blocks === 0) {
      blocks = pixels.length;
      s1 = new Float64Array(blocks);
      s2 = new Float64Array(blocks);
      sx = new Float64Array(blocks * L);
    }
    for (let l = 0; l < L; l++) {
      const x = expectedMouth(audio, t - (lags[l] ?? 0));
      xs[l] = x;
      gx[l] = (gx[l] ?? 0) + x;
      gxx[l] = (gxx[l] ?? 0) + x * x;
    }
    for (let j = 0; j < blocks; j++) {
      const v = pixels[j] ?? 0;
      s1[j] = (s1[j] ?? 0) + v;
      s2[j] = (s2[j] ?? 0) + v * v;
      const base = j * L;
      for (let l = 0; l < L; l++) sx[base + l] = (sx[base + l] ?? 0) + v * (xs[l] ?? 0);
    }
    n += 1;
  });
  width = geometry.width;
  const blockRect = (j: number): Rect => ({
    x: geometry.rect.x + (j % width) * block,
    y: geometry.rect.y + Math.floor(j / width) * block,
    w: block,
    h: block,
  });
  const scores: Array<{ j: number; r: number; lag: number }> = [];
  for (let j = 0; j < blocks; j++) {
    const rect = blockRect(j);
    if (exclude.some((e) => intersect(e, rect))) continue;
    const vv = (s2[j] ?? 0) - (s1[j] ?? 0) ** 2 / n;
    if (vv <= 1e-9) continue;
    let best = { r: 0, lag: 0 };
    for (let l = 0; l < L; l++) {
      const xx = (gxx[l] ?? 0) - (gx[l] ?? 0) ** 2 / n;
      if (xx <= 1e-12) continue;
      const r = ((sx[j * L + l] ?? 0) - ((s1[j] ?? 0) * (gx[l] ?? 0)) / n) / Math.sqrt(vv * xx);
      if (Math.abs(r) > Math.abs(best.r)) best = { r, lag: lags[l] ?? 0 };
    }
    scores.push({ j, ...best });
  }
  scores.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  const top = scores[0];
  if (!top || Math.abs(top.r) < minR)
    return { error: `形象区域里没有与音频相关的块（最强相关 ${round(top?.r ?? 0, 3)}）` };
  const topRect = blockRect(top.j);
  const center = { x: topRect.x + block / 2, y: topRect.y + block / 2 };
  const near = scores.filter((s) => {
    const r = blockRect(s.j);
    return (
      Math.abs(s.r) >= 0.6 * Math.abs(top.r) &&
      Math.hypot(r.x + block / 2 - center.x, r.y + block / 2 - center.y) <= 64
    );
  });
  const x0 = Math.min(...near.map((s) => blockRect(s.j).x)) - block;
  const y0 = Math.min(...near.map((s) => blockRect(s.j).y)) - block;
  const x1 = Math.max(...near.map((s) => blockRect(s.j).x + block)) + block;
  const y1 = Math.max(...near.map((s) => blockRect(s.j).y + block)) + block;
  const w = Math.min(MOUTH_WINDOW, x1 - x0);
  const h = Math.min(MOUTH_WINDOW, y1 - y0);
  const window = intersect(
    {
      x: Math.round(Math.min(Math.max(x0, center.x - w / 2), x1 - w)),
      y: Math.round(Math.min(Math.max(y0, center.y - h / 2), y1 - h)),
      w,
      h,
    },
    search,
  );
  if (!window) return { error: '嘴部窗口落在搜索范围之外' };

  // 第二轮：窗口内逐像素，在最强块的时延附近求相关，取相关最强的像素合成嘴型信号。
  const frames: Uint8Array[] = [];
  const times: number[] = [];
  const fine = await readFrames(file, window, 1, (t, pixels) => {
    frames.push(pixels);
    times.push(t);
  });
  const N = frames.length;
  const frameS = N > 1 ? ((times.at(-1) ?? 0) - (times[0] ?? 0)) / (N - 1) : 1 / 30;
  const fineLags = [top.lag - frameS, top.lag, top.lag + frameS];
  /** 每个时延下 z 分数化的“应有的嘴型”。 */
  const expected = fineLags.map((lag) => {
    const x = times.map((t) => expectedMouth(audio, t - lag));
    const mean = x.reduce((a, b) => a + b, 0) / N;
    const sd = Math.sqrt(x.reduce((a, b) => a + (b - mean) ** 2, 0) / N) || 1;
    return Float64Array.from(x, (v) => (v - mean) / sd);
  });
  const size = fine.width * fine.height;
  const stats: Array<{ p: number; r: number; mean: number; sd: number }> = [];
  for (let p = 0; p < size; p++) {
    const px = p % fine.width;
    const py = Math.floor(p / fine.width);
    const at = { x: fine.rect.x + px, y: fine.rect.y + py, w: 1, h: 1 };
    if (exclude.some((e) => intersect(e, at))) continue;
    let mean = 0;
    for (let k = 0; k < N; k++) mean += frames[k]?.[p] ?? 0;
    mean /= N;
    let variance = 0;
    for (let k = 0; k < N; k++) variance += ((frames[k]?.[p] ?? 0) - mean) ** 2;
    const sd = Math.sqrt(variance / N);
    if (sd < 0.5) continue;
    let best = 0;
    for (const z of expected) {
      let acc = 0;
      for (let k = 0; k < N; k++) acc += ((frames[k]?.[p] ?? 0) - mean) * (z[k] ?? 0);
      const r = acc / (N * sd);
      if (Math.abs(r) > Math.abs(best)) best = r;
    }
    stats.push({ p, r: best, mean, sd });
  }
  stats.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  const strongest = stats[0];
  if (!strongest || Math.abs(strongest.r) < minR)
    return { error: `嘴部窗口里没有与音频相关的像素（最强相关 ${round(strongest?.r ?? 0, 3)}）` };
  const chosen = stats.filter((s) => Math.abs(s.r) >= 0.6 * Math.abs(strongest.r)).slice(0, 400);
  const weight = chosen.reduce((a, s) => a + Math.abs(s.r), 0);
  const values = new Array<number>(N).fill(0);
  for (const s of chosen) {
    const w = s.r / weight;
    for (let k = 0; k < N; k++)
      values[k] = (values[k] ?? 0) + (w * ((frames[k]?.[s.p] ?? 0) - s.mean)) / s.sd;
  }
  const xs2 = chosen.map((s) => fine.rect.x + (s.p % fine.width));
  const ys2 = chosen.map((s) => fine.rect.y + Math.floor(s.p / fine.width));
  return {
    track: { times, values },
    locate: { block, r: round(top.r, 3), lagMs: round(top.lag * 1000), rect: window },
    rect: {
      x: Math.min(...xs2),
      y: Math.min(...ys2),
      w: Math.max(...xs2) - Math.min(...xs2) + 1,
      h: Math.max(...ys2) - Math.min(...ys2) + 1,
    },
    pixels: chosen.length,
    r: round(strongest.r, 3),
  };
}

/** 嘴型信号与“应有的嘴型”的互相关时延：[from, to] 内的帧，峰值的平顶取中点。 */
function lagOf(
  track: Track,
  audio: AudioTrack,
  from: number,
  to: number,
): { lagMs: number; r: number; atEdge: boolean } | null {
  const ks: number[] = [];
  for (let k = firstIndexAtOrAfter(track, from); k < track.times.length; k++) {
    if ((track.times[k] ?? 0) > to) break;
    ks.push(k);
  }
  if (ks.length < 4) return null;
  const y = ks.map((k) => track.values[k] ?? 0);
  const my = y.reduce((a, b) => a + b, 0) / y.length;
  const sy = Math.sqrt(y.reduce((a, b) => a + (b - my) ** 2, 0));
  if (sy === 0) return null;
  const rs: Array<[lag: number, r: number]> = [];
  for (let ms = LAG_RANGE_MS[0]; ms <= LAG_RANGE_MS[1]; ms += LAG_STEP_MS) {
    const x = ks.map((k) => expectedMouth(audio, (track.times[k] ?? 0) - ms / 1000));
    const mx = x.reduce((a, b) => a + b, 0) / x.length;
    const sx = Math.sqrt(x.reduce((a, b) => a + (b - mx) ** 2, 0));
    if (sx === 0) {
      rs.push([ms, Number.NEGATIVE_INFINITY]);
      continue;
    }
    let acc = 0;
    for (let i = 0; i < x.length; i++) acc += ((x[i] ?? 0) - mx) * ((y[i] ?? 0) - my);
    rs.push([ms, acc / (sx * sy)]);
  }
  let peak = 0;
  for (let i = 1; i < rs.length; i++) if ((rs[i]?.[1] ?? -1) > (rs[peak]?.[1] ?? -1)) peak = i;
  const top = rs[peak]?.[1] ?? 0;
  if (!Number.isFinite(top)) return null;
  let lo = peak;
  let hi = peak;
  while (lo > 0 && (rs[lo - 1]?.[1] ?? -1) >= top - 1e-9) lo -= 1;
  while (hi < rs.length - 1 && (rs[hi + 1]?.[1] ?? -1) >= top - 1e-9) hi += 1;
  const lagMs = ((rs[lo]?.[0] ?? 0) + (rs[hi]?.[0] ?? 0)) / 2;
  return { lagMs, r: round(top, 3), atEdge: lo === 0 || hi === rs.length - 1 };
}

function subtitleOf(
  track: Track,
  s: AudioSegment,
  prev: AudioSegment | undefined,
  next: AudioSegment | undefined,
  noise: number,
  fallbackOff: number,
): NonNullable<SentenceResult['subtitle']> {
  const offValues = valuesIn(
    track,
    Math.max(prev ? prev.end + 0.35 : -Infinity, s.onset - 1.5),
    s.onset - 0.35,
  );
  const off = offValues.length >= 2 ? (median(offValues) ?? fallbackOff) : fallbackOff;
  const onValues = valuesIn(track, s.onset + 0.25, s.end - 0.15);
  const on =
    onValues.length >= 2
      ? (median(onValues) ?? 0)
      : Math.max(...valuesIn(track, s.onset, s.end + 0.2), off);
  const contrast = on - off;
  const none = {
    firstVisibleMs: null,
    fullMs: null,
    clearedMs: null,
    contrast: round(contrast, 4),
  };
  if (contrast < Math.max(0.01, 6 * noise)) return { ...none, note: '字幕带没有可辨的变化' };
  const low = off + Math.max(0.1 * contrast, 4 * noise);
  const high = off + 0.9 * contrast;
  const mid = off + 0.5 * contrast;
  const searchTo = next ? Math.min(next.onset - 0.05, s.end + 1) : s.end + 1;
  const first = crossing(track, s.onset - 1, Math.min(s.onset + 1, searchTo), low, true);
  if (first === undefined) return { ...none, note: '找不到字幕出现的帧' };
  let full: number | undefined;
  for (let k = first; k < track.times.length && (track.times[k] ?? 0) <= searchTo; k++) {
    if ((track.values[k] ?? 0) >= high) {
      full = k;
      break;
    }
  }
  const clearedFrom = Math.max(track.times[full ?? first] ?? s.onset, s.end - 1);
  const cleared = crossing(track, clearedFrom, s.end + 1, mid, false);
  const ms = (k: number | undefined, ref: number) =>
    k === undefined ? null : round(((track.times[k] ?? 0) - ref) * 1000);
  return {
    firstVisibleMs: ms(first, s.onset),
    fullMs: ms(full, s.onset),
    clearedMs: ms(cleared, s.end),
    contrast: round(contrast, 4),
  };
}

function mouthOf(
  mode: Mode,
  track: Track,
  audio: AudioTrack,
  s: AudioSegment,
  prev: AudioSegment | undefined,
  next: AudioSegment | undefined,
  noise: number,
  fallbackClosed: number,
): NonNullable<SentenceResult['mouth']> {
  const before = valuesIn(
    track,
    Math.max(prev ? prev.end + 0.35 : -Infinity, s.onset - 1),
    s.onset - 0.35,
  );
  const closed = before.length >= 2 ? (median(before) ?? fallbackClosed) : fallbackClosed;
  const inside =
    mode === 'tone' ? valuesIn(track, s.onset + 0.3, s.end - 0.1) : valuesIn(track, s.onset, s.end);
  const sortedInside = [...inside].sort((a, b) => a - b);
  const open =
    mode === 'tone' && inside.length >= 3
      ? (median(inside) ?? closed)
      : (percentile(sortedInside, 0.9) ??
        Math.max(...valuesIn(track, s.onset, s.end + 0.2), closed));
  const after = valuesIn(
    track,
    s.end + 0.3,
    next ? Math.min(next.onset - 0.2, s.end + 1) : s.end + 1,
  );
  const closedAfter = after.length >= 2 ? (median(after) ?? closed) : closed;
  const contrast = open - closed;
  const lag = lagOf(track, audio, s.onset - 0.4, s.end + 0.4);
  const base = {
    lagMs: lag ? lag.lagMs : null,
    lagR: lag ? lag.r : null,
    contrast: round(contrast, 3),
    ...(lag?.atEdge ? { note: '互相关峰值在搜索范围边上' } : {}),
  };
  if (contrast < 4 * noise)
    return {
      openMs: null,
      openInterpMs: null,
      closeMs: null,
      closeInterpMs: null,
      ...base,
      note: '嘴型信号没有可辨的张开',
    };
  const threshold = closed + 0.5 * contrast;
  const openAt = crossing(track, s.onset - 0.5, s.onset + 0.8, threshold, true);
  const closeThreshold = closedAfter + 0.5 * (open - closedAfter);
  const closeFrom = Math.max(
    openAt === undefined ? s.onset : (track.times[openAt] ?? s.onset),
    s.end - 0.5,
  );
  const closeAt = crossing(track, closeFrom, s.end + 1, closeThreshold, false);
  const ms = (k: number | undefined, ref: number) =>
    k === undefined ? null : round(((track.times[k] ?? 0) - ref) * 1000);
  return {
    openMs: ms(openAt, s.onset),
    openInterpMs:
      openAt === undefined
        ? null
        : round((interpolated(track, openAt, threshold) - s.onset) * 1000),
    closeMs: ms(closeAt, s.end),
    closeInterpMs:
      closeAt === undefined
        ? null
        : round((interpolated(track, closeAt, closeThreshold) - s.end) * 1000),
    ...base,
  };
}

/** 在一帧画面上画出各区域，写成 PNG，供人核对定位是否落在字幕与嘴上。 */
async function drawLayout(
  file: string,
  at: number,
  boxes: Array<{ rect: Rect; color: string }>,
  out: string,
): Promise<void> {
  const draws = boxes.map(
    ({ rect, color }) =>
      `drawbox=x=${rect.x}:y=${rect.y}:w=${rect.w}:h=${rect.h}:color=${color}@0.9:t=2`,
  );
  await run('ffmpeg', [
    ...['-hide_banner', '-v', 'error', '-y', '-ss', String(Math.max(0, at)), '-i', file],
    ...['-frames:v', '1', '-vf', draws.length ? draws.join(',') : 'null', out],
  ]);
}

/** 嘴部放大：闭合与张开时各一帧，左右拼接。 */
async function drawMouth(
  file: string,
  rect: Rect,
  closedAt: number,
  openAt: number,
  out: string,
): Promise<void> {
  const pad = Math.max(12, Math.max(rect.w, rect.h));
  const x = Math.max(0, rect.x - pad);
  const y = Math.max(0, rect.y - pad);
  const w = rect.w + 2 * pad;
  const h = rect.h + 2 * pad;
  const zoom = `crop=${w}:${h}:${x}:${y},scale=${w * 6}:${h * 6}:flags=neighbor`;
  await run('ffmpeg', [
    ...['-hide_banner', '-v', 'error', '-y'],
    ...['-ss', String(Math.max(0, closedAt)), '-i', file, '-ss', String(Math.max(0, openAt))],
    ...['-i', file, '-filter_complex', `[0:v]${zoom}[a];[1:v]${zoom}[b];[a][b]hstack`],
    ...['-frames:v', '1', out],
  ]);
}

export interface Analysis {
  file: string;
  mode: Mode;
  video: VideoProbe;
  frameMs: number;
  regions: { subtitle: Rect | null; mouthSearch: Rect | null; exclude: Rect[] };
  audio: { segments: number; edgeSegments: number };
  subtitle: { referenceFrames: number; noise: number; error?: string } | null;
  mouth:
    | (Omit<MouthTrack, 'track'> & { noise: number; globalLag: unknown })
    | { error: string }
    | null;
  sentences: SentenceResult[];
  summary: Record<string, Summary | Record<string, Summary>>;
  debug?: string[];
}

export async function analyze(file: string, options: AnalyzeOptions): Promise<Analysis> {
  const video = await probe(file);
  if (!(video.fps > 0)) throw new Error('读不出录像的帧率');
  const audio = await audioTrack(file);
  const segments =
    options.mode === 'tone'
      ? await toneSegments(file, options.toneHz ?? 440)
      : speechSegments(audio);
  const exclude = [...(options.exclude ?? [])];

  let subtitle: Analysis['subtitle'] = null;
  let subtitleData: Track | undefined;
  if (options.subtitle) {
    try {
      const { track, referenceFrames } = await subtitleTrack(
        file,
        options.subtitle,
        segments,
        video,
      );
      const calm = track.values.filter((_, k) => quiet(track.times[k] ?? 0, segments));
      subtitle = { referenceFrames, noise: round(robustSd(calm), 5) };
      subtitleData = track;
    } catch (error) {
      subtitle = { referenceFrames: 0, noise: 0, error: (error as Error).message };
    }
  }

  let mouth: Analysis['mouth'] = null;
  let mouthData: Track | undefined;
  if (options.mouthSearch) {
    const found = await mouthTrack(
      file,
      options.mouthSearch,
      exclude,
      audio,
      options.minMouthR ?? MIN_MOUTH_R,
    );
    if ('error' in found) mouth = found;
    else {
      const calm = found.track.values.filter((_, k) => quiet(found.track.times[k] ?? 0, segments));
      const { track, ...rest } = found;
      const all = lagOf(track, audio, -Infinity, Infinity);
      mouth = { ...rest, noise: round(robustSd(calm), 4), globalLag: all };
      mouthData = track;
    }
  }

  const subtitleNoise = subtitle && !subtitle.error ? subtitle.noise : 0;
  const subtitleOff = subtitleData
    ? (median(subtitleData.values.filter((_, k) => quiet(subtitleData?.times[k] ?? 0, segments))) ??
      0)
    : 0;
  const mouthNoise = mouth && !('error' in mouth) ? mouth.noise : 0;
  const mouthClosed = mouthData
    ? (median(mouthData.values.filter((_, k) => quiet(mouthData?.times[k] ?? 0, segments))) ?? 0)
    : 0;
  const sentences: SentenceResult[] = segments.map((s, i) => {
    const prev = segments[i - 1];
    const next = segments[i + 1];
    return {
      index: i,
      onset: s.onset,
      end: s.end,
      seconds: round(s.end - s.onset, 4),
      gapBeforeMs: prev ? round((s.onset - prev.end) * 1000) : null,
      edge: s.edge,
      subtitle: subtitleData
        ? subtitleOf(subtitleData, s, prev, next, subtitleNoise, subtitleOff)
        : null,
      mouth: mouthData
        ? mouthOf(options.mode, mouthData, audio, s, prev, next, mouthNoise, mouthClosed)
        : null,
    };
  });

  const counted = sentences.filter((s) => !s.edge);
  const pick = (list: SentenceResult[], get: (s: SentenceResult) => number | null | undefined) =>
    summarize(list.map((s) => get(s) ?? null));
  const metrics = (list: SentenceResult[]) => ({
    subtitleFirstVisibleMs: pick(list, (s) => s.subtitle?.firstVisibleMs),
    subtitleFullMs: pick(list, (s) => s.subtitle?.fullMs),
    subtitleClearedMs: pick(list, (s) => s.subtitle?.clearedMs),
    mouthOpenMs: pick(list, (s) => s.mouth?.openMs),
    mouthCloseMs: pick(list, (s) => s.mouth?.closeMs),
    mouthLagMs: pick(list, (s) => s.mouth?.lagMs),
  });
  const summary = {
    ...metrics(counted),
    afterSilence: metrics(counted.filter((s) => s.gapBeforeMs === null || s.gapBeforeMs >= 1500)),
    afterShortGap: metrics(counted.filter((s) => s.gapBeforeMs !== null && s.gapBeforeMs < 1500)),
  };

  const debug: string[] = [];
  if (options.debugDir) {
    mkdirSync(options.debugDir, { recursive: true });
    const base = join(options.debugDir, basename(file).replace(/\.[^.]+$/, ''));
    const sample =
      counted.find((s) => s.end - s.onset >= 0.6) ?? counted[0] ?? sentences[0] ?? undefined;
    if (sample) {
      const boxes: Array<{ rect: Rect; color: string }> = [];
      if (options.subtitle) boxes.push({ rect: options.subtitle, color: 'yellow' });
      if (options.mouthSearch) boxes.push({ rect: options.mouthSearch, color: 'cyan' });
      for (const rect of exclude) boxes.push({ rect, color: 'gray' });
      if (mouth && !('error' in mouth)) boxes.push({ rect: mouth.rect, color: 'red' });
      const at = (sample.onset + sample.end) / 2;
      await drawLayout(file, at, boxes, `${base}-layout.png`);
      debug.push(`${base}-layout.png`);
      if (mouth && !('error' in mouth)) {
        await drawMouth(file, mouth.rect, sample.onset - 0.3, at, `${base}-mouth.png`);
        debug.push(`${base}-mouth.png`);
      }
    }
  }

  return {
    file,
    mode: options.mode,
    video,
    frameMs: round(1000 / video.fps, 2),
    regions: {
      subtitle: options.subtitle ?? null,
      mouthSearch: options.mouthSearch ?? null,
      exclude,
    },
    audio: { segments: segments.length, edgeSegments: segments.filter((s) => s.edge).length },
    subtitle,
    mouth,
    sentences,
    summary,
    ...(debug.length ? { debug } : {}),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      mode: { type: 'string', default: 'tone' },
      subtitle: { type: 'string' },
      'mouth-search': { type: 'string' },
      exclude: { type: 'string', multiple: true },
      tone: { type: 'string', default: '440' },
      out: { type: 'string' },
      'debug-dir': { type: 'string' },
      'min-mouth-r': { type: 'string' },
    },
  });
  const file = positionals[0];
  if (!file) throw new Error('用法：analyze.ts <录像> --mode tone|speech --subtitle x,y,w,h …');
  if (values.mode !== 'tone' && values.mode !== 'speech')
    throw new Error('--mode 为 tone 或 speech');
  const result = await analyze(resolve(file), {
    mode: values.mode,
    ...(values.subtitle ? { subtitle: parseRect(values.subtitle) } : {}),
    ...(values['mouth-search'] ? { mouthSearch: parseRect(values['mouth-search']) } : {}),
    exclude: (values.exclude ?? []).map(parseRect),
    toneHz: Number(values.tone),
    ...(values['min-mouth-r'] ? { minMouthR: Number(values['min-mouth-r']) } : {}),
    ...(values['debug-dir'] ? { debugDir: resolve(values['debug-dir']) } : {}),
  });
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (values.out) writeFileSync(values.out, text);
  else console.log(text);
}
