/**
 * 探针 S-07 的云端部分：MiniMax 与火山引擎双向流式 TTS 的首包、取消、会话复用、网络与时间戳（见 docs/plan/spikes.md）。
 *
 *   node spikes/s07-tts-cloud.ts --vendor minimax --egress --model speech-2.8-turbo --voice 音色ID
 *   node spikes/s07-tts-cloud.ts --vendor volcengine --egress --speaker 音色ID [--resource-id seed-tts-2.0]
 *        [--timestamps subtitle|timestamp]
 *     公共选项：[--rounds 10] [--cancel-rounds 6] [--cancel-after-ms 300] [--linger-ms 2000]
 *        [--idle-wait-ms 150000] [--piece-chars 2] [--piece-ms 50] [--endpoint …] [--out 结果文件]
 *     --egress  必须显式给出：确认维护者已同意把下面的固定测试句发送给该厂商。
 *     --fake    不连任何厂商：在本机起测试用的假服务器，用来检查探针本身（凭据用随机值）。
 *
 * 每轮依次测（全部用插件的厂商适配器，流式提交除外）：
 *   1. 冷启动：新建引擎（新连接），整句提交。记建连各段耗时（WebSocket 握手含鉴权头、厂商的连接确认、
 *      会话开始）、调用到首个 PCM、发出文本到首个 PCM、合成耗时与音频时长、每次时间戳到达时已收到的音频与覆盖到的时刻；
 *   2. 热启动：同一连接的下一句，整句提交；
 *   3. 取消（前 cancel-rounds 轮）：长句收到首段音频后 cancel-after-ms 取消，测发出取消到厂商确认、到最后一段音频，
 *      取消后仍到达的音频时长、确认取消的事件与计费字数；
 *   4. 复用（同上）：取消确认后在同一连接上停留 linger-ms，记录遗留事件，再合成一句；
 *   5. 流式提交：另开一条连接，握手完成后把一句按 piece-chars 个码点、每 piece-ms 发一片（模拟大模型逐词输出），
 *      测第一片与最后一片到首个 PCM。仲裁按整句提交，插件不支持流式提交，这一项由探针直接按协议收发。
 * 最后一轮的连接不 ping、不主动断开：等服务端空闲断开（至多 idle-wait-ms），记断开原因与空闲时长，再合成一句测重连。
 * 每轮冷启动的音频另存为 WAV，供人工听辨；PCM 的位深与字节序另按小端与大端解码的相邻采样相关性核对。
 *
 * 只发送下面的固定测试句，结果里写明请求数（发出文本的次数）与发送的总码点数。鉴权失败、限流、额度或余额类错误
 * 立即停止，不重试；其它失败连续两次也停止。
 * 凭据按宿主装配插件的方式读取（`pluginSecrets`，只放行 `secret:<厂商>`），来自 SecretStore 服务名 bellis，
 * 只在本进程内用于建连请求头；不复制、不打印、不写进结果。
 * 未覆盖：到 Stage 游标起步的时间（需真实 Stage，见 drill-tts-cloud.ts）；网络抖动注入；
 * 游戏与 OBS 编码同时运行的负载（P1 暂缓）。
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type PluginSecrets, secretPermission, systemClock } from '@bellis/kernel';
import { KeyringSecretStore, MemorySecretStore, type SecretStore } from '@bellis/secret-store';
import { Alignment, type WordStamp } from '@bellis/speech';
import {
  decodeFrame,
  type Engine,
  type EngineStream,
  type EngineTimeouts,
  Event,
  encodeRequest,
  jsonPayload,
  MessageType,
  MINIMAX_ENDPOINT,
  MinimaxEngine,
  type MinimaxOptions,
  redact,
  VOLCENGINE_ENDPOINT,
  VolcengineEngine,
  type VolcengineOptions,
  volcengineHeaders,
  type WireEvent,
} from '@bellis/tts-cloud';
import WebSocket from 'ws';
import { pluginSecrets } from '../packages/host/src/secrets.ts';
import { FakeMinimax } from '../packages/tts-cloud/test/fake-minimax.ts';
import { FakeVolcengine } from '../packages/tts-cloud/test/fake-volcengine.ts';

/** 固定测试句：短句，不含任何个人信息；每句只用一次，避免厂商缓存影响首包。 */
const SENTENCES = [
  '大家好，欢迎来到直播间。',
  '今天我们一起玩魔女审判。',
  '这一关有点难，我们慢慢来。',
  '谢谢你的礼物！',
  '第三章的线索在图书室里。',
  '我觉得凶手不是她。',
  '先存个档，再继续往前走。',
  '大家觉得这个选项怎么样？',
  '好的，那我们就选第二个。',
  '刚才那段剧情真让人难过。',
  '时间不早了，今天就到这里。',
  '下次直播见，拜拜！',
  '这里的音乐很好听。',
  '让我想一想，再做决定。',
  '证据还不够，我们再找找。',
  '这个角色的台词好有意思。',
  '弹幕说得对，我刚才看漏了。',
  '现在是晚上八点整。',
  '接下来进入审判环节。',
  '请大家稍等一下。',
  '这扇门好像锁住了。',
  '我们去走廊看看吧。',
  '桌子上有一封旧信。',
  '这个房间有点暗。',
  '先把这条线索记下来。',
  '她说的话有些奇怪。',
  '我们回到大厅去吧。',
  '窗外开始下雨了。',
  '这把钥匙能打开哪里呢？',
  '再仔细看一下这张照片。',
  '原来答案就在这里。',
  '大家还记得刚才的对话吗？',
  '好，我们继续往下读。',
  '这一段我们再听一遍。',
  '感觉马上就要真相大白了。',
  '休息一下，喝口水。',
  '我们来整理一下证词。',
  '这个推理好像说得通。',
  '先别急，再想想看。',
  '今天的进度还不错。',
  '最后再确认一下存档。',
  '这张地图还没走完。',
  '我们换个思路试试。',
  '这里好像有个暗门。',
  '听，外面有脚步声。',
  '这句台词很关键。',
  '先看看大家的意见。',
  '我们已经很接近了。',
  '这次一定能找到答案。',
];
/** 空闲断开后测重连用的一句。 */
const IDLE_SENTENCE = '好久不见，我们继续吧。';
const LONG_SENTENCE =
  '这是一句用来测量取消的长句子，里面有很多很多的字，让合成需要持续好几秒钟，这样我们才能在中途把它取消掉，看看之后还会不会有音频到达。';
/** 鉴权、限流、额度、余额类错误：立即停止，不重试。 */
const FATAL =
  /鉴权|auth|forbidden|grant|quota|balance|insufficient|arrear|余额|额度|欠费|限流|rate.?limit|\b(1002|1004|1008|1039)\b|HTTP (401|402|403|429)/i;

const clock = systemClock();
const now = () => clock.now();
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const round1 = (v: number) => Math.round(v * 10) / 10;

function summarize(values: readonly number[]) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const r = (v: number | undefined) => (v === undefined ? null : round1(v));
  return {
    n: sorted.length,
    min: r(sorted[0]),
    p50: r(at(0.5)),
    p95: r(at(0.95)),
    p99: r(at(0.99)),
    max: r(sorted.at(-1)),
  };
}

function wav(pcm: Int16Array, sampleRate: number): Buffer {
  const data = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i += 1) data.writeInt16LE(pcm[i] as number, i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * 相邻采样的相关系数：语音按正确的位深与字节序解码时接近 1，字节序弄反时接近 0。
 * `swap` 为真时按大端重新解释同一段字节。
 */
function lag1(pcm: Int16Array, swap: boolean): number | null {
  let num = 0;
  let den = 0;
  const value = (i: number) => {
    const v = pcm[i] as number;
    if (!swap) return v;
    const u = v & 0xffff;
    const s = ((u & 0xff) << 8) | (u >> 8);
    return s >= 0x8000 ? s - 0x10000 : s;
  };
  for (let i = 0; i + 1 < pcm.length; i += 1) {
    const a = value(i);
    num += a * value(i + 1);
    den += a * a;
  }
  return den > 0 ? Math.round((num / den) * 1000) / 1000 : null;
}

function concat(chunks: readonly Int16Array[]): Int16Array {
  const pcm = new Int16Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    pcm.set(c, offset);
    offset += c.length;
  }
  return pcm;
}

/** 请求账：发出文本的次数与码点数。 */
const ledger = { requests: 0, chars: 0 };

interface WordsArrival {
  /** 发出文本到这次时间戳到达（消费端）的毫秒数。 */
  afterTextMs: number;
  /** 这时已收到的音频时长。 */
  audioMs: number;
  /** 这次时间戳覆盖到的最晚结束时刻。 */
  coveredMs: number;
  count: number;
}

/** 一次经适配器的合成：记录线路事件，读完（或在指定时刻取消）并汇总。 */
async function synthesize(
  engine: Engine,
  wire: WireEvent[],
  text: string,
  options: { cancelAfterMs?: number } = {},
) {
  const from = wire.length;
  const startedAt = now();
  const abort = new AbortController();
  const slice = () => wire.slice(from).map(({ vendor: _, ...rest }) => rest);
  const countSent = () => {
    const sent = wire.slice(from).filter((e) => e.kind === 'text-sent').length;
    ledger.requests += sent;
    ledger.chars += sent * [...text].length;
  };
  let stream: EngineStream;
  try {
    stream = await engine.start(text, abort.signal);
  } catch (error) {
    countSent();
    return { text, error: (error as Error).message, events: slice() };
  }
  const chunks: Int16Array[] = [];
  let words: readonly WordStamp[] = [];
  const arrivals: WordsArrival[] = [];
  let samples = 0;
  let firstAudioAt: number | undefined;
  let lastAudioAt: number | undefined;
  let cancelAt: number | undefined;
  let error: string | undefined;
  const textSentAt = () => wire.slice(from).find((e) => e.kind === 'text-sent')?.at ?? startedAt;
  try {
    for await (const chunk of stream.chunks) {
      if (chunk.kind === 'words') {
        words = chunk.words;
        arrivals.push({
          afterTextMs: round1(now() - textSentAt()),
          audioMs: round1((samples * 1000) / stream.sampleRate),
          coveredMs: round1(Math.max(0, ...chunk.words.map((w) => w.endMs))),
          count: chunk.words.length,
        });
        continue;
      }
      firstAudioAt ??= now();
      lastAudioAt = now();
      samples += chunk.pcm.length;
      chunks.push(chunk.pcm);
      if (
        options.cancelAfterMs !== undefined &&
        cancelAt === undefined &&
        now() - firstAudioAt >= options.cancelAfterMs
      ) {
        cancelAt = now();
        abort.abort();
      }
    }
  } catch (e) {
    error = (e as Error).message;
  }
  if (options.cancelAfterMs !== undefined) {
    // 取消之后适配器还在收尾（等厂商确认）：等它结束再统计。
    const deadline = now() + 6000;
    while (
      now() < deadline &&
      !wire
        .slice(from)
        .some((e) => ['cancel-acked', 'cancel-timeout', 'closed', 'failed'].includes(e.kind))
    ) {
      await sleep(20);
    }
    if (cancelAt === undefined && !error) error = '取消前合成已结束';
  }
  countSent();
  const pcm = concat(chunks);
  const events = wire.slice(from);
  const at = (kind: string) => events.find((e) => e.kind === kind)?.at;
  const field = (kind: string, name: string) =>
    events.find((e) => e.kind === kind)?.[name] as number | undefined;
  const textSent = at('text-sent');
  const firstWire = events.find((e) => e.kind === 'audio')?.at;
  const audioMs = (pcm.length * 1000) / stream.sampleRate;
  const alignment = new Alignment(text, stream.sampleRate, { msPerChar: 220 });
  alignment.refine(words);
  const cancelSent = at('cancel-sent');
  const afterCancel = events.filter((e) => e.kind === 'audio-after-cancel');
  const bytesAfterCancel = afterCancel.reduce((n, e) => n + Number(e.bytes ?? 0), 0);
  const acked = events.find((e) => e.kind === 'cancel-acked');
  const done = events.find((e) => e.kind === 'done');
  const usage = events
    .filter((e) => e.kind === 'info' && e.usageCharacters !== undefined)
    .map((e) => e.usageCharacters);
  const infos = events.filter((e) => e.kind === 'info' && typeof e.audioSize === 'number');
  const lastWordEnd = Math.max(0, ...words.map((w) => w.endMs));
  const voicedChars = [...text].filter((c) => !/[\p{P}\p{S}\s]/u.test(c)).length;
  return {
    text,
    error,
    sampleRate: stream.sampleRate,
    connected: events.some((e) => e.kind === 'connected'),
    openMs: field('open', 'ms') ?? null,
    helloMs: field('hello', 'ms') ?? null,
    connectedMs: field('connected', 'ms') ?? null,
    sessionStartedMs: field('session-started', 'ms') ?? null,
    startToFirstPcmMs: firstAudioAt === undefined ? null : round1(firstAudioAt - startedAt),
    textToFirstPcmMs:
      textSent !== undefined && firstWire !== undefined ? round1(firstWire - textSent) : null,
    audioMs: round1(audioMs),
    synthesisMs: textSent !== undefined && done !== undefined ? round1(done.at - textSent) : null,
    lastAudioAfterTextMs:
      lastAudioAt !== undefined && textSent !== undefined ? round1(lastAudioAt - textSent) : null,
    words: {
      count: words.length,
      arrivals,
      firstAfterTextMs: arrivals[0]?.afterTextMs ?? null,
      /** 时间戳全部在最后一段音频之后才到。 */
      onlyAfterLastAudio:
        arrivals.length > 0 &&
        lastAudioAt !== undefined &&
        textSent !== undefined &&
        arrivals.every((a) => a.afterTextMs >= lastAudioAt - textSent),
      /** 最后一个字的结束时刻与音频时长之比：位深或采样率弄错时会明显偏离 1。 */
      lastEndOverAudio:
        audioMs > 0 && words.length > 0 ? Math.round((lastWordEnd / audioMs) * 1000) / 1000 : null,
      refinedChars: alignment.refinedChars,
      voicedChars,
      texts: words.map((w) => w.text),
      events: [...new Set(events.filter((e) => e.kind === 'words').map((e) => e.event))],
    },
    pcm: {
      lag1LittleEndian: lag1(pcm, false),
      lag1Swapped: lag1(pcm, true),
      // MiniMax 的 extra_info：由音频字节数与时长推算每个采样的字节数（16 位单声道应为 2）。
      bytesPerSample: infos.map((e) =>
        typeof e.audioLengthMs === 'number' && e.audioLengthMs > 0
          ? round1(Number(e.audioSize) / ((e.audioLengthMs / 1000) * stream.sampleRate))
          : null,
      ),
      formats: [...new Set(infos.map((e) => e.audioFormat))],
    },
    usage: { minimaxUsageCharacters: usage, volcengine: done?.usage ?? null },
    cancel:
      cancelSent === undefined
        ? undefined
        : {
            audioBeforeCancelMs: round1(
              ((Number(field('cancel-sent', 'samples')) || 0) * 1000) / stream.sampleRate,
            ),
            ackMs: acked ? round1(acked.at - cancelSent) : null,
            ackEvent: acked?.event ?? null,
            pendingFlushesAtAck: acked?.pendingFlushes ?? null,
            flushedAfterCancel: events.filter((e) => e.kind === 'flushed-after-cancel').length,
            lastByteAfterCancelMs:
              afterCancel.length > 0 ? round1((afterCancel.at(-1)?.at ?? 0) - cancelSent) : 0,
            audioAfterCancelMs: round1((bytesAfterCancel / 2 / stream.sampleRate) * 1000),
            usageAfterCancel: [
              ...events
                .filter((e) => e.kind === 'usage-after-cancel')
                .map((e) => e.usageCharacters),
              ...(acked?.usage === undefined ? [] : [acked.usage]),
            ],
            timedOut: events.some((e) => e.kind === 'cancel-timeout'),
          },
    pcmData: pcm,
    events: events.map(({ vendor: _, ...rest }) => rest),
  };
}

type Sample = Awaited<ReturnType<typeof synthesize>>;
type Full = Extract<Sample, { pcm: unknown }>;
const full = (s: Sample | undefined): s is Full => !!s && 'pcm' in s && !s.error;

interface StreamResult {
  text: string;
  error?: string;
  openMs?: number;
  readyMs?: number;
  pieces: number;
  firstPieceToFirstPcmMs: number | null;
  lastPieceToFirstPcmMs: number | null;
  audioMs: number;
  /** 首个 PCM 到达时已发出的片数。 */
  piecesSentAtFirstPcm: number | null;
}

function pieces(text: string, size: number): string[] {
  const chars = [...text];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
  return out;
}

/** 等一个条件成立（消息回调里置位），超时则拒绝。 */
function until(check: () => boolean, ms: number, what: string): Promise<void> {
  return new Promise((done, fail) => {
    const deadline = now() + ms;
    const tick = () => {
      if (check()) done();
      else if (now() > deadline) fail(new Error(`等待${what}超时`));
      else setTimeout(tick, 5);
    };
    tick();
  });
}

/** 流式提交（MiniMax）：task_continue 逐片发送，最后 task_flush。协议同适配器。 */
async function streamMinimax(
  options: MinimaxOptions,
  secret: string,
  text: string,
  pieceChars: number,
  pieceMs: number,
): Promise<StreamResult> {
  const parts = pieces(text, pieceChars);
  const result: StreamResult = {
    text,
    pieces: parts.length,
    firstPieceToFirstPcmMs: null,
    lastPieceToFirstPcmMs: null,
    audioMs: 0,
    piecesSentAtFirstPcm: null,
  };
  const t0 = now();
  const ws = new WebSocket(options.endpoint, {
    headers: { Authorization: `Bearer ${secret}` },
    handshakeTimeout: 10_000,
    perMessageDeflate: false,
  });
  const seen = new Set<string>();
  let failure: string | undefined;
  let bytes = 0;
  let firstPcmAt: number | undefined;
  let sent = 0;
  let firstSentAt: number | undefined;
  let lastSentAt: number | undefined;
  ws.on('message', (data) => {
    let message: {
      event?: string;
      base_resp?: { status_code?: number; status_msg?: string };
      data?: { audio?: string };
    };
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    const code = message.base_resp?.status_code ?? 0;
    if (code !== 0 || message.event === 'task_failed') {
      failure = `MiniMax ${message.event} 错误 ${code}：${redact(message.base_resp?.status_msg ?? '', [secret])}`;
    }
    if (message.event) seen.add(message.event);
    const hex = message.data?.audio;
    if (hex && hex.length > 0) {
      firstPcmAt ??= now();
      result.piecesSentAtFirstPcm ??= sent;
      bytes += hex.length / 2;
    }
  });
  ws.on('error', (e) => {
    failure ??= `连接出错：${e.message}`;
  });
  ws.on('close', (code) => {
    failure ??= seen.has('task_flushed') ? undefined : `连接关闭 ${code}`;
  });
  try {
    await until(() => ws.readyState === WebSocket.OPEN || failure !== undefined, 10_000, '建连');
    if (failure) throw new Error(failure);
    result.openMs = round1(now() - t0);
    await until(() => seen.has('connected_success') || failure !== undefined, 10_000, '连接确认');
    ws.send(
      JSON.stringify({
        event: 'task_start',
        model: options.model,
        voice_setting: {
          voice_id: options.voiceId,
          speed: options.speed,
          vol: options.vol,
          pitch: options.pitch,
        },
        audio_setting: { sample_rate: options.sampleRate, format: 'pcm', channel: 1 },
        subtitle_enable: true,
        subtitle_type: options.subtitleType,
        ...(options.languageBoost ? { language_boost: options.languageBoost } : {}),
      }),
    );
    await until(() => seen.has('task_started') || failure !== undefined, 10_000, 'task_started');
    if (failure) throw new Error(failure);
    result.readyMs = round1(now() - t0);
    ledger.requests += 1;
    ledger.chars += [...text].length;
    for (const part of parts) {
      if (failure) break;
      ws.send(JSON.stringify({ event: 'task_continue', text: part }));
      sent += 1;
      firstSentAt ??= now();
      lastSentAt = now();
      if (sent < parts.length) await sleep(pieceMs);
    }
    ws.send(JSON.stringify({ event: 'task_flush' }));
    await until(() => seen.has('task_flushed') || failure !== undefined, 15_000, 'task_flushed');
    if (failure) throw new Error(failure);
  } catch (e) {
    result.error = (e as Error).message;
  } finally {
    ws.terminate();
  }
  if (firstPcmAt !== undefined && firstSentAt !== undefined && lastSentAt !== undefined) {
    result.firstPieceToFirstPcmMs = round1(firstPcmAt - firstSentAt);
    result.lastPieceToFirstPcmMs = round1(firstPcmAt - lastSentAt);
  }
  result.audioMs = round1((bytes / 2 / options.sampleRate) * 1000);
  return result;
}

/** 流式提交（火山引擎）：同一会话里 TaskRequest 逐片发送，最后 FinishSession。协议同适配器。 */
async function streamVolcengine(
  options: VolcengineOptions,
  secret: string,
  text: string,
  pieceChars: number,
  pieceMs: number,
): Promise<StreamResult> {
  const parts = pieces(text, pieceChars);
  const result: StreamResult = {
    text,
    pieces: parts.length,
    firstPieceToFirstPcmMs: null,
    lastPieceToFirstPcmMs: null,
    audioMs: 0,
    piecesSentAtFirstPcm: null,
  };
  const auth = volcengineHeaders(secret);
  const t0 = now();
  const ws = new WebSocket(options.endpoint, {
    headers: {
      ...auth,
      'X-Api-Resource-Id': options.resourceId,
      'X-Api-Connect-Id': randomBytes(16).toString('hex'),
    },
    handshakeTimeout: 10_000,
    perMessageDeflate: false,
  });
  const sessionId = randomBytes(16).toString('hex');
  const seen = new Set<number>();
  let failure: string | undefined;
  let bytes = 0;
  let firstPcmAt: number | undefined;
  let sent = 0;
  let firstSentAt: number | undefined;
  let lastSentAt: number | undefined;
  ws.on('message', (data, binary) => {
    if (!binary) {
      failure ??= `文本帧：${redact(String(data), Object.values(auth))}`;
      return;
    }
    let frame: ReturnType<typeof decodeFrame>;
    try {
      frame = decodeFrame(data as Buffer);
    } catch {
      return;
    }
    if (
      frame.type === MessageType.Error ||
      frame.event === Event.ConnectionFailed ||
      frame.event === Event.SessionFailed
    ) {
      const meta = jsonPayload(frame);
      failure ??= `火山引擎失败 ${frame.errorCode ?? meta?.status_code ?? ''}：${redact(String(meta?.message ?? meta?.error ?? ''), Object.values(auth))}`;
      return;
    }
    if (frame.event !== undefined) seen.add(frame.event);
    if (frame.event === Event.TTSResponse && frame.id === sessionId && frame.payload.length > 0) {
      firstPcmAt ??= now();
      result.piecesSentAtFirstPcm ??= sent;
      bytes += frame.payload.length;
    }
  });
  ws.on('error', (e) => {
    failure ??= `连接出错：${e.message}`;
  });
  ws.on('close', (code) => {
    failure ??= seen.has(Event.SessionFinished) ? undefined : `连接关闭 ${code}`;
  });
  const params = {
    speaker: options.speaker,
    audio_params: {
      format: 'pcm',
      sample_rate: options.sampleRate,
      speech_rate: options.speechRate,
      loudness_rate: options.loudnessRate,
      ...(options.timestamps === 'subtitle'
        ? { enable_subtitle: true }
        : { enable_timestamp: true }),
    },
  };
  try {
    await until(() => ws.readyState === WebSocket.OPEN || failure !== undefined, 10_000, '建连');
    if (failure) throw new Error(failure);
    result.openMs = round1(now() - t0);
    ws.send(encodeRequest(Event.StartConnection, {}));
    await until(
      () => seen.has(Event.ConnectionStarted) || failure !== undefined,
      10_000,
      '连接确认',
    );
    ws.send(
      encodeRequest(
        Event.StartSession,
        { event: Event.StartSession, namespace: 'BidirectionalTTS', req_params: params },
        sessionId,
      ),
    );
    await until(() => seen.has(Event.SessionStarted) || failure !== undefined, 10_000, '会话开始');
    if (failure) throw new Error(failure);
    result.readyMs = round1(now() - t0);
    ledger.requests += 1;
    ledger.chars += [...text].length;
    for (const part of parts) {
      if (failure) break;
      ws.send(
        encodeRequest(
          Event.TaskRequest,
          {
            event: Event.TaskRequest,
            namespace: 'BidirectionalTTS',
            req_params: { ...params, text: part },
          },
          sessionId,
        ),
      );
      sent += 1;
      firstSentAt ??= now();
      lastSentAt = now();
      if (sent < parts.length) await sleep(pieceMs);
    }
    ws.send(encodeRequest(Event.FinishSession, {}, sessionId));
    await until(
      () => seen.has(Event.SessionFinished) || failure !== undefined,
      15_000,
      'SessionFinished',
    );
    if (failure) throw new Error(failure);
    ws.send(encodeRequest(Event.FinishConnection, {}));
  } catch (e) {
    result.error = (e as Error).message;
  } finally {
    setTimeout(() => ws.terminate(), 200);
  }
  if (firstPcmAt !== undefined && firstSentAt !== undefined && lastSentAt !== undefined) {
    result.firstPieceToFirstPcmMs = round1(firstPcmAt - firstSentAt);
    result.lastPieceToFirstPcmMs = round1(firstPcmAt - lastSentAt);
  }
  result.audioMs = round1((bytes / 2 / options.sampleRate) * 1000);
  return result;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      vendor: { type: 'string' },
      egress: { type: 'boolean', default: false },
      fake: { type: 'boolean', default: false },
      endpoint: { type: 'string' },
      model: { type: 'string' },
      voice: { type: 'string' },
      speaker: { type: 'string' },
      'resource-id': { type: 'string', default: 'seed-tts-2.0' },
      timestamps: { type: 'string', default: 'subtitle' },
      'sample-rate': { type: 'string', default: '24000' },
      rounds: { type: 'string', default: '10' },
      'cancel-rounds': { type: 'string', default: '6' },
      'cancel-after-ms': { type: 'string', default: '300' },
      'linger-ms': { type: 'string', default: '2000' },
      'idle-wait-ms': { type: 'string', default: '150000' },
      'piece-chars': { type: 'string', default: '2' },
      'piece-ms': { type: 'string', default: '50' },
      'pace-ms': { type: 'string', default: '0' },
      'first-round': { type: 'string', default: '1' },
      append: { type: 'boolean', default: false },
      out: { type: 'string' },
    },
  });
  const vendor = values.vendor;
  if (vendor !== 'minimax' && vendor !== 'volcengine') {
    throw new Error('需要 --vendor minimax 或 --vendor volcengine');
  }
  if (!values.egress && !values.fake) {
    throw new Error('需要 --egress：确认维护者已同意把固定测试句发送给该厂商');
  }
  const sampleRate = Number(values['sample-rate']);
  const rounds = Number(values.rounds);
  const cancelRounds = Number(values['cancel-rounds']);
  const cancelAfterMs = Number(values['cancel-after-ms']);
  const lingerMs = Number(values['linger-ms']);
  const idleWaitMs = Number(values['idle-wait-ms']);
  const pieceChars = Number(values['piece-chars']);
  const pieceMs = Number(values['piece-ms']);
  const paceMs = Number(values['pace-ms']);
  const firstRound = Number(values['first-round']);
  if ((firstRound - 1 + rounds) * 4 > SENTENCES.length) {
    throw new Error(`固定测试句只够 ${SENTENCES.length / 4} 轮`);
  }
  if (vendor === 'minimax' && (!values.model || !values.voice)) {
    throw new Error('MiniMax 需要 --model 与 --voice');
  }
  if (vendor === 'volcengine' && !values.speaker) throw new Error('火山引擎需要 --speaker');
  if (values.timestamps !== 'subtitle' && values.timestamps !== 'timestamp') {
    throw new Error('--timestamps 只能是 subtitle 或 timestamp');
  }
  const timestamps = values.timestamps;

  // 凭据：与宿主给插件的凭据服务相同，只放行 secret:<厂商>。--fake 时用随机值与内存存储。
  let store: SecretStore = new KeyringSecretStore('bellis');
  let endpoint = values.endpoint ?? (vendor === 'minimax' ? MINIMAX_ENDPOINT : VOLCENGINE_ENDPOINT);
  const fakes: Array<{ close(): Promise<void> }> = [];
  if (values.fake) {
    const key = randomBytes(12).toString('hex');
    store = new MemorySecretStore();
    await store.set(vendor, key);
    if (vendor === 'minimax') {
      const fake = await FakeMinimax.start({
        apiKey: key,
        sampleRate,
        samplesPerChar: 4800,
        chunkChars: 2,
        chunkDelayMs: 100,
      });
      fakes.push(fake);
      endpoint = fake.url;
    } else {
      const fake = await FakeVolcengine.start({
        apiKey: key,
        sampleRate,
        samplesPerChar: 4800,
        chunkChars: 2,
        chunkDelayMs: 100,
        timestamps: timestamps === 'subtitle' ? 'subtitle-event' : 'sentence-end',
      });
      fakes.push(fake);
      endpoint = fake.url;
    }
  }
  const secrets: PluginSecrets = pluginSecrets(
    store,
    new Set([secretPermission(vendor)]),
    new Set(['session', 'obs', 'obs-sim']),
  );
  const secret = () => secrets.read(vendor);
  if ((await secret()) === undefined) {
    throw new Error(
      `SecretStore（bellis）中没有 ${vendor}，请维护者先用 pnpm secret set ${vendor} 录入`,
    );
  }
  const timeouts: EngineTimeouts = {
    connectTimeoutMs: 10_000,
    firstAudioTimeoutMs: 10_000,
    stallTimeoutMs: 10_000,
    cancelTimeoutMs: 5000,
    idleCloseMs: 120_000,
  };
  const minimaxOptions: MinimaxOptions = {
    endpoint,
    model: values.model ?? '',
    voiceId: values.voice ?? '',
    sampleRate,
    speed: 1,
    vol: 1,
    pitch: 0,
    emotion: '',
    languageBoost: 'Chinese',
    subtitleType: 'word_streaming',
    pingIntervalMs: 30_000,
  };
  const volcengineOptions: VolcengineOptions = {
    endpoint,
    resourceId: values['resource-id'] as string,
    speaker: values.speaker ?? '',
    model: '',
    sampleRate,
    speechRate: 0,
    loudnessRate: 0,
    timestamps,
  };
  const wire: WireEvent[] = [];
  /** idle：最后一轮的连接不 ping、不主动断开，等服务端空闲断开。 */
  const create = (idle: boolean): Engine => {
    const env = { clock, secret, observe: (event: WireEvent) => wire.push(event) };
    const t = idle ? { ...timeouts, idleCloseMs: 3_600_000 } : timeouts;
    return vendor === 'minimax'
      ? new MinimaxEngine(
          {
            ...minimaxOptions,
            ...(idle ? { pingIntervalMs: 3_600_000 } : {}),
          },
          t,
          env,
        )
      : new VolcengineEngine(volcengineOptions, t, env);
  };
  const stream = async (text: string): Promise<StreamResult> => {
    const value = (await secret()) as string;
    return vendor === 'minimax'
      ? streamMinimax(minimaxOptions, value, text, pieceChars, pieceMs)
      : streamVolcengine(volcengineOptions, value, text, pieceChars, pieceMs);
  };

  const started = new Date().toISOString();
  const day = started.slice(0, 10);
  const out = resolve(values.out ?? join('reports', `S-07-cloud-${vendor}-${day}.json`));
  mkdirSync(dirname(out), { recursive: true });
  // --append：接着同一结果文件里此前的轮次（例如被限流停下后放慢速度续测），汇总覆盖全部轮次。
  const previous =
    values.append && existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : undefined;
  const results: Array<Record<string, unknown>> = previous?.results ?? [];
  const thisRun: Record<string, unknown> = {
    started,
    firstRound,
    rounds,
    cancelRounds,
    paceMs,
    idleWaitMs,
  };
  const runs: unknown[] = [
    ...(previous?.runs ??
      (previous
        ? [
            {
              started: previous.started,
              firstRound: 1,
              rounds: previous.rounds,
              cancelRounds: previous.cancelRounds,
              paceMs: 0,
              idleWaitMs: previous.idleWaitMs,
              finished: previous.finished,
              stopped: previous.stopped,
            },
          ]
        : [])),
    thisRun,
  ];
  if (previous?.ledger) {
    ledger.requests = previous.ledger.requests;
    ledger.chars = previous.ledger.chars;
  }
  let idle: Record<string, unknown> | undefined = previous?.idle ?? undefined;
  /** 两次发出文本之间至少隔 pace-ms（厂商按每分钟请求数限流）。 */
  let lastRequestAt = Number.NEGATIVE_INFINITY;
  const pace = async () => {
    const wait = lastRequestAt + paceMs - now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = now();
  };
  let stopped: string | undefined;
  let failuresInRow = 0;
  /** 记一次结果：致命错误或连续两次失败时停止。 */
  const check = (what: string, sample: { error?: string | undefined }) => {
    if (!sample.error) {
      failuresInRow = 0;
      return;
    }
    if (sample.error === '取消前合成已结束') return;
    failuresInRow += 1;
    if (FATAL.test(sample.error))
      stopped = `${what} 失败（鉴权、限流或额度类，停止不重试）：${sample.error}`;
    else if (failuresInRow >= 2) stopped = `连续两次失败，停止：${sample.error}`;
  };
  const strip = (r: Sample) => {
    const { pcmData: _, ...rest } = r as Sample & { pcmData?: Int16Array };
    return rest;
  };
  const meta = () => ({
    spike: 'S-07',
    part: 'cloud',
    vendor,
    fake: values.fake,
    started,
    node: process.version,
    os: { platform: platform(), release: release(), arch: arch() },
    endpoint,
    sampleRate,
    rounds,
    cancelRounds,
    cancelAfterMs,
    lingerMs,
    idleWaitMs,
    pieceChars,
    pieceMs,
    ...(vendor === 'minimax'
      ? { model: values.model, voice: values.voice }
      : { resourceId: values['resource-id'], speaker: values.speaker, timestamps }),
  });
  const save = (summary: unknown) => {
    thisRun.finished = new Date().toISOString();
    thisRun.stopped = stopped ?? null;
    writeFileSync(
      out,
      `${JSON.stringify({ ...meta(), finished: new Date().toISOString(), stopped: stopped ?? null, runs, ledger, summary, idle: idle ?? null, results }, null, 2)}\n`,
    );
  };

  try {
    for (let i = 0; i < rounds && !stopped; i++) {
      const n = firstRound - 1 + i;
      const text = (k: number) => SENTENCES[n * 4 + k] as string;
      const last = i === rounds - 1;
      const engine = create(last);
      const round: Record<string, unknown> = { round: n + 1 };
      results.push(round);
      try {
        await pace();
        const cold = await synthesize(engine, wire, text(0));
        round.cold = strip(cold);
        check('冷启动', cold);
        if (full(cold) && cold.pcmData.length > 0) {
          writeFileSync(
            out.replace(/\.json$/, `-cold-${n + 1}.wav`),
            wav(cold.pcmData, cold.sampleRate),
          );
        }
        if (stopped) break;
        await pace();
        const warm = await synthesize(engine, wire, text(1));
        round.warm = strip(warm);
        check('热启动', warm);
        if (stopped) break;
        if (i < cancelRounds) {
          await pace();
          const canceled = await synthesize(engine, wire, LONG_SENTENCE, { cancelAfterMs });
          round.canceled = strip(canceled);
          check('取消', canceled);
          if (stopped) break;
          const lingerFrom = wire.length;
          await sleep(lingerMs);
          round.staleDuringLinger = wire.slice(lingerFrom).map(({ vendor: _, ...rest }) => rest);
          await pace();
          const reused = await synthesize(engine, wire, text(2));
          round.reuse = strip(reused);
          check('取消后复用', reused);
          if (stopped) break;
        }
        if (last && idleWaitMs > 0) {
          // 空闲断开与重连：不 ping，等服务端断开。
          const waitFrom = wire.length;
          const lastActivity = wire.at(-1)?.at ?? now();
          const deadline = now() + idleWaitMs;
          while (now() < deadline && !wire.slice(waitFrom).some((e) => e.kind === 'closed')) {
            await sleep(200);
          }
          const closed = wire.slice(waitFrom).find((e) => e.kind === 'closed');
          const waitedMs = round1(now() - lastActivity);
          const staleDuringWait = wire.slice(waitFrom).map(({ vendor: _, ...rest }) => rest);
          await pace();
          const reconnect = await synthesize(engine, wire, IDLE_SENTENCE);
          check('空闲后重连', reconnect);
          idle = {
            closedByServer: closed !== undefined,
            closedAfterIdleMs: closed ? round1(closed.at - lastActivity) : null,
            reason: closed?.reason ?? null,
            waitedMs,
            staleDuringWait,
            reconnect: strip(reconnect),
          };
        }
      } finally {
        engine.close();
      }
      if (stopped) break;
      await pace();
      const streamed = await stream(text(3));
      round.stream = streamed;
      check('流式提交', streamed);
      const brief = (r: { error?: string | undefined; startToFirstPcmMs?: number | null }) =>
        r.error ? `失败 ${r.error}` : `首个 PCM ${String(r.startToFirstPcmMs)}ms`;
      const c = round.canceled as Full | undefined;
      console.log(
        `第 ${n + 1} 轮：冷 ${brief(round.cold as Sample)}；热 ${brief(round.warm as Sample)}；` +
          `取消确认 ${String(c?.cancel?.ackMs ?? '—')}ms；流式 ${streamed.error ?? `${String(streamed.firstPieceToFirstPcmMs)}ms`}；` +
          `累计请求 ${ledger.requests}、码点 ${ledger.chars}`,
      );
      save(null);
    }
  } finally {
    for (const fake of fakes) await fake.close();
  }

  const pick = (key: string) => results.map((r) => r[key] as Sample | undefined).filter(full);
  const metric = (samples: Full[], get: (s: Full) => number | null | undefined) =>
    summarize(samples.map((s) => get(s)).filter((v): v is number => typeof v === 'number'));
  const cold = pick('cold');
  const warm = pick('warm');
  const reuse = pick('reuse');
  const canceled = results
    .map((r) => r.canceled as Sample | undefined)
    .filter((s): s is Full => !!s && 'cancel' in s && s.cancel !== undefined);
  const streams = results
    .map((r) => r.stream as StreamResult | undefined)
    .filter((s): s is StreamResult => !!s && !s.error);
  const all = [...cold, ...warm, ...reuse];
  const summary = {
    failures: results.flatMap((r) =>
      Object.entries(r)
        .filter(
          ([, v]) => typeof v === 'object' && v !== null && 'error' in v && (v as Sample).error,
        )
        .map(([k, v]) => `第 ${String(r.round)} 轮 ${k}：${String((v as Sample).error)}`),
    ),
    connect: {
      openMs: metric(cold, (s) => s.openMs),
      helloMs: metric(cold, (s) => s.helloMs),
      connectedMs: metric(cold, (s) => s.connectedMs),
      sessionStartedMs: metric(all, (s) => s.sessionStartedMs),
    },
    coldStartToFirstPcmMs: metric(cold, (s) => s.startToFirstPcmMs),
    coldTextToFirstPcmMs: metric(cold, (s) => s.textToFirstPcmMs),
    warmStartToFirstPcmMs: metric(warm, (s) => s.startToFirstPcmMs),
    warmTextToFirstPcmMs: metric(warm, (s) => s.textToFirstPcmMs),
    reuseStartToFirstPcmMs: metric(reuse, (s) => s.startToFirstPcmMs),
    reuseReconnected: reuse.filter((s) => s.connected).length,
    streamFirstPieceToFirstPcmMs: summarize(
      streams.map((s) => s.firstPieceToFirstPcmMs ?? Number.NaN),
    ),
    streamLastPieceToFirstPcmMs: summarize(
      streams.map((s) => s.lastPieceToFirstPcmMs ?? Number.NaN),
    ),
    streamAudioBeforeLastPiece: streams.filter((s) => (s.lastPieceToFirstPcmMs ?? 0) < 0).length,
    realTimeFactor: summarize(
      [...cold, ...warm].map((s) =>
        s.synthesisMs !== null && s.audioMs > 0 ? s.synthesisMs / s.audioMs : Number.NaN,
      ),
    ),
    audioMsPerChar: summarize([...cold, ...warm].map((s) => s.audioMs / [...s.text].length)),
    words: {
      firstAfterTextMs: metric(all, (s) => s.words.firstAfterTextMs),
      /** 每次到达时“已收到的音频 − 覆盖到的时刻”：正数表示时间戳落后于音频。 */
      lagBehindAudioMs: summarize(
        all.flatMap((s) => s.words.arrivals.map((a) => a.audioMs - a.coveredMs)),
      ),
      onlyAfterLastAudio: all.filter((s) => s.words.onlyAfterLastAudio).length,
      withoutWords: all.filter((s) => s.words.count === 0).length,
      refinedShare: summarize(
        all.map((s) => s.words.refinedChars / Math.max(1, [...s.text].length)),
      ),
      lastEndOverAudio: summarize(all.map((s) => s.words.lastEndOverAudio ?? Number.NaN)),
      events: [...new Set(all.flatMap((s) => s.words.events))],
    },
    pcm: {
      lag1LittleEndian: summarize(cold.map((s) => s.pcm.lag1LittleEndian ?? Number.NaN)),
      lag1Swapped: summarize(cold.map((s) => s.pcm.lag1Swapped ?? Number.NaN)),
      bytesPerSample: [...new Set(all.flatMap((s) => s.pcm.bytesPerSample))],
      formats: [...new Set(all.flatMap((s) => s.pcm.formats))],
    },
    cancel: {
      n: canceled.length,
      audioBeforeCancelMs: summarize(
        canceled.map((s) => s.cancel?.audioBeforeCancelMs ?? Number.NaN),
      ),
      ackMs: summarize(canceled.map((s) => s.cancel?.ackMs ?? Number.NaN)),
      lastByteAfterCancelMs: summarize(
        canceled.map((s) => s.cancel?.lastByteAfterCancelMs ?? Number.NaN),
      ),
      audioAfterCancelMs: summarize(
        canceled.map((s) => s.cancel?.audioAfterCancelMs ?? Number.NaN),
      ),
      ackEvents: canceled.map((s) => s.cancel?.ackEvent ?? null),
      pendingFlushesAtAck: canceled.map((s) => s.cancel?.pendingFlushesAtAck ?? null),
      flushedAfterCancel: canceled.map((s) => s.cancel?.flushedAfterCancel ?? 0),
      usageAfterCancel: canceled.map((s) => s.cancel?.usageAfterCancel ?? []),
      timedOut: canceled.filter((s) => s.cancel?.timedOut).length,
      staleDuringLinger: results.map(
        (r) => (r.staleDuringLinger as unknown[] | undefined)?.length ?? null,
      ),
    },
    usage: all.map((s) => s.usage),
  };
  save(summary);
  console.log(JSON.stringify({ ledger, stopped: stopped ?? null, summary }, null, 2));
  console.log(`结果已写入 ${out}`);
  if (stopped) {
    console.error(`已停止：${stopped}`);
    process.exitCode = 1;
  }
}

await main();
