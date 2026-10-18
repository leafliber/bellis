/**
 * P1 第 10 步的真机实测：字幕、口型与音频在 OBS 录制中的偏差（P1 任务卡出口“发声与形象”）。
 *
 *   node spikes/drill-av-offset.ts --stage-source 名字 --avatar-source 名字 [--safe-scene Safe]
 *        [--sessions tone,speech] [--tone-seconds 100] [--speech-sentences 10] [--speaker vivian]
 *        [--speech-backend qwen3|fake] [--fps 60] [--out 结果文件前缀]
 *   node spikes/drill-av-offset.ts --stage-source 名字 --avatar-source 名字 --preview [--out 前缀]
 *   node spikes/drill-av-offset.ts --reanalyze 结果文件前缀
 *
 * --preview 只读：盘点布局与来源设置，截取节目场景与形象源的画面（<前缀>-preview-*.png），不改 OBS、不拉起宿主，
 * 用来在录制前核对嘴部大小、透明背景与 VTS 设置面板是否关闭。
 *
 * 前提：VTS 已开插件 API 并载入模型，形象插件「Bellis」的令牌已在 SecretStore（服务名 bellis）的 vts 条目里；
 * OBS 的直播场景里有 Stage 浏览器源与采集 VTS 的游戏采集源，安全场景里没有它们。语音会话还要求本 worktree
 * 已 `uv sync --locked --group tts-local` 且模型权重在 Hugging Face 缓存里（--speech-backend fake 时不需要）。
 *
 * 每个会话用启动器拉起真实宿主与看门狗。profile 含 OBS 控制、真实 Stage、形象、TTS、发声仲裁与定时播报，
 * 审核显式关闭：
 *   - tone：440Hz 测试音的模拟 TTS（24kHz，每个码点 0.15 秒）。句长 4–11 个码点，句间空白交替 0.7 秒与
 *     2.2 秒，前者不触发唤醒信号、后者触发，每分钟约 24 句（低于每分钟 30 句的速率上限）。
 *   - speech：TTS 路由（local、subtitles）与本地 Qwen3-TTS，每 12 秒一句真实语音。
 * 确认在场、预检通过后开始录制并切到 M2；到时（tone）或播够句数（speech）后等最后一句播完再停录制，然后停止会话。
 * 计划内停止时宿主切到安全场景并静音：每个会话之后像操作员一样切回直播场景、取消静音（下一次开播预检会
 * 拦住安全场景与静音，这是预期的）。
 *
 * 录像分析见 spikes/av-offset/analyze.ts：区域由场景项的变换算出（spikes/av-offset/layout.ts），字幕带与
 * 单行字幕的几何按 stage.css 的布局，测试音按每字 0.15 秒逐字配对；嘴部在形象源的范围里（去掉字幕带）按与
 * 音频的相关自动找。不改场景项顺序：Stage 源之上有别的来源盖住字幕带时拒绝运行，只有形象源且它允许透明时
 * 照常运行，被模型挡住的字单独计数。帧率决定单次测量的分辨率（30fps 时 33.3ms）：--fps 临时改 OBS 的帧率
 * （只在没有输出进行时能改），结束时改回。
 *
 * 会改写浏览器源的 URL、切换节目场景、静音并开关录制；推流或录制进行中、或有别的 Bellis 进程在运行时拒绝运行。
 * 结束时恢复浏览器源设置（含 URL）、节目场景、静音与帧率，并读回比对（含场景项顺序）。录制文件留在 OBS 的录制目录。
 * 结果写 <前缀>.json，各会话的宿主日志写 <前缀>-<会话>.jsonl，定位图写 <前缀>-debug/。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { connect, decodeSessionKey, RpcPeer } from '@bellis/channel';
import { loadConfig, OBS_SECRET, readObsSecret } from '@bellis/config';
import { launch, type Session } from '@bellis/launcher';
import { ObsClient, type ObsResult } from '@bellis/obs';
import { OperatorMethod, Role } from '@bellis/protocol';
import { KeyringSecretStore } from '@bellis/secret-store';
import { type Analysis, analyze, probe, summarize } from './av-offset/analyze.ts';
import {
  intersect,
  itemRect,
  lineToVideo,
  placement,
  type Rect,
  type SceneItemTransform,
  subtitleBand,
  subtitleLine,
  subtitleLines,
  toCanvas,
  toVideo,
} from './av-offset/layout.ts';
import { waitForNoOtherBellis } from './bellis-processes.ts';
import { differences, type ObsSnapshot, restoreSnapshot, snapshot } from './obs-snapshot.ts';

const file = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const hostMain = file('../packages/host/src/main.ts');
const watchdogMain = file('../packages/watchdog/src/main.ts');
const liveExample = file('../config/live.example.json');
/** 与 drill-avatar 一样用正式的服务名：形象插件的令牌在 bellis 的 vts 条目里。 */
const SECRET_SERVICE = 'bellis';

const SAMPLE_RATE = 24_000;
const SAMPLES_PER_CHAR = 3600;
const TONE_HZ = 440;
const TONE_CHARS = [4, 7, 10, 5, 8, 6, 9, 4, 11, 6, 7, 5, 8, 10, 6];
const TONE_GAPS_MS = [700, 2200];
/** 测试音句子的文字：取前 n-1 个字加句号（码点数即模拟 TTS 的时长）。没有逗号，每条只成一句。 */
const TONE_POOL = '这是一句用来核对字幕口型与声音偏差的测试播报内容';
const SPEECH_TEXTS = [
  '大家好欢迎来到今天的直播。',
  '接下来我们一起看看今天的安排。',
  '如果你是第一次来可以先点个关注。',
  '今天的天气不错适合出门走走。',
  '感谢大家的陪伴我们继续往下看。',
];
const SPEECH_EVERY_MS = 12_000;
/** 首句排在插件激活后这么久，留出页面与形象认证、预检、开始录制与切到 M2 的时间。 */
const TONE_FIRST_AT_MS = 15_000;
const SPEECH_FIRST_AT_MS = 20_000;
/** 速率上限（live.example.json：speech.output 每 60 秒 30 次）留出余量。 */
const MAX_SENTENCES_PER_MINUTE = 27;
/** 字幕带四周再排除这么多画布像素，找嘴部时不碰字幕。 */
const EXCLUDE_MARGIN = 12;

type Kind = 'tone' | 'speech';
type LogLine = { t: string; event: string; [field: string]: unknown };

class Lines {
  readonly items: LogLine[] = [];
  readonly raw: string[] = [];
  readonly #waiters = new Set<() => void>();

  constructor(stream: Readable | null) {
    if (!stream) throw new Error('没有可读的输出');
    createInterface({ input: stream }).on('line', (line) => {
      this.raw.push(line);
      try {
        this.items.push(JSON.parse(line) as LogLine);
      } catch {
        return;
      }
      for (const wake of this.#waiters) wake();
    });
  }

  async wait(match: (line: LogLine) => boolean, timeoutMs: number, from = 0): Promise<LogLine> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.items.slice(from).find(match);
      if (found) return found;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`等待超时：${JSON.stringify(this.items.slice(-5))}`);
      await new Promise<void>((wake) => {
        const done = () => {
          this.#waiters.delete(done);
          wake();
        };
        this.#waiters.add(done);
        setTimeout(done, Math.min(left, 100));
      });
    }
  }
}

function ok(result: ObsResult): Record<string, unknown> {
  if (!result.ok)
    throw new Error(`${result.requestType} 失败：${result.code} ${result.comment ?? ''}`);
  return result.data ?? {};
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const fact = (type: string) => (line: LogLine) => line.event === 'fact' && line.type === type;
const say = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

interface SceneItem {
  sceneItemId: number;
  sceneItemIndex: number;
  sourceName: string;
  sceneItemEnabled: boolean;
  inputKind?: string | null;
  sceneItemTransform: SceneItemTransform;
}

interface Announcement {
  id: string;
  atMs: number;
  text: string;
}

/** 测试音会话的排期：句长与空白按固定的序列循环，覆盖到 horizonMs。 */
function toneSchedule(horizonMs: number): Announcement[] {
  const out: Announcement[] = [];
  let at = TONE_FIRST_AT_MS;
  for (let k = 0; at < horizonMs; k++) {
    const chars = TONE_CHARS[k % TONE_CHARS.length] ?? 6;
    out.push({
      id: `tone${k}`,
      atMs: at,
      text: `${[...TONE_POOL].slice(0, chars - 1).join('')}。`,
    });
    const seconds = (chars * SAMPLES_PER_CHAR) / SAMPLE_RATE;
    at += Math.round(seconds * 1000) + (TONE_GAPS_MS[k % TONE_GAPS_MS.length] ?? 1000);
  }
  // 任意 60 秒内的句数不超过上限，否则安全核会因超出速率降级。
  for (const a of out) {
    const within = out.filter((b) => b.atMs >= a.atMs && b.atMs < a.atMs + 60_000).length;
    if (within > MAX_SENTENCES_PER_MINUTE)
      throw new Error(`排期过密：60 秒内 ${within} 句，超过 ${MAX_SENTENCES_PER_MINUTE}`);
  }
  return out;
}

function speechSchedule(horizonMs: number): Announcement[] {
  const out: Announcement[] = [];
  for (let k = 0, at = SPEECH_FIRST_AT_MS; at < horizonMs; k++, at += SPEECH_EVERY_MS)
    out.push({ id: `speech${k}`, atMs: at, text: SPEECH_TEXTS[k % SPEECH_TEXTS.length] as string });
  return out;
}

interface Layout {
  canvas: { width: number; height: number };
  output: { width: number; height: number };
  fps: number;
  liveScene: string;
  stage: { item: SceneItem; rect: Rect };
  avatar: { item: SceneItem; rect: Rect };
  /** 画布像素。 */
  subtitle: Rect;
  mouthSearch: Rect;
  exclude: Rect;
  subtitleLines: number;
  /** 盖住字幕带、且在 Stage 源之上的其它场景项。 */
  coveringSubtitle: string[];
}

async function layoutOf(
  obs: ObsClient,
  liveScene: string,
  stageSource: string,
  avatarSource: string,
  texts: readonly string[],
): Promise<Layout> {
  const video = ok(await obs.request('GetVideoSettings'));
  const canvas = { width: Number(video.baseWidth), height: Number(video.baseHeight) };
  const output = { width: Number(video.outputWidth), height: Number(video.outputHeight) };
  const items = ok(await obs.request('GetSceneItemList', { sceneName: liveScene }))
    .sceneItems as SceneItem[];
  const find = (name: string) => {
    const item = items.find((i) => i.sourceName === name);
    if (!item)
      throw new Error(
        `直播场景「${liveScene}」的顶层没有「${name}」（嵌套场景或分组请手工给出区域）`,
      );
    if (!item.sceneItemEnabled) throw new Error(`直播场景里的「${name}」没有启用`);
    return item;
  };
  const stageItem = find(stageSource);
  const avatarItem = find(avatarSource);
  const whole = { x: 0, y: 0, w: canvas.width, h: canvas.height };
  const stagePlace = placement(stageItem.sceneItemTransform);
  const page = stageItem.sceneItemTransform;
  const lines = Math.max(...texts.map((t) => subtitleLines([...t].length, page.sourceWidth)));
  const band = toCanvas(stagePlace, subtitleBand(page.sourceWidth, page.sourceHeight, lines));
  const subtitle = band ? intersect(band, whole) : null;
  if (!subtitle) throw new Error('字幕带不在画布内');
  const avatarRect = intersect(itemRect(placement(avatarItem.sceneItemTransform)), whole);
  if (!avatarRect) throw new Error('形象源不在画布内');
  const exclude = {
    x: subtitle.x - EXCLUDE_MARGIN,
    y: subtitle.y - EXCLUDE_MARGIN,
    w: subtitle.w + 2 * EXCLUDE_MARGIN,
    h: subtitle.h + 2 * EXCLUDE_MARGIN,
  };
  const covering = items
    .filter((i) => i.sceneItemEnabled && i.sceneItemIndex > stageItem.sceneItemIndex)
    .filter((i) => {
      try {
        return intersect(itemRect(placement(i.sceneItemTransform)), subtitle) !== null;
      } catch {
        return true;
      }
    })
    .map((i) => i.sourceName);
  return {
    canvas,
    output,
    fps: Number(video.fpsNumerator) / Number(video.fpsDenominator),
    liveScene,
    stage: { item: stageItem, rect: itemRect(stagePlace) },
    avatar: { item: avatarItem, rect: avatarRect },
    subtitle,
    mouthSearch: avatarRect,
    exclude,
    subtitleLines: lines,
    coveringSubtitle: covering,
  };
}

/** 按录像分辨率换算区域并分析。 */
async function analyzeRecording(path: string, kind: Kind, layout: Layout, debugDir: string) {
  const video = await probe(path);
  const scale = (rect: Rect) => toVideo(rect, layout.canvas, video);
  const subtitle = scale(layout.subtitle);
  const mouthSearch = scale(layout.mouthSearch);
  const exclude = scale(layout.exclude);
  const page = layout.stage.item.sceneItemTransform;
  const line = lineToVideo(
    subtitleLine(page.sourceWidth, page.sourceHeight),
    placement(page),
    layout.canvas,
    video,
  );
  return analyze(path, {
    mode: kind,
    ...(subtitle ? { subtitle, subtitleLine: line } : {}),
    // 模拟 TTS 每个码点等长：第 k 个字的声音从出声后 k·0.15 秒开始。
    ...(kind === 'tone' ? { secondsPerChar: SAMPLES_PER_CHAR / SAMPLE_RATE } : {}),
    // 语音每 12 秒一句：句内的停顿（实测有 356ms 的）并入同一句。
    ...(kind === 'speech' ? { speechMergeMs: 1500 } : {}),
    ...(mouthSearch ? { mouthSearch } : {}),
    exclude: exclude ? [exclude] : [],
    debugDir,
  });
}

/** 截取一个来源（或场景）的画面写成 PNG。只读。 */
async function screenshot(obs: ObsClient, sourceName: string, out: string): Promise<string> {
  const shot = ok(await obs.request('GetSourceScreenshot', { sourceName, imageFormat: 'png' }));
  const data = String(shot.imageData ?? '');
  const comma = data.indexOf(',');
  writeFileSync(out, Buffer.from(comma >= 0 ? data.slice(comma + 1) : data, 'base64'));
  return out;
}

/** 宿主日志里切到 M2 之后的部分。 */
function runLines(lines: LogLine[]): LogLine[] {
  const from = lines.findIndex(
    (l) => fact('supervision.changed')(l) && (l.data as { to?: string }).to === 'M2',
  );
  return from < 0 ? [] : lines.slice(from);
}

/** 页面侧的摘要：Stage 服务记下的每句回报、欠载、发言结果与 TTS 切换。 */
function pageSide(lines: LogLine[]) {
  const run = runLines(lines);
  const sentences = run.filter((l) => l.event === 'stage.sentence');
  const ends: Record<string, number> = {};
  for (const l of run.filter(fact('utterance.played'))) {
    const end = (l.data as { end: string }).end;
    ends[end] = (ends[end] ?? 0) + 1;
  }
  const started = lines.find(fact('tts.started'))?.data as { sampleRate?: number } | undefined;
  return {
    sentences: sentences.length,
    complete: sentences.filter((s) => s.complete === true).length,
    /** 完整播出的句子按顺序的原始采样数与采样率（模拟 TTS 为 24kHz，本地 TTS 取 tts.started 的）。 */
    playedSamples: sentences.filter((s) => s.complete === true).map((s) => Number(s.played)),
    sampleRate: started?.sampleRate ?? SAMPLE_RATE,
    underruns: sentences.reduce((n, s) => n + Number(s.underruns ?? 0), 0),
    truncated: sentences
      .filter((s) => s.complete !== true)
      .map((s) => ({ t: s.t, sentenceId: s.sentenceId, reason: s.reason ?? null })),
    utterances: ends,
    ttsSwitched: run.filter(fact('tts.switched')).map((l) => ({ t: l.t, ...(l.data as object) })),
    avatarStopped: run
      .filter((l) => l.event === 'avatar.injection-stopped')
      .map((l) => ({ t: l.t, reason: l.reason ?? null })),
    muted: run.filter((l) => l.event === 'stage.muted').map((l) => ({ t: l.t, reason: l.reason })),
  };
}

/**
 * 字幕跨度对照页面回报的句长：录像里第一个字出现到清除的时长，比上这一句在页面上播出的时长（原始采样数
 * 除以采样率）。第一个字在它的映射开始时刻出现，播完即清除：测试音第一个字从第 0 个采样开始，这个比应当
 * 接近 100%；语音第一个字从对齐出的开始出现，比值少掉的部分就是句首到第一个字的时长。另给出可闻部分
 * （-40dBFS 以上）占页面时长的比例：语音句首句尾的近乎无声部分也算在页面时长里。录像的句段（不含截断的）
 * 与完整播出的句子按顺序配对；句段比句子多、或开头的句段被截断时不给。
 */
function spanOf(analysis: Analysis, page: { playedSamples: number[]; sampleRate: number }) {
  // 录制在切到 M2 之前开始，开头不会截掉句子；结尾停录制时正在播的那句是截断的句段，页面上却是完整的。
  const list = analysis.sentences.filter((s) => !s.edge);
  const startsCut = analysis.sentences[0]?.edge === true;
  if (startsCut || list.length > page.playedSamples.length || list.length === 0)
    return { paired: false, segments: list.length, sentences: page.playedSamples.length };
  const rows = list.map((s, i) => {
    const pageSeconds = (page.playedSamples[i] ?? 0) / page.sampleRate;
    const first = s.subtitle?.firstCharMs;
    const cleared = s.subtitle?.clearedMs;
    const span = first == null || cleared == null ? null : s.seconds + (cleared - first) / 1000;
    return {
      pageSeconds,
      audibleSeconds: s.seconds,
      subtitleSpanSeconds: span === null ? null : Math.round(span * 1000) / 1000,
      spanPercent: span === null ? null : Math.round((1000 * span) / pageSeconds) / 10,
      audiblePercent: Math.round((1000 * s.seconds) / pageSeconds) / 10,
    };
  });
  return {
    paired: true,
    rows,
    spanPercent: summarize(rows.map((r) => r.spanPercent)),
    audiblePercent: summarize(rows.map((r) => r.audiblePercent)),
  };
}

async function reanalyze(prefix: string): Promise<void> {
  const report = JSON.parse(readFileSync(`${prefix}.json`, 'utf8')) as {
    layout?: Layout;
    sessions?: Array<{
      kind: Kind;
      recording?: { path: string };
      analysis?: Analysis;
      page?: { playedSamples: number[]; sampleRate: number };
      span?: unknown;
    }>;
    reanalyzedAt?: string;
  };
  if (!report.layout) throw new Error('结果里没有布局');
  for (const session of report.sessions ?? []) {
    if (!session.recording) continue;
    say(`重做分析：${session.kind} ${session.recording.path}`);
    session.analysis = await analyzeRecording(
      session.recording.path,
      session.kind,
      report.layout,
      `${prefix}-debug`,
    );
    // 页面侧的摘要按保存的宿主日志重算（旧结果里可能没有逐句的采样数）。
    const log = `${prefix}-${session.kind}.jsonl`;
    if (existsSync(log)) {
      const lines = readFileSync(log, 'utf8')
        .split('\n')
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as LogLine];
          } catch {
            return [];
          }
        });
      session.page = pageSide(lines);
    }
    if (session.page) session.span = spanOf(session.analysis, session.page);
  }
  report.reanalyzedAt = new Date().toISOString();
  writeFileSync(`${prefix}.json`, `${JSON.stringify(report, null, 2)}\n`);
  say(`已写回 ${prefix}.json`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'stage-source': { type: 'string' },
      'avatar-source': { type: 'string' },
      'safe-scene': { type: 'string', default: 'Safe' },
      sessions: { type: 'string', default: 'tone,speech' },
      'tone-seconds': { type: 'string', default: '100' },
      'speech-sentences': { type: 'string', default: '10' },
      speaker: { type: 'string', default: 'vivian' },
      'speech-backend': { type: 'string', default: 'qwen3' },
      preview: { type: 'boolean', default: false },
      fps: { type: 'string' },
      out: { type: 'string' },
      reanalyze: { type: 'string' },
    },
  });
  if (values.reanalyze) {
    await reanalyze(resolve(values.reanalyze));
    return;
  }
  const stageSource = values['stage-source'];
  const avatarSource = values['avatar-source'];
  if (!stageSource || !avatarSource) throw new Error('需要 --stage-source 与 --avatar-source');
  const safeScene = values['safe-scene'];
  const kinds = values.sessions.split(',').map((s) => s.trim()) as Kind[];
  if (kinds.length === 0 || kinds.some((k) => k !== 'tone' && k !== 'speech'))
    throw new Error('--sessions 为 tone、speech 或两者，以逗号分隔');
  const toneSeconds = Number(values['tone-seconds']);
  const speechSentences = Number(values['speech-sentences']);
  if (!(toneSeconds > 0) || !(speechSentences > 0)) throw new Error('时长与句数须为正数');
  const backend = values['speech-backend'];
  if (backend !== 'qwen3' && backend !== 'fake')
    throw new Error('--speech-backend 为 qwen3 或 fake');
  const started = new Date().toISOString();
  const out = resolve(
    values.out ?? join('reports', `drill-av-offset-${started.replace(/[:.]/g, '-')}`),
  );
  mkdirSync(dirname(out), { recursive: true });

  await waitForNoOtherBellis({ log: say });
  const secret = await readObsSecret(new KeyringSecretStore(SECRET_SERVICE), OBS_SECRET);
  const obs = await ObsClient.connect(secret.url, secret.password);
  const id = Date.now().toString(36);
  let original: ObsSnapshot | undefined;
  let originalItems: Array<{ sceneItemId: number; sceneItemIndex: number; enabled: boolean }> = [];
  /** 已开始改动 OBS（预览只读，不恢复）。 */
  let changed = false;
  /** 改过帧率时的原值。 */
  let originalFps: { fpsNumerator: number; fpsDenominator: number } | undefined;
  let session: Session | undefined;
  let recording = false;
  const temporary: string[] = [];
  const result: Record<string, unknown> = {};
  const sessions: Array<Record<string, unknown>> = [];
  result.sessions = sessions;
  try {
    if (ok(await obs.request('GetStreamStatus')).outputActive)
      throw new Error('推流进行中，拒绝运行');
    if (ok(await obs.request('GetRecordStatus')).outputActive)
      throw new Error('录制进行中，拒绝运行');
    result.obsVersion = ok(await obs.request('GetVersion')).obsVersion;
    original = await snapshot(obs, stageSource, safeScene);
    const live = original.programScene;
    if (live === safeScene) throw new Error('节目场景已经是安全场景');
    originalItems = (
      ok(await obs.request('GetSceneItemList', { sceneName: live })).sceneItems as SceneItem[]
    ).map((i) => ({
      sceneItemId: i.sceneItemId,
      sceneItemIndex: i.sceneItemIndex,
      enabled: i.sceneItemEnabled,
    }));
    const safeNames = original.safeItems.map((i) => i.sourceName);
    if (safeNames.includes(stageSource) || safeNames.includes(avatarSource))
      throw new Error(`安全场景「${safeScene}」里有 Stage 源或形象源`);

    const sync = await obs.request('GetInputAudioSyncOffset', { inputName: stageSource });
    const avatarInput = ok(await obs.request('GetInputSettings', { inputName: avatarSource }));
    const { url: _url, ...stageSettings } = original.stageSettings;
    const avatarSettings = avatarInput.inputSettings as Record<string, unknown>;
    result.sources = {
      stage: {
        settings: stageSettings,
        audioSyncOffsetMs: sync.ok ? sync.data?.inputAudioSyncOffset : null,
      },
      avatar: {
        kind: avatarInput.inputKind,
        settings: Object.fromEntries(
          ['capture_mode', 'window', 'allow_transparency', 'priority']
            .filter((k) => k in avatarSettings)
            .map((k) => [k, avatarSettings[k]]),
        ),
      },
    };
    const texts = [
      ...(kinds.includes('tone') ? toneSchedule(TONE_FIRST_AT_MS + 60_000).map((a) => a.text) : []),
      ...(kinds.includes('speech') ? SPEECH_TEXTS : []),
    ];
    const layout = await layoutOf(obs, live, stageSource, avatarSource, texts);
    result.layout = layout;
    result.recordDirectory = ok(await obs.request('GetRecordDirectory')).recordDirectory;
    say(
      `布局：${JSON.stringify({ canvas: layout.canvas, output: layout.output, fps: layout.fps, subtitle: layout.subtitle, mouthSearch: layout.mouthSearch, coveringSubtitle: layout.coveringSubtitle })}`,
    );
    if (values.preview) {
      const shots = [
        await screenshot(obs, live, `${out}-preview-program.png`),
        await screenshot(obs, avatarSource, `${out}-preview-avatar.png`),
      ];
      writeFileSync(
        `${out}-preview.json`,
        `${JSON.stringify({ drill: 'av-offset-preview', started, stageSource, avatarSource, shots, ...result }, null, 2)}\n`,
      );
      say(`截图：${shots.join('、')}；盘点写入 ${out}-preview.json`);
      return;
    }
    // 不改场景项顺序：盖住字幕带的只能是允许透明的形象源，被模型挡住的字由分析单独计数。
    const blocking = layout.coveringSubtitle.filter(
      (name) => name !== avatarSource || avatarSettings.allow_transparency !== true,
    );
    if (blocking.length > 0)
      throw new Error(`字幕带被 Stage 源之上的 ${blocking.join('、')} 盖住，录像里看不到字幕`);

    changed = true;
    if (values.fps !== undefined) {
      const fps = Number(values.fps);
      if (!(Number.isInteger(fps) && fps > 0 && fps <= 120))
        throw new Error('--fps 为 1–120 的整数');
      const before = ok(await obs.request('GetVideoSettings'));
      originalFps = {
        fpsNumerator: Number(before.fpsNumerator),
        fpsDenominator: Number(before.fpsDenominator),
      };
      ok(await obs.request('SetVideoSettings', { fpsNumerator: fps, fpsDenominator: 1 }));
      layout.fps = fps;
      say(
        `已把 OBS 帧率临时改为 ${fps}（原为 ${originalFps.fpsNumerator}/${originalFps.fpsDenominator}）`,
      );
    }

    for (const kind of kinds) {
      // 上一个会话停止后宿主切到了安全场景并静音：像操作员一样切回直播场景、取消静音。
      ok(await obs.request('SetCurrentProgramScene', { sceneName: live }));
      ok(await obs.request('SetInputMute', { inputName: stageSource, inputMuted: false }));
      const entry: Record<string, unknown> = { kind };
      sessions.push(entry);
      const profilePath = join(tmpdir(), `bellis-drill-av-${id}-${kind}.profile.json`);
      const configPath = join(tmpdir(), `bellis-drill-av-${id}-${kind}.json`);
      const storePath = join(tmpdir(), `bellis-drill-av-${id}-${kind}.db`);
      temporary.push(profilePath, configPath, storePath, `${storePath}-wal`, `${storePath}-shm`);
      const horizonMs =
        kind === 'tone'
          ? TONE_FIRST_AT_MS + toneSeconds * 1000 + 180_000
          : SPEECH_FIRST_AT_MS + (speechSentences + 30) * SPEECH_EVERY_MS;
      const announcements = kind === 'tone' ? toneSchedule(horizonMs) : speechSchedule(horizonMs);
      const tts =
        kind === 'tone'
          ? [
              {
                id: 'tts',
                plugin: 'tts-sim',
                config: {
                  sampleRate: SAMPLE_RATE,
                  samplesPerChar: SAMPLES_PER_CHAR,
                  frameSamples: 480,
                  toneHz: TONE_HZ,
                },
              },
            ]
          : [
              { id: 'tts', plugin: 'tts-router', config: { order: ['local', 'subtitles'] } },
              {
                id: 'tts-local',
                plugin: 'tts-local',
                config: {
                  backend,
                  qwen3: { speaker: values.speaker, language: 'chinese' },
                  fake: { toneHz: TONE_HZ, chunkSamples: 2400 },
                },
              },
            ];
      writeFileSync(
        profilePath,
        JSON.stringify({
          name: `drill-av-offset-${kind}`,
          packs: [
            {
              name: 'all',
              entries: [
                { id: 'obs', plugin: 'obs-control', grant: ['obs.control'] },
                { id: 'stage-page', plugin: 'stage-page-obs', grant: ['obs.stage-url'] },
                { id: 'stage', plugin: 'stage-service' },
                ...tts,
                { id: 'speech', plugin: 'speech-arbiter', grant: ['speech.output'] },
                {
                  id: 'schedule',
                  plugin: 'speech-schedule',
                  config: { announcements, ttlMs: kind === 'tone' ? 2000 : 30_000 },
                },
                { id: 'moderation', plugin: 'moderation', disabled: true },
                { id: 'avatar', plugin: 'avatar-vts', grant: ['secret:vts'] },
              ],
            },
          ],
        }),
      );
      const config = JSON.parse(JSON.stringify(loadConfig(liveExample)));
      config.profile = profilePath;
      config.safety.emergency = { stageSource, safeScene, stopStream: false };
      config.storePath = storePath;
      writeFileSync(configPath, JSON.stringify(config));

      const launchedAt = Date.now();
      session = await launch({
        configPath,
        secretService: SECRET_SERVICE,
        host: { command: process.execPath, args: [hostMain] },
        watchdog: { command: process.execPath, args: [watchdogMain] },
        stdout: 'pipe',
      });
      const host = new Lines(session.host.stdout);
      void new Lines(session.watchdog.stdout);
      const key = decodeSessionKey(session.info.channelKey);
      const operator = new RpcPeer(
        await connect(session.info.channelPath, Role.Operator, { key }),
        {
          timeoutMs: 10_000,
        },
      );
      const call = (method: string, params: Record<string, unknown> = {}) =>
        operator.request(method, params) as Promise<Record<string, unknown>>;
      try {
        void host
          .wait((l) => l.event === 'avatar.token-requested', 60_000)
          .then(() => say('形象插件在申请令牌：请在 VTube Studio 中允许插件「Bellis」'))
          .catch(() => undefined);
        await host.wait((l) => l.event === 'stage-page.authenticated', 30_000);
        await host.wait((l) => l.event === 'avatar.authenticated', 120_000);
        if (kind === 'speech') {
          say('等本地 TTS 模型就绪……');
          await host.wait(fact('tts.started'), 600_000);
        }
        entry.readyAfterLaunchMs = Date.now() - launchedAt;
        await call(OperatorMethod.Presence);
        for (const deadline = Date.now() + 60_000; ; ) {
          const failures = (await call(OperatorMethod.Preflight, { target: 'M2' }))
            .failures as string[];
          if (failures.length === 0) break;
          if (Date.now() > deadline) throw new Error(`预检未通过：${failures.join('；')}`);
          await sleep(300);
        }
        const schedule = await host.wait(
          (l) => l.event === 'plugin.transition' && l.entryId === 'schedule' && l.to === 'active',
          1000,
        );
        const scheduleAt = Date.parse(schedule.t);
        ok(await obs.request('StartRecord'));
        recording = true;
        await sleep(1000);
        await call(OperatorMethod.Presence);
        const m2 = await call(OperatorMethod.Mode, { target: 'M2' });
        if (m2.ok !== true) throw new Error(`进入 M2 失败：${JSON.stringify(m2)}`);
        const m2At = Date.now();
        const firstDue = announcements.find((a) => scheduleAt + a.atMs > m2At);
        if (!firstDue) throw new Error('排期里没有切到 M2 之后到点的句子');
        entry.m2At = new Date(m2At).toISOString();
        entry.firstDueAfterM2Ms = scheduleAt + firstDue.atMs - m2At;
        say(`${kind}：已切到 M2，首句 ${firstDue.id} 在 ${entry.firstDueAfterM2Ms}ms 后到点`);

        const fromLine = host.items.length;
        const playedSince = () =>
          host.items
            .slice(fromLine)
            .filter(fact('utterance.played'))
            .filter((l) => (l.data as { end?: string }).end === 'complete');
        if (kind === 'tone') {
          await sleep(toneSeconds * 1000);
          const before = host.items.length;
          await host.wait(fact('utterance.played'), 15_000, before).catch(() => undefined);
        } else {
          const deadline = Date.now() + (speechSentences + 10) * SPEECH_EVERY_MS * 2;
          // 在场确认 10 分钟过期（presenceTtlMs），语音会话可能更长：每 2 分钟确认一次。
          let presenceAt = Date.now();
          while (playedSince().length < speechSentences && Date.now() < deadline) {
            await sleep(500);
            if (Date.now() - presenceAt > 120_000) {
              await call(OperatorMethod.Presence);
              presenceAt = Date.now();
            }
          }
          // 正在播的一句播完。
          await host
            .wait(fact('utterance.played'), 30_000, host.items.length)
            .catch(() => undefined);
        }
        // 留出口型闭合与字幕清除的时间再停录制。
        await sleep(1500);
        const path = ok(await obs.request('StopRecord')).outputPath as string;
        recording = false;
        for (let size = -1; ; ) {
          await sleep(1000);
          const active = ok(await obs.request('GetRecordStatus')).outputActive;
          const now = statSync(path).size;
          if (!active && now === size) break;
          size = now;
        }
        entry.recording = { path, bytes: statSync(path).size };
        entry.playedComplete = playedSince().length;
        say(`${kind}：录制已停止 ${path}（${statSync(path).size} 字节）`);
      } finally {
        operator.connection.close();
        if (recording) {
          const stopped = await obs.request('StopRecord').catch(() => undefined);
          recording = false;
          entry.recordingStoppedAfterError = stopped?.data?.outputPath ?? true;
        }
        await session.stop();
        session = undefined;
        writeFileSync(`${out}-${kind}.jsonl`, `${host.raw.join('\n')}\n`);
        entry.page = pageSide(host.items);
      }
      ok(await obs.request('SetCurrentProgramScene', { sceneName: live }));
      ok(await obs.request('SetInputMute', { inputName: stageSource, inputMuted: false }));
    }

    for (const entry of sessions) {
      const path = (entry.recording as { path?: string } | undefined)?.path;
      if (!path) continue;
      say(`分析 ${entry.kind} 录像……`);
      const analysis = await analyzeRecording(path, entry.kind as Kind, layout, `${out}-debug`);
      entry.analysis = analysis;
      entry.span = spanOf(analysis, entry.page as ReturnType<typeof pageSide>);
    }
  } catch (error) {
    result.error = (error as Error).stack ?? String(error);
    say(`实测中止：${(error as Error).message}`);
  } finally {
    if (recording) await obs.request('StopRecord').catch(() => undefined);
    await session?.stop().catch(() => undefined);
    if (original && changed) {
      const steps = await restoreSnapshot(obs, original, stageSource);
      if (originalFps) {
        const back = await obs.request('SetVideoSettings', originalFps);
        if (!back.ok) steps.push(`改回帧率失败：${back.code} ${back.comment ?? ''}`);
      }
      const diffs = differences(original, await snapshot(obs, stageSource, safeScene));
      if (originalFps) {
        const now = ok(await obs.request('GetVideoSettings'));
        if (
          Number(now.fpsNumerator) !== originalFps.fpsNumerator ||
          Number(now.fpsDenominator) !== originalFps.fpsDenominator
        )
          diffs.push(`帧率 ${now.fpsNumerator}/${now.fpsDenominator} 与开始时不同`);
      }
      const items = (
        ok(await obs.request('GetSceneItemList', { sceneName: original.programScene }))
          .sceneItems as SceneItem[]
      ).map((i) => ({
        sceneItemId: i.sceneItemId,
        sceneItemIndex: i.sceneItemIndex,
        enabled: i.sceneItemEnabled,
      }));
      const sort = (list: typeof items) =>
        JSON.stringify([...list].sort((a, b) => a.sceneItemId - b.sceneItemId));
      if (sort(items) !== sort(originalItems))
        diffs.push('直播场景的场景项顺序或启用状态与开始时不同');
      result.obsRestored = { ok: steps.length === 0 && diffs.length === 0, steps, diffs };
      say(`OBS 恢复：${JSON.stringify(result.obsRestored)}`);
    }
    obs.close();
    for (const path of temporary) rmSync(path, { force: true });
  }
  writeFileSync(
    `${out}.json`,
    `${JSON.stringify(
      {
        drill: 'av-offset',
        started,
        finished: new Date().toISOString(),
        node: process.version,
        stageSource,
        avatarSource,
        safeScene,
        kinds,
        toneSeconds,
        speechSentences,
        speechBackend: backend,
        ...result,
      },
      null,
      2,
    )}\n`,
  );
  say(`结果已写入 ${out}.json`);
}

await main();
