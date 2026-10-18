/**
 * 录像分析器（analyze.ts）的自检：用 ffmpeg 的 lavfi 合成已知偏差的录像，分析后与真值比对。
 *
 *   node spikes/av-offset/selftest.ts [--work 目录] [--out 结果.json] [--only 变体,…]
 *
 * 画面仿照本机 OBS 的布局：画布 1920×1080 输出 1280×720，Stage 浏览器源 800×600 在左上角（字幕带与单行字幕
 * 的几何由 layout.ts 按 stage.css 算出，与演练用的是同一段代码），形象占满画面。合成的内容：
 *   - 音频：与模拟 TTS 一样的 440Hz、振幅 0.2 测试音，按句出声，每字 0.15 秒；静默超过 1.5 秒的句前有
 *     150ms、-50dBFS 的 20Hz 唤醒信号。语音变体改用 220Hz 载波乘音节状的包络（约 4.2 个音节每秒）。
 *   - 字幕：逐字推进。第 k 个字（白块，带黑边，居中，宽度随字数增长）在 出声 + Δ字幕 + k·每字秒数·速率
 *     出现，句尾加 Δ字幕（再加 ±30ms）后清除。Δ字幕 在 -200…+80ms，速率在 0.98–1.02（推进比声音快或慢）。
 *     语音变体的字均匀铺在句内，每字至少 0.1 秒。
 *   - 遮挡变体：后一半的句子，字幕行中间 ±1.7 个字宽被一块不透明的“形象”盖住（画在字幕之上），
 *     头 3 个字的出现与 3 个字以内的整句都看不到。
 *   - 嘴：脸上一小块，测试音变体在句首、句尾各加 Δ嘴 后张开、闭合（阶跃）；语音变体的张开程度按形象插件的
 *     映射跟随包络，整体偏移 Δ嘴。Δ嘴 在 -200…+200ms。
 *   - 干扰：全画面时变噪声、周期眨眼、来回移动的彩色块，都与音频无关。
 * 变体：30fps、60fps、音轨比画面晚 0.25 秒开始（核对按时间线对齐）、字幕被遮挡、语音、以及没有字幕和
 * 嘴型变化的反例。
 *
 * 真值按帧量化：画面上 t 秒的变化，第一次出现在时间戳不早于 t 的那一帧。分析器给出的“第一帧”类的量
 * （每个字、清除、嘴的张开与闭合）应当与它一致（误差只来自音频时刻的取整，不超过 2ms），与名义偏差的差
 * 在一帧以内；看不到的字应当报为看不到；推进速率应当与按帧量化的真值回归出的斜率一致；互相关时延与 Δ嘴
 * 的差：阶跃（测试音）在半帧加 6ms 以内（2ms 的搜索步长，加上“应有的嘴型”取 20ms RMS 窗把阶跃抹开约 ±5ms），
 * 连续包络（语音）在几毫秒以内。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type Analysis, analyze } from './analyze.ts';
import {
  intersect,
  itemRect,
  lineToVideo,
  placement,
  type Rect,
  type SceneItemTransform,
  type SubtitleLine,
  subtitleBand,
  subtitleLine,
  toCanvas,
  toVideo,
} from './layout.ts';

const CANVAS = { width: 1920, height: 1080 };
const VIDEO = { width: 1280, height: 720 };
const PAGE = { width: 800, height: 600 };
const IDENTITY: SceneItemTransform = {
  positionX: 0,
  positionY: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  alignment: 5,
  boundsType: 'OBS_BOUNDS_NONE',
  boundsAlignment: 0,
  boundsWidth: 0,
  boundsHeight: 0,
  cropLeft: 0,
  cropRight: 0,
  cropTop: 0,
  cropBottom: 0,
  sourceWidth: PAGE.width,
  sourceHeight: PAGE.height,
};
/** 字数与秒数：模拟 TTS 每个码点 3600 个采样（24kHz），即 0.15 秒。 */
const SECONDS_PER_CHAR = 0.15;
const CHARS = [4, 7, 10, 5, 8, 6, 9, 4, 11, 6, 7, 5, 8, 10, 3];
const GAPS = [0.7, 2.2];
const FIRST_AT = 3;
const TONE_HZ = 440;
const FACE = { x: 600, y: 176, w: 80, h: 96 };
const MOUTH = { x: 40, y: 70, halfW: 8, halfH: 4 };
/** 字幕白块的黑边（录像像素）。 */
const SHADOW = 3;
/** 遮挡块的半宽（字宽的倍数）与从第几句起遮挡。 */
const OCCLUDER_HALF_CHARS = 1.7;
const OCCLUDE_FROM = 8;

type Kind = 'tone' | 'speech' | 'none';

interface Variant {
  name: string;
  kind: Kind;
  fps: number;
  /** 音轨开始得比画面晚这么多秒。 */
  audioLate: number;
  occluded: boolean;
  seed: number;
}

const VARIANTS: Variant[] = [
  { name: 'tone-30', kind: 'tone', fps: 30, audioLate: 0, occluded: false, seed: 1 },
  { name: 'tone-60', kind: 'tone', fps: 60, audioLate: 0, occluded: false, seed: 2 },
  { name: 'tone-30-audio-late', kind: 'tone', fps: 30, audioLate: 0.25, occluded: false, seed: 3 },
  { name: 'tone-30-occluded', kind: 'tone', fps: 30, audioLate: 0, occluded: true, seed: 6 },
  { name: 'speech-30', kind: 'speech', fps: 30, audioLate: 0, occluded: false, seed: 4 },
  { name: 'none-30', kind: 'none', fps: 30, audioLate: 0, occluded: false, seed: 5 },
];

interface Sentence {
  onset: number;
  end: number;
  gapBefore: number | null;
  /** 字幕的字数。 */
  chars: number;
  /** 第 k 个字出现的时刻（秒）。 */
  shows: number[];
  clear: number;
  /** 名义的第一个字偏差与推进速率。 */
  delta: number;
  rate: number;
  mouth: number;
  occluded: boolean;
  /** 语音变体的音节数与包络相位。 */
  syllables: number;
  phase: number;
}

/** 确定性的伪随机数（LCG），自检可复现。 */
function random(seed: number): () => number {
  let state = seed * 2654435761;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** 避开帧边界：t·fps 的小数部分离 0 或 1 太近时挪开一点，真值不受浮点误差影响。 */
function offGrid(t: number, fps: number): number {
  const frac = (t * fps) % 1;
  if (frac < 0.05) return t + 0.06 / fps;
  if (frac > 0.95) return t - 0.06 / fps;
  return t;
}

const SYLLABLE_HZ = 4.2;

function scenario(variant: Variant): Sentence[] {
  const next = random(variant.seed);
  const between = (lo: number, hi: number) => lo + (hi - lo) * next();
  const out: Sentence[] = [];
  let at = FIRST_AT;
  for (const [i, toneChars] of CHARS.entries()) {
    const syllables = 3 + (i % 5);
    const seconds =
      variant.kind === 'speech' ? syllables / SYLLABLE_HZ : toneChars * SECONDS_PER_CHAR;
    const chars =
      variant.kind === 'speech' ? Math.min(toneChars, Math.floor(seconds / 0.1)) : toneChars;
    const prev = out.at(-1);
    const onset = Math.round(at * 48_000) / 48_000;
    const end = Math.round((at + seconds) * 48_000) / 48_000;
    const delta = between(-0.2, 0.08);
    const rate = variant.kind === 'speech' ? 1 : between(0.98, 1.02);
    const step = variant.kind === 'speech' ? seconds / chars : SECONDS_PER_CHAR * rate;
    const shows = Array.from({ length: chars }, (_, k) =>
      offGrid(onset + delta + k * step, variant.fps),
    );
    out.push({
      onset,
      end,
      gapBefore: prev ? onset - prev.end : null,
      chars,
      shows,
      clear: offGrid(end + delta + between(-0.03, 0.03), variant.fps),
      delta,
      rate,
      mouth: between(-0.2, 0.2),
      occluded: variant.occluded && i >= OCCLUDE_FROM,
      syllables,
      phase: between(0, 2 * Math.PI),
    });
    at = end + (GAPS[i % GAPS.length] ?? 1);
  }
  // 嘴的偏差对张开与闭合都适用：两个时刻都避开帧边界。
  for (const s of out) {
    let d = s.mouth;
    for (let tries = 0; tries < 20; tries++) {
      if (
        offGrid(s.onset + d, variant.fps) === s.onset + d &&
        offGrid(s.end + d, variant.fps) === s.end + d
      )
        break;
      d += 0.13 / variant.fps;
    }
    s.mouth = d;
  }
  return out;
}

const n6 = (v: number) => v.toFixed(6);

/** 语音变体第 i 句的包络（τ 为句内秒数），与 aevalsrc/geq 的表达式一致。 */
function envelopeExpr(s: Sentence, tau: string): string {
  return `0.5*(1-cos(2*PI*${SYLLABLE_HZ}*(${tau})))*(0.6+0.4*sin(2*PI*0.83*(${tau})+${n6(s.phase)}))`;
}

function audioExpr(variant: Variant, sentences: Sentence[], shift: number): string {
  const terms: string[] = [];
  for (const s of sentences) {
    const a = n6(s.onset - shift);
    const b = n6(s.end - shift);
    const tau = `t-${a}`;
    if (variant.kind === 'speech') {
      terms.push(`gte(t,${a})*lt(t,${b})*0.3*${envelopeExpr(s, tau)}*sin(2*PI*220*(${tau}))`);
    } else {
      terms.push(`gte(t,${a})*lt(t,${b})*0.2*sin(2*PI*${TONE_HZ}*(${tau}))`);
    }
    if (s.gapBefore === null || s.gapBefore > 1.5) {
      const w = n6(s.onset - shift - 0.15);
      terms.push(`gte(t,${w})*lt(t,${a})*0.00316*sin(2*PI*20*(t-${w}))`);
    }
  }
  return terms.join('+');
}

/** 嘴的张开程度（0–1），geq 里以 T 为时刻。 */
function mouthExpr(variant: Variant, sentences: Sentence[]): string {
  if (variant.kind === 'none') return '0';
  const terms = sentences.map((s) => {
    const o = n6(s.onset + s.mouth);
    const c = n6(s.end + s.mouth);
    if (variant.kind === 'tone') return `gte(T,${o})*lt(T,${c})`;
    // 按形象插件的映射：RMS（载波振幅 0.3 的正弦，约 0.212 乘包络）减下限 0.01，除以 0.19，夹在 0–1。
    const env = envelopeExpr(s, `T-${o}`);
    return `gte(T,${o})*lt(T,${c})*clip((0.2121*${env}-0.01)/0.19,0,1)`;
  });
  return terms.join('+');
}

function videoRect(rect: Rect): Rect {
  const r = toVideo(rect, CANVAS, VIDEO);
  if (!r) throw new Error(`区域在画面外：${JSON.stringify(rect)}`);
  return r;
}

const LINE: SubtitleLine = lineToVideo(
  subtitleLine(PAGE.width, PAGE.height),
  placement(IDENTITY),
  CANVAS,
  VIDEO,
);

/** n 个字时画出的白块（录像像素，不含黑边）。 */
function textBox(n: number): Rect {
  const width = Math.round(Math.min(LINE.maxWidth, n * LINE.charWidth));
  return {
    x: Math.round(LINE.centerX - width / 2),
    y: Math.round(LINE.top + (LINE.height - LINE.charWidth) / 2),
    w: width,
    h: Math.round(LINE.charWidth),
  };
}

/**
 * 遮挡块：行中间 ±1.7 个字宽，上下盖住整个行框。左右边界取偶数：yuv420p 的色度按 2×2 采样，边界落在
 * 奇数列时，被挡住的字幕变化会经编码在边界外一列留下约 35 级的亮度变化（实测），像是“看得到”。
 */
function occluderBox(): Rect {
  const half = 2 * Math.round((OCCLUDER_HALF_CHARS * LINE.charWidth) / 2);
  return {
    x: 2 * Math.round(LINE.centerX / 2) - half,
    y: Math.round(LINE.top) - 8,
    w: 2 * half,
    h: Math.round(LINE.height) + 16,
  };
}

/** 被遮挡时第 k 个字的出现（或 k = chars 时的清除）是否看得到：新增或去掉的边条伸出遮挡块至少 2 像素。 */
function visibleChange(n: number, occluded: boolean): boolean {
  if (!occluded) return true;
  const box = textBox(n);
  const occ = occluderBox();
  return box.x - SHADOW <= occ.x - 2 || box.x + box.w + SHADOW >= occ.x + occ.w + 2;
}

function filterScript(variant: Variant, sentences: Sentence[], withAudio: boolean): string {
  const fps = variant.fps;
  const duration = (sentences.at(-1)?.end ?? 0) + 2.5;
  const boxes: string[] = [];
  if (variant.kind !== 'none') {
    for (const s of sentences) {
      for (let n = 1; n <= s.chars; n++) {
        const from = s.shows[n - 1] ?? 0;
        const to = n < s.chars ? (s.shows[n] ?? 0) : s.clear;
        const r = textBox(n);
        const enable = `enable='gte(t,${n6(from)})*lt(t,${n6(to)})'`;
        boxes.push(
          `drawbox=x=${r.x - SHADOW}:y=${r.y - SHADOW}:w=${r.w + 2 * SHADOW}:h=${r.h + 2 * SHADOW}:color=black:t=fill:${enable}`,
          `drawbox=x=${r.x}:y=${r.y}:w=${r.w}:h=${r.h}:color=white:t=fill:${enable}`,
        );
      }
    }
  }
  const first = sentences.findIndex((s) => s.occluded);
  if (first > 0) {
    // 遮挡块在上一句清除之后、两句之间的长空白里出现，此后一直在。
    const since = (sentences[first - 1]?.end ?? 0) + 0.5;
    const o = occluderBox();
    boxes.push(
      `drawbox=x=${o.x}:y=${o.y}:w=${o.w}:h=${o.h}:color=0x8a6a5a:t=fill:enable='gte(t,${n6(since)})'`,
    );
  }
  const blink = "enable='lt(mod(t,2.7),0.13)'";
  boxes.push(
    `drawbox=x=${FACE.x + 16}:y=${FACE.y + 36}:w=14:h=7:color=0x303040:t=fill:${blink}`,
    `drawbox=x=${FACE.x + 50}:y=${FACE.y + 36}:w=14:h=7:color=0x303040:t=fill:${blink}`,
  );
  const inMouth = `lt(abs(X-${MOUTH.x}),${MOUTH.halfW})*lt(abs(Y-${MOUTH.y}),${MOUTH.halfH})`;
  const graph = [
    `color=c=0xf2d4da:s=${VIDEO.width}x${VIDEO.height}:r=${fps}:d=${duration},format=yuv420p[bg]`,
    `color=c=0xf6e4d6:s=${FACE.w}x${FACE.h}:r=${fps}:d=${duration},format=yuv420p,geq=lum='if(${inMouth},lum(X,Y)-150*(${mouthExpr(variant, sentences)}),lum(X,Y))':cb='cb(X,Y)':cr='cr(X,Y)'[face]`,
    `testsrc2=s=48x48:r=${fps}:d=${duration},format=yuv420p[mov]`,
    `[bg][face]overlay=x=${FACE.x}:y=${FACE.y}[f1]`,
    `[f1][mov]overlay=x='760+300*sin(2*PI*t/6.3)':y=520[f2]`,
    `[f2]${boxes.join(',')},noise=alls=5:allf=t[v]`,
  ];
  if (withAudio)
    graph.push(
      `aevalsrc=exprs='${audioExpr(variant, sentences, 0)}':s=48000:c=stereo:d=${duration}[a]`,
    );
  return graph.join(';\n');
}

function ffmpeg(args: readonly string[]): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', fail);
    child.on('close', (code) =>
      code === 0 ? done() : fail(new Error(`ffmpeg 失败（${code}）：${stderr.trim()}`)),
    );
  });
}

const VIDEO_CODEC = [
  ...['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-g', '60', '-pix_fmt', 'yuv420p'],
  ...['-threads', '2'],
];
const AUDIO_CODEC = ['-c:a', 'aac', '-b:a', '160k', '-ar', '48000'];

async function render(variant: Variant, sentences: Sentence[], work: string): Promise<string> {
  const out = join(work, `${variant.name}.mp4`);
  const script = join(work, `${variant.name}.graph.txt`);
  if (variant.audioLate === 0) {
    writeFileSync(script, filterScript(variant, sentences, true));
    await ffmpeg([
      ...['-/filter_complex', script, '-map', '[v]', '-map', '[a]'],
      ...VIDEO_CODEC,
      ...AUDIO_CODEC,
      out,
    ]);
    return out;
  }
  // 音轨晚开始：音频内容提前 audioLate 秒合成，再以 -itsoffset 推后，内容在时间线上的位置不变。
  writeFileSync(script, filterScript(variant, sentences, false));
  const silent = join(work, `${variant.name}.video.mp4`);
  await ffmpeg(['-/filter_complex', script, '-map', '[v]', ...VIDEO_CODEC, silent]);
  const duration = (sentences.at(-1)?.end ?? 0) + 2.5 - variant.audioLate;
  const wav = join(work, `${variant.name}.wav`);
  await ffmpeg([
    ...['-f', 'lavfi', '-i'],
    `aevalsrc=exprs='${audioExpr(variant, sentences, variant.audioLate)}':s=48000:c=stereo:d=${duration}`,
    wav,
  ]);
  await ffmpeg([
    ...['-i', silent, '-itsoffset', String(variant.audioLate), '-i', wav],
    ...['-map', '0:v', '-map', '1:a', '-c:v', 'copy', ...AUDIO_CODEC, out],
  ]);
  return out;
}

/** 第一帧不早于 t 的那一帧的时间戳（帧时间戳为 k/fps）。 */
const frameAt = (t: number, fps: number) => Math.ceil(t * fps) / fps;
const ms = (v: number) => v * 1000;
const r1 = (v: number) => Math.round(v * 10) / 10;

interface Item {
  measured: number | null;
  /** 按帧量化的真值；null 表示应当报为看不到。 */
  truth: number | null;
  /** 名义偏差（未量化）。 */
  nominal: number | null;
}

interface Check {
  metric: string;
  n: number;
  /** 应当看不到、实际报为看不到的个数。 */
  invisible: { expected: number; reported: number };
  /** 与按帧量化真值之差的最大绝对值（毫秒）。 */
  maxErrorVsFrameTruthMs: number | null;
  /** 与名义偏差之差的范围（毫秒）。 */
  errorVsNominalMs: [number, number] | null;
  pass: boolean;
}

function check(
  metric: string,
  items: Item[],
  tolerance: { frameTruthMs?: number; nominalMs?: [number, number] },
): Check {
  let ok = true;
  const errors: number[] = [];
  const nominal: number[] = [];
  for (const item of items) {
    if (item.truth === null && tolerance.frameTruthMs !== undefined) {
      if (item.measured !== null) ok = false;
      continue;
    }
    if (item.measured === null) {
      ok = false;
      continue;
    }
    if (item.truth !== null) errors.push(Math.abs(item.measured - item.truth));
    if (item.nominal !== null) nominal.push(item.measured - item.nominal);
  }
  const maxError = errors.length ? Math.max(...errors) : null;
  if (
    tolerance.frameTruthMs !== undefined &&
    maxError !== null &&
    maxError > tolerance.frameTruthMs
  )
    ok = false;
  const range: [number, number] | null = nominal.length
    ? [Math.min(...nominal), Math.max(...nominal)]
    : null;
  if (
    tolerance.nominalMs &&
    range &&
    (range[0] < tolerance.nominalMs[0] || range[1] > tolerance.nominalMs[1])
  )
    ok = false;
  return {
    metric,
    n: items.filter((i) => i.measured !== null).length,
    invisible: {
      expected: items.filter((i) => i.truth === null).length,
      reported: items.filter((i) => i.measured === null).length,
    },
    maxErrorVsFrameTruthMs: maxError === null ? null : r1(maxError),
    errorVsNominalMs: range ? [r1(range[0]), r1(range[1])] : null,
    pass: ok,
  };
}

/** 按帧量化的真值回归出的斜率（与分析器同样的算法）。 */
function slopePercent(points: ReadonlyArray<readonly [number, number]>): number | null {
  if (points.length < 3) return null;
  const mx = points.reduce((a, [x]) => a + x, 0) / points.length;
  const my = points.reduce((a, [, y]) => a + y, 0) / points.length;
  const sxx = points.reduce((a, [x]) => a + (x - mx) ** 2, 0);
  const sxy = points.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0);
  return (sxy / sxx - 1) * 100;
}

function checks(variant: Variant, sentences: Sentence[], result: Analysis): Check[] {
  const fps = variant.fps;
  const frameMs = 1000 / fps;
  const found = result.sentences.filter((s) => !s.edge);
  const fail = (metric: string): Check => ({
    metric,
    n: 0,
    invisible: { expected: 0, reported: 0 },
    maxErrorVsFrameTruthMs: null,
    errorVsNominalMs: null,
    pass: false,
  });
  if (found.length !== sentences.length)
    return [fail(`句段数 ${found.length}，应为 ${sentences.length}`)];
  const pairs = sentences.map((truth, i) => ({ truth, got: found[i] }));
  if (variant.kind === 'none') {
    const shown = found.filter((s) => (s.subtitle?.additions ?? 0) > 0).length;
    const opened = found.filter((s) => s.mouth?.openMs != null).length;
    const mouthMissing = result.mouth !== null && 'error' in result.mouth;
    return [
      { ...fail('反例：不应测出字幕'), n: shown, pass: shown === 0 },
      { ...fail('反例：不应测出口型'), n: opened, pass: mouthMissing || opened === 0 },
    ];
  }
  const out: Check[] = [];
  const quantized = { frameTruthMs: 2, nominalMs: [-2, frameMs + 2] as [number, number] };
  const onsetErrors = pairs.map(({ truth, got }) => Math.abs(ms((got?.onset ?? 0) - truth.onset)));
  out.push({
    ...fail('audioOnset'),
    n: onsetErrors.length,
    maxErrorVsFrameTruthMs: r1(Math.max(...onsetErrors)),
    // 语音按能量阈值切句，包络从 0 升起，出声时刻比句首晚几十毫秒；只作参考。
    pass: Math.max(...onsetErrors) <= (variant.kind === 'speech' ? 60 : 2),
  });

  if (variant.kind === 'tone') {
    const charItems: Item[] = [];
    const firstItems: Item[] = [];
    const lastItems: Item[] = [];
    const clearItems: Item[] = [];
    const rateItems: Item[] = [];
    for (const { truth, got } of pairs) {
      const sound = (k: number) => truth.onset + k * SECONDS_PER_CHAR;
      const visible = (k: number) => visibleChange(k + 1, truth.occluded);
      const charTruth = truth.shows.map((show, k) =>
        visible(k) ? ms(frameAt(show, fps) - sound(k)) : null,
      );
      const charNominal = truth.shows.map((show, k) => ms(show - sound(k)));
      const offsets = got?.subtitle?.charOffsetsMs ?? [];
      truth.shows.forEach((_, k) => {
        charItems.push({
          measured: offsets[k] ?? null,
          truth: charTruth[k] ?? null,
          nominal: charNominal[k] ?? null,
        });
      });
      firstItems.push({
        measured: got?.subtitle?.firstCharMs ?? null,
        truth: charTruth[0] ?? null,
        nominal: charNominal[0] ?? null,
      });
      lastItems.push({
        measured: got?.subtitle?.lastCharMs ?? null,
        truth: charTruth[truth.chars - 1] ?? null,
        nominal: charNominal[truth.chars - 1] ?? null,
      });
      const clearVisible = visibleChange(truth.chars, truth.occluded);
      clearItems.push({
        measured: got?.subtitle?.clearedMs ?? null,
        truth: clearVisible ? ms(frameAt(truth.clear, fps) - truth.end) : null,
        nominal: ms(truth.clear - truth.end),
      });
      const points = truth.shows.flatMap((show, k) =>
        visible(k) ? [[sound(k), frameAt(show, fps)] as const] : [],
      );
      const expectedSlope = slopePercent(points);
      rateItems.push({
        measured: got?.subtitle?.rate?.slopePercent ?? null,
        truth: expectedSlope,
        nominal: (truth.rate - 1) * 100,
      });
    }
    out.push(
      check('subtitleCharMs', charItems, quantized),
      check('subtitleFirstCharMs', firstItems, quantized),
      check('subtitleLastCharMs', lastItems, quantized),
      check('subtitleClearedMs', clearItems, quantized),
      // 斜率按百分数比：与按帧量化真值的回归一致（0.05 以内），与名义速率的差受帧量化影响，只作参考。
      check('subtitleRateSlopePercent', rateItems, { frameTruthMs: 0.05 }),
      check(
        'mouthOpenMs',
        pairs.map(({ truth, got }) => ({
          measured: got?.mouth?.openMs ?? null,
          truth: ms(frameAt(truth.onset + truth.mouth, fps) - truth.onset),
          nominal: ms(truth.mouth),
        })),
        quantized,
      ),
      check(
        'mouthCloseMs',
        pairs.map(({ truth, got }) => ({
          measured: got?.mouth?.closeMs ?? null,
          truth: ms(frameAt(truth.end + truth.mouth, fps) - truth.end),
          nominal: ms(truth.mouth),
        })),
        quantized,
      ),
    );
  } else {
    // 语音：第一个字相对测得的出声，最后一个字与清除相对测得的结束。
    const items = (pick: 'first' | 'last' | 'clear') =>
      pairs.map(({ truth, got }): Item => {
        const onset = got?.onset ?? truth.onset;
        const end = got?.end ?? truth.end;
        const measured =
          pick === 'first'
            ? (got?.subtitle?.firstCharMs ?? null)
            : pick === 'last'
              ? (got?.subtitle?.lastCharMs ?? null)
              : (got?.subtitle?.clearedMs ?? null);
        const at =
          pick === 'first'
            ? (truth.shows[0] ?? 0)
            : pick === 'last'
              ? (truth.shows.at(-1) ?? 0)
              : truth.clear;
        const ref = pick === 'first' ? onset : end;
        return { measured, truth: ms(frameAt(at, fps) - ref), nominal: ms(at - ref) };
      });
    out.push(
      check('subtitleFirstCharMs', items('first'), quantized),
      check('subtitleLastCharMs', items('last'), quantized),
      check('subtitleClearedMs', items('clear'), quantized),
      check(
        'subtitleAdditions',
        pairs.map(({ truth, got }) => ({
          measured: got?.subtitle?.additions ?? null,
          truth: truth.chars,
          nominal: null,
        })),
        { frameTruthMs: 0 },
      ),
    );
  }
  out.push(
    check(
      'mouthLagMs',
      pairs.map(({ truth, got }) => ({
        measured: got?.mouth?.lagMs ?? null,
        truth: null,
        nominal: ms(truth.mouth),
      })),
      { nominalMs: [-frameMs / 2 - 6, frameMs / 2 + 6] },
    ),
  );
  return out;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      work: { type: 'string' },
      out: { type: 'string' },
      only: { type: 'string' },
    },
  });
  const work = resolve(values.work ?? join(tmpdir(), 'bellis-av-offset-selftest'));
  mkdirSync(work, { recursive: true });
  const only = values.only?.split(',');
  const started = new Date().toISOString();

  // 区域：与演练同一段代码，由场景项变换算出。
  const stage = placement(IDENTITY);
  const band = toCanvas(stage, subtitleBand(PAGE.width, PAGE.height, 1));
  if (!band) throw new Error('字幕带在画面外');
  const subtitle = videoRect(band);
  const avatar = videoRect(
    itemRect(placement({ ...IDENTITY, sourceWidth: CANVAS.width, sourceHeight: CANVAS.height })),
  );
  const exclude = videoRect({ x: band.x - 12, y: band.y - 12, w: band.w + 24, h: band.h + 24 });
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const sameRect = (a: Rect | null, b: Rect) =>
    a !== null && near(a.x, b.x) && near(a.y, b.y) && near(a.w, b.w) && near(a.h, b.h);
  const layoutChecks = [
    {
      name: '字幕带（录像像素）',
      pass: sameRect(subtitle, { x: 18, y: 326, w: 497, h: 58 }),
      got: subtitle,
    },
    {
      name: '单行字幕（录像像素）：中线 266.67、上沿 334.93、行高 41.07、字宽 29.33、行宽 480',
      pass:
        near(r1(LINE.centerX * 10), 2666.7) &&
        near(r1(LINE.top * 10), 3349.3) &&
        near(r1(LINE.height * 10), 410.7) &&
        near(r1(LINE.charWidth * 10), 293.3) &&
        near(r1(LINE.maxWidth * 10), 4800),
      got: LINE,
    },
    {
      name: '居中对齐、缩放 0.5',
      pass: sameRect(
        itemRect(
          placement({
            ...IDENTITY,
            positionX: 960,
            positionY: 540,
            alignment: 0,
            scaleX: 0.5,
            scaleY: 0.5,
          }),
        ),
        { x: 760, y: 390, w: 400, h: 300 },
      ),
    },
    {
      name: '外框 SCALE_INNER 1000×1000、居中',
      pass: sameRect(
        itemRect(
          placement({
            ...IDENTITY,
            positionX: 100,
            positionY: 50,
            boundsType: 'OBS_BOUNDS_SCALE_INNER',
            boundsWidth: 1000,
            boundsHeight: 1000,
          }),
        ),
        { x: 100, y: 175, w: 1000, h: 750 },
      ),
    },
    {
      name: '裁剪左 100、上 50',
      pass: sameRect(
        toCanvas(placement({ ...IDENTITY, cropLeft: 100, cropTop: 50 }), {
          x: 100,
          y: 50,
          w: 10,
          h: 10,
        }),
        { x: 0, y: 0, w: 10, h: 10 },
      ),
    },
  ];
  if (!intersect(subtitle, avatar)) throw new Error('自检布局：字幕带应在形象范围内');

  const results: unknown[] = [];
  let allPass = layoutChecks.every((c) => c.pass);
  for (const variant of VARIANTS) {
    if (only && !only.includes(variant.name)) continue;
    const sentences = scenario(variant);
    console.log(`${variant.name}：合成……`);
    const file = await render(variant, sentences, work);
    console.log(`${variant.name}：分析……`);
    const t0 = Date.now();
    const result = await analyze(file, {
      mode: variant.kind === 'speech' ? 'speech' : 'tone',
      subtitle,
      subtitleLine: LINE,
      ...(variant.kind === 'speech' ? {} : { secondsPerChar: SECONDS_PER_CHAR }),
      mouthSearch: avatar,
      exclude: [exclude],
      debugDir: join(work, 'debug'),
    });
    const list = checks(variant, sentences, result);
    const pass = list.every((c) => c.pass);
    allPass &&= pass;
    console.log(`${variant.name}：${pass ? '通过' : '不通过'}`);
    for (const c of list) console.log(`  ${c.pass ? '✓' : '✗'} ${JSON.stringify(c)}`);
    writeFileSync(
      join(work, `${variant.name}.analysis.json`),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    results.push({
      variant,
      file,
      bytes: statSync(file).size,
      analysisSeconds: Math.round((Date.now() - t0) / 100) / 10,
      pass,
      checks: list,
      mouth: result.mouth,
      subtitle: result.subtitle,
      summary: result.summary,
      truth: sentences.map((s) => ({
        onset: s.onset,
        end: s.end,
        chars: s.chars,
        firstCharMs: r1(ms((s.shows[0] ?? 0) - s.onset)),
        ratePercent: Math.round((s.rate - 1) * 10_000) / 100,
        clearMs: r1(ms(s.clear - s.end)),
        mouthMs: r1(ms(s.mouth)),
        occluded: s.occluded,
      })),
    });
  }
  const report = {
    selftest: 'av-offset',
    started,
    finished: new Date().toISOString(),
    work,
    pass: allPass,
    layoutChecks,
    regions: { subtitle, subtitleLine: LINE, mouthSearch: avatar, exclude },
    results,
  };
  const out = resolve(values.out ?? join(work, 'selftest.json'));
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${allPass ? '全部通过' : '有不通过的项'}，结果写入 ${out}`);
  if (!allPass) process.exitCode = 1;
}

await main();
