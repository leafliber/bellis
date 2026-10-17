/**
 * 录像分析器（analyze.ts）的自检：用 ffmpeg 的 lavfi 合成已知偏差的录像，分析后与真值比对。
 *
 *   node spikes/av-offset/selftest.ts [--work 目录] [--out 结果.json] [--only 变体,…]
 *
 * 画面仿照本机 OBS 的布局：画布 1920×1080 输出 1280×720，Stage 浏览器源 800×600 在左上角（字幕带由
 * layout.ts 按 stage.css 算出，与演练用的是同一段代码），形象占满画面。合成的内容：
 *   - 音频：与模拟 TTS 一样的 440Hz、振幅 0.2 测试音，按句出声；静默超过 1.5 秒的句前有 150ms、-50dBFS 的
 *     20Hz 唤醒信号；语音变体改用 220Hz 载波乘音节状的包络（约 4.2 个音节每秒）。
 *   - 字幕：字幕带内一行宽度随字数变化的白块（带黑边），在句首加 Δ字幕 后出现、句尾加 Δ清除 后消失。
 *   - 嘴：脸上一小块，测试音变体在句首、句尾各加 Δ嘴 后张开、闭合（阶跃）；语音变体的张开程度按形象插件的
 *     映射跟随包络，整体滞后 Δ嘴。
 *   - 干扰：全画面时变噪声、周期眨眼、来回移动的彩色块，都与音频无关。
 * 变体：30fps、60fps、音轨比画面晚 0.25 秒开始（核对按时间线对齐）、语音、以及没有字幕和嘴型变化的反例。
 *
 * 真值按帧量化：画面上 t 秒的变化，第一次出现在时间戳不早于 t 的那一帧。分析器给出的“第一帧”类的量应当
 * 与它一致（误差只来自音频时刻的取整，不超过 2ms），与名义偏差 Δ 的差在一帧以内；互相关时延与 Δ 的差应
 * 在半帧以内。
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
  placement,
  type Rect,
  type SceneItemTransform,
  subtitleBand,
  subtitleLineBox,
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
const CHARS = [4, 7, 10, 5, 8, 6, 9, 4, 11, 6, 7, 5, 8, 10, 6];
const GAPS = [0.7, 2.2];
const FIRST_AT = 3;
const TONE_HZ = 440;
const FACE = { x: 600, y: 176, w: 80, h: 96 };
const MOUTH = { x: 40, y: 70, halfW: 8, halfH: 4 };

type Kind = 'tone' | 'speech' | 'none';

interface Variant {
  name: string;
  kind: Kind;
  fps: number;
  /** 音轨开始得比画面晚这么多秒。 */
  audioLate: number;
  seed: number;
}

const VARIANTS: Variant[] = [
  { name: 'tone-30', kind: 'tone', fps: 30, audioLate: 0, seed: 1 },
  { name: 'tone-60', kind: 'tone', fps: 60, audioLate: 0, seed: 2 },
  { name: 'tone-30-audio-late', kind: 'tone', fps: 30, audioLate: 0.25, seed: 3 },
  { name: 'speech-30', kind: 'speech', fps: 30, audioLate: 0, seed: 4 },
  { name: 'none-30', kind: 'none', fps: 30, audioLate: 0, seed: 5 },
];

interface Sentence {
  onset: number;
  end: number;
  gapBefore: number | null;
  subtitleShow: number;
  subtitleClear: number;
  mouth: number;
  chars: number;
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
  for (const [i, chars] of CHARS.entries()) {
    const syllables = 3 + (i % 5);
    const seconds = variant.kind === 'speech' ? syllables / SYLLABLE_HZ : chars * SECONDS_PER_CHAR;
    const prev = out.at(-1);
    const onset = Math.round(at * 48_000) / 48_000;
    const end = Math.round((at + seconds) * 48_000) / 48_000;
    out.push({
      onset,
      end,
      gapBefore: prev ? onset - prev.end : null,
      subtitleShow: offGrid(onset + between(-0.04, 0.08), variant.fps) - onset,
      subtitleClear: offGrid(end + between(-0.03, 0.07), variant.fps) - end,
      mouth: between(0.04, 0.2),
      chars,
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

function filterScript(variant: Variant, sentences: Sentence[], withAudio: boolean): string {
  const fps = variant.fps;
  const duration = (sentences.at(-1)?.end ?? 0) + 2.5;
  const stage = placement(IDENTITY);
  const boxes: string[] = [];
  if (variant.kind !== 'none') {
    for (const s of sentences) {
      const line = toCanvas(stage, subtitleLineBox(PAGE.width, PAGE.height, s.chars, 0, 1));
      if (!line) throw new Error('字幕行在画面外');
      const r = videoRect(line);
      const enable = `enable='gte(t,${n6(s.onset + s.subtitleShow)})*lt(t,${n6(s.end + s.subtitleClear)})'`;
      boxes.push(
        `drawbox=x=${r.x - 3}:y=${r.y - 3}:w=${r.w + 6}:h=${r.h + 6}:color=black:t=fill:${enable}`,
        `drawbox=x=${r.x}:y=${r.y}:w=${r.w}:h=${r.h}:color=white:t=fill:${enable}`,
      );
    }
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
      '-/filter_complex',
      script,
      '-map',
      '[v]',
      '-map',
      '[a]',
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

interface Check {
  metric: string;
  n: number;
  /** 与按帧量化的真值之差的最大绝对值（毫秒）。 */
  maxErrorVsFrameTruthMs: number | null;
  /** 与名义偏差 Δ 之差的范围（毫秒）。 */
  errorVsNominalMs: [number, number] | null;
  pass: boolean;
}

function compare(
  metric: string,
  pairs: Array<{ measured: number | null; frameTruth: number | null; nominal: number }>,
  tolerance: { frameTruthMs?: number; nominalMs: [number, number] },
): Check {
  const present = pairs.filter((p) => p.measured !== null);
  const vsFrame = present
    .filter((p) => p.frameTruth !== null)
    .map((p) => Math.abs((p.measured as number) - (p.frameTruth as number)));
  const vsNominal = present.map((p) => (p.measured as number) - p.nominal);
  const maxFrame = vsFrame.length ? Math.max(...vsFrame) : null;
  const range: [number, number] | null = vsNominal.length
    ? [Math.min(...vsNominal), Math.max(...vsNominal)]
    : null;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const pass =
    present.length === pairs.length &&
    (tolerance.frameTruthMs === undefined ||
      (maxFrame !== null && maxFrame <= tolerance.frameTruthMs)) &&
    range !== null &&
    range[0] >= tolerance.nominalMs[0] &&
    range[1] <= tolerance.nominalMs[1];
  return {
    metric,
    n: present.length,
    maxErrorVsFrameTruthMs: maxFrame === null ? null : r1(maxFrame),
    errorVsNominalMs: range ? [r1(range[0]), r1(range[1])] : null,
    pass,
  };
}

function checks(variant: Variant, sentences: Sentence[], result: Analysis): Check[] {
  const fps = variant.fps;
  const frameMs = 1000 / fps;
  const found = result.sentences.filter((s) => !s.edge);
  if (found.length !== sentences.length)
    return [
      {
        metric: `句段数 ${found.length}，应为 ${sentences.length}`,
        n: found.length,
        maxErrorVsFrameTruthMs: null,
        errorVsNominalMs: null,
        pass: false,
      },
    ];
  const pairs = sentences.map((s, i) => ({ truth: s, got: found[i] }));
  const out: Check[] = [];
  const ms = (v: number) => v * 1000;
  if (variant.kind === 'none') {
    const shown = found.filter((s) => s.subtitle?.firstVisibleMs != null).length;
    const opened = found.filter((s) => s.mouth?.openMs != null).length;
    const mouthError = result.mouth && 'error' in result.mouth;
    out.push(
      {
        metric: '反例：不应测出字幕',
        n: shown,
        maxErrorVsFrameTruthMs: null,
        errorVsNominalMs: null,
        pass: shown === 0,
      },
      {
        metric: '反例：不应测出口型',
        n: opened,
        maxErrorVsFrameTruthMs: null,
        errorVsNominalMs: null,
        pass: mouthError === true || opened === 0,
      },
    );
    return out;
  }
  const onsetErrors = pairs.map(({ truth, got }) => Math.abs(ms((got?.onset ?? 0) - truth.onset)));
  out.push({
    metric: 'audioOnset',
    n: onsetErrors.length,
    maxErrorVsFrameTruthMs: Math.round(Math.max(...onsetErrors) * 10) / 10,
    errorVsNominalMs: null,
    // 语音按能量阈值切句，包络从 0 升起，出声时刻比句首晚几十毫秒；只作参考。
    pass: Math.max(...onsetErrors) <= (variant.kind === 'speech' ? 60 : 2),
  });
  const quantized = { frameTruthMs: 2, nominalMs: [-2, frameMs + 2] as [number, number] };
  const lagTolerance: [number, number] = [-frameMs / 2 - 3, frameMs / 2 + 3];
  if (variant.kind === 'tone') {
    out.push(
      compare(
        'subtitleFirstVisibleMs',
        pairs.map(({ truth, got }) => ({
          measured: got?.subtitle?.firstVisibleMs ?? null,
          frameTruth: ms(frameAt(truth.onset + truth.subtitleShow, fps) - truth.onset),
          nominal: ms(truth.subtitleShow),
        })),
        quantized,
      ),
      compare(
        'subtitleFullMs',
        pairs.map(({ truth, got }) => ({
          measured: got?.subtitle?.fullMs ?? null,
          frameTruth: ms(frameAt(truth.onset + truth.subtitleShow, fps) - truth.onset),
          nominal: ms(truth.subtitleShow),
        })),
        quantized,
      ),
      compare(
        'subtitleClearedMs',
        pairs.map(({ truth, got }) => ({
          measured: got?.subtitle?.clearedMs ?? null,
          frameTruth: ms(frameAt(truth.end + truth.subtitleClear, fps) - truth.end),
          nominal: ms(truth.subtitleClear),
        })),
        quantized,
      ),
      compare(
        'mouthOpenMs',
        pairs.map(({ truth, got }) => ({
          measured: got?.mouth?.openMs ?? null,
          frameTruth: ms(frameAt(truth.onset + truth.mouth, fps) - truth.onset),
          nominal: ms(truth.mouth),
        })),
        quantized,
      ),
      compare(
        'mouthCloseMs',
        pairs.map(({ truth, got }) => ({
          measured: got?.mouth?.closeMs ?? null,
          frameTruth: ms(frameAt(truth.end + truth.mouth, fps) - truth.end),
          nominal: ms(truth.mouth),
        })),
        quantized,
      ),
    );
  }
  out.push(
    compare(
      'mouthLagMs',
      pairs.map(({ truth, got }) => ({
        measured: got?.mouth?.lagMs ?? null,
        frameTruth: null,
        nominal: ms(truth.mouth),
      })),
      { nominalMs: lagTolerance },
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
  const layoutChecks = [
    { name: '字幕带（录像像素）', got: subtitle, want: { x: 18, y: 326, w: 497, h: 58 } },
    {
      name: '居中对齐、缩放 0.5',
      got: itemRect(
        placement({
          ...IDENTITY,
          positionX: 960,
          positionY: 540,
          alignment: 0,
          scaleX: 0.5,
          scaleY: 0.5,
        }),
      ),
      want: { x: 760, y: 390, w: 400, h: 300 },
    },
    {
      name: '外框 SCALE_INNER 1000×1000、居中',
      got: itemRect(
        placement({
          ...IDENTITY,
          positionX: 100,
          positionY: 50,
          boundsType: 'OBS_BOUNDS_SCALE_INNER',
          boundsWidth: 1000,
          boundsHeight: 1000,
        }),
      ),
      want: { x: 100, y: 175, w: 1000, h: 750 },
    },
    {
      name: '裁剪左 100、上 50',
      got: toCanvas(placement({ ...IDENTITY, cropLeft: 100, cropTop: 50 }), {
        x: 100,
        y: 50,
        w: 10,
        h: 10,
      }),
      want: { x: 0, y: 0, w: 10, h: 10 },
    },
  ].map((c) => ({
    ...c,
    pass:
      c.got !== null &&
      Math.abs(c.got.x - c.want.x) < 1e-6 &&
      Math.abs(c.got.y - c.want.y) < 1e-6 &&
      Math.abs(c.got.w - c.want.w) < 1e-6 &&
      Math.abs(c.got.h - c.want.h) < 1e-6,
  }));
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
      mouthSearch: avatar,
      exclude: [exclude],
      debugDir: join(work, 'debug'),
    });
    const list = checks(variant, sentences, result);
    const pass = list.every((c) => c.pass);
    allPass &&= pass;
    console.log(`${variant.name}：${pass ? '通过' : '不通过'} ${JSON.stringify(list)}`);
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
        subtitleShowMs: Math.round(s.subtitleShow * 10_000) / 10,
        subtitleClearMs: Math.round(s.subtitleClear * 10_000) / 10,
        mouthMs: Math.round(s.mouth * 10_000) / 10,
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
    regions: { subtitle, mouthSearch: avatar, exclude },
    results,
  };
  const out = resolve(values.out ?? join(work, 'selftest.json'));
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${allPass ? '全部通过' : '有不通过的项'}，结果写入 ${out}`);
  if (!allPass) process.exitCode = 1;
}

await main();
