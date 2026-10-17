/**
 * 探针 S-07 的云端部分：MiniMax 与火山引擎双向流式 TTS 的首包、取消、会话复用与时间戳（见 docs/plan/spikes.md）。
 *
 *   node spikes/s07-tts-cloud.ts --vendor minimax --egress --model speech-2.8-turbo --voice 音色ID
 *        [--endpoint wss://api.minimax.cn/ws/v1/t2a_v2_bidi] [--trials 10] [--out 结果文件]
 *   node spikes/s07-tts-cloud.ts --vendor volcengine --egress --speaker 音色ID
 *        [--resource-id seed-tts-2.0] [--timestamps subtitle|timestamp] [--trials 10] [--out 结果文件]
 *     --egress           必须显式给出：确认维护者已同意把下面的固定测试句发送给该厂商。
 *     --sample-rate      请求的采样率（缺省 24000）
 *     --cancel-after-ms  取消样本在收到首段音频后多久取消（缺省 300）
 *     --linger-ms        取消确认后在同一连接上继续观察遗留事件的时长（缺省 2000）
 *
 * 每轮依次测：
 *   1. 冷启动（新连接）：建连耗时、提交到首个 PCM、整句音频时长与合成耗时、时间戳首次到达的时刻与覆盖的码点数；
 *   2. 热启动（同一连接的下一句）：提交到首个 PCM；
 *   3. 取消：收到首段音频后取消，测发出取消到厂商确认、到最后一段音频的时间，以及取消后仍到达的音频时长与计费字数；
 *   4. 复用：取消确认后在同一连接上停留，记录遗留事件，再合成一句，核对能否照常出声。
 *      MiniMax 的复用样本开启 reuseAfterCancel（插件缺省不复用，见适配器说明）。
 * 首轮冷启动的音频另存为 WAV，供人工听辨 PCM 的位深与字节序是否正确，并作为人工标注时间戳偏差的素材；
 * 结果里带每句的时间戳，人工标注后对照字偏差（约 20 句）。
 *
 * 凭据：从 SecretStore 服务名 bellis 读出 minimax 或 volcengine，复制到一个临时服务名，适配器经临时条目读取；
 * 结束时删除临时条目，不碰 bellis 下的条目。凭据的值不打印、不写进结果。
 * 未覆盖：到 Stage 游标起步的时间（需真实 Stage，随第 10 步演练测）；流式逐字提交（仲裁按整句提交）；
 * 游戏与 OBS 编码同时运行的负载由维护者在运行本探针时自行布置并记在报告里。
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { systemClock } from '@bellis/kernel';
import { KeyringSecretStore } from '@bellis/secret-store';
import { Alignment } from '@bellis/speech';
import {
  type Engine,
  type EngineStream,
  type EngineTimeouts,
  MINIMAX_ENDPOINT,
  MinimaxEngine,
  VOLCENGINE_ENDPOINT,
  VolcengineEngine,
  type WireEvent,
} from '@bellis/tts-cloud';

/** 固定测试句：短句、带数字与标点，不含任何个人信息。 */
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
];
const LONG_SENTENCE =
  '这是一句用来测量取消的长句子，里面有很多很多的字，让合成需要持续好几秒钟，这样我们才能在中途把它取消掉，看看之后还会不会有音频到达。';

const clock = systemClock();
const now = () => clock.now();

function summarize(values: readonly number[]) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const round = (v: number | undefined) => (v === undefined ? null : Math.round(v * 10) / 10);
  return {
    n: sorted.length,
    min: round(sorted[0]),
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    max: round(sorted.at(-1)),
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

/** 一次合成：记录线路事件，读完（或在指定时刻取消）并汇总。 */
async function synthesize(
  engine: Engine,
  wire: WireEvent[],
  text: string,
  options: { cancelAfterMs?: number } = {},
) {
  const from = wire.length;
  const startedAt = now();
  const abort = new AbortController();
  let stream: EngineStream;
  try {
    stream = await engine.start(text, abort.signal);
  } catch (error) {
    return { text, error: (error as Error).message, events: wire.slice(from) };
  }
  const returnedAt = now();
  const chunks: Int16Array[] = [];
  let words: ReadonlyArray<{ text: string; startMs: number; endMs: number }> = [];
  let firstAudioAt: number | undefined;
  let cancelAt: number | undefined;
  let error: string | undefined;
  try {
    for await (const chunk of stream.chunks) {
      if (chunk.kind === 'words') {
        words = chunk.words;
        continue;
      }
      firstAudioAt ??= now();
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
  if (options.cancelAfterMs !== undefined && cancelAt === undefined && !error) {
    // 整句在取消时刻之前就已合成完：这个样本测不到取消。
    error = '取消前合成已结束';
  }
  const pcm = new Int16Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    pcm.set(c, offset);
    offset += c.length;
  }
  const alignment = new Alignment(text, stream.sampleRate, { msPerChar: 220 });
  alignment.refine(words);
  const events = wire.slice(from);
  const at = (kind: string, last = false) => {
    const list = events.filter((e) => e.kind === kind);
    return (last ? list.at(-1) : list[0])?.at;
  };
  const textSent = at('text-sent');
  const firstWire = events.find((e) => e.kind === 'audio')?.at;
  const firstWords = at('words');
  const cancelSent = at('cancel-sent');
  const afterCancel = events.filter((e) => e.kind === 'audio-after-cancel');
  const bytesAfterCancel = afterCancel.reduce((n, e) => n + Number(e.bytes ?? 0), 0);
  const info = events.filter((e) => e.kind === 'info');
  return {
    text,
    error,
    sampleRate: stream.sampleRate,
    connected: events.some((e) => e.kind === 'connected'),
    connectMs: events.find((e) => e.kind === 'connected')?.ms ?? null,
    submitToFirstPcmMs:
      textSent !== undefined && firstWire !== undefined ? firstWire - textSent : null,
    startToReturnMs: returnedAt - startedAt,
    audioMs: (pcm.length * 1000) / stream.sampleRate,
    synthesisMs: (at('done') ?? now()) - (textSent ?? startedAt),
    wordsFirstAfterSubmitMs:
      firstWords !== undefined && textSent !== undefined ? firstWords - textSent : null,
    wordsCount: words.length,
    refinedChars: alignment.refinedChars,
    chars: [...text].length,
    words,
    cancel:
      cancelSent === undefined
        ? undefined
        : {
            ackMs: (at('cancel-acked') ?? Number.NaN) - cancelSent,
            lastAudioAfterCancelMs:
              afterCancel.length > 0 ? (afterCancel.at(-1)?.at ?? 0) - cancelSent : 0,
            audioAfterCancelMs: (bytesAfterCancel / 2 / stream.sampleRate) * 1000,
            acked: events.find((e) => e.kind === 'cancel-acked') ?? null,
            timedOut: events.some((e) => e.kind === 'cancel-timeout'),
          },
    // MiniMax 的 extra_info：由音频字节数与时长推算每个采样的字节数（16 位单声道应为 2）。
    pcmInfo: info.map((e) => ({
      ...e,
      bytesPerSample:
        typeof e.audioSize === 'number' &&
        typeof e.audioLengthMs === 'number' &&
        e.audioLengthMs > 0
          ? e.audioSize / ((e.audioLengthMs / 1000) * stream.sampleRate)
          : null,
    })),
    pcm,
    events: events.map(({ vendor: _, ...rest }) => rest),
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      vendor: { type: 'string' },
      egress: { type: 'boolean', default: false },
      endpoint: { type: 'string' },
      model: { type: 'string' },
      voice: { type: 'string' },
      speaker: { type: 'string' },
      'resource-id': { type: 'string', default: 'seed-tts-2.0' },
      timestamps: { type: 'string', default: 'subtitle' },
      'sample-rate': { type: 'string', default: '24000' },
      trials: { type: 'string', default: '10' },
      'cancel-after-ms': { type: 'string', default: '300' },
      'linger-ms': { type: 'string', default: '2000' },
      out: { type: 'string' },
    },
  });
  const vendor = values.vendor;
  if (vendor !== 'minimax' && vendor !== 'volcengine') {
    throw new Error('需要 --vendor minimax 或 --vendor volcengine');
  }
  if (!values.egress) {
    throw new Error('需要 --egress：确认维护者已同意把固定测试句发送给该厂商');
  }
  const sampleRate = Number(values['sample-rate']);
  const trials = Number(values.trials);
  const cancelAfterMs = Number(values['cancel-after-ms']);
  const lingerMs = Number(values['linger-ms']);
  if (vendor === 'minimax' && (!values.model || !values.voice)) {
    throw new Error('MiniMax 需要 --model 与 --voice');
  }
  if (vendor === 'volcengine' && !values.speaker) throw new Error('火山引擎需要 --speaker');
  if (values.timestamps !== 'subtitle' && values.timestamps !== 'timestamp') {
    throw new Error('--timestamps 只能是 subtitle 或 timestamp');
  }
  const timestamps = values.timestamps;

  const value = await new KeyringSecretStore('bellis').get(vendor);
  if (!value)
    throw new Error(
      `SecretStore（bellis）中没有 ${vendor}，请维护者先用 pnpm secret set ${vendor} 录入`,
    );
  const service = `bellis-s07-${randomBytes(4).toString('hex')}`;
  const store = new KeyringSecretStore(service);
  const timeouts: EngineTimeouts = {
    connectTimeoutMs: 10_000,
    firstAudioTimeoutMs: 10_000,
    stallTimeoutMs: 10_000,
    cancelTimeoutMs: 5000,
    idleCloseMs: 120_000,
  };
  const endpoint =
    values.endpoint ?? (vendor === 'minimax' ? MINIMAX_ENDPOINT : VOLCENGINE_ENDPOINT);
  const wire: WireEvent[] = [];
  const create = (reuseAfterCancel = false): Engine => {
    const env = {
      clock,
      secret: () => store.get(vendor),
      observe: (event: WireEvent) => wire.push(event),
    };
    return vendor === 'minimax'
      ? new MinimaxEngine(
          {
            endpoint,
            model: values.model as string,
            voiceId: values.voice as string,
            sampleRate,
            speed: 1,
            vol: 1,
            pitch: 0,
            emotion: '',
            languageBoost: 'Chinese',
            subtitleType: 'word_streaming',
            pingIntervalMs: 30_000,
            reuseAfterCancel,
          },
          timeouts,
          env,
        )
      : new VolcengineEngine(
          {
            endpoint,
            resourceId: values['resource-id'] as string,
            speaker: values.speaker as string,
            model: '',
            sampleRate,
            speechRate: 0,
            loudnessRate: 0,
            timestamps,
          },
          timeouts,
          env,
        );
  };

  const started = new Date().toISOString();
  const day = started.slice(0, 10);
  const out = resolve(values.out ?? join('reports', `S-07-cloud-${vendor}-${day}.json`));
  mkdirSync(dirname(out), { recursive: true });
  const results: Array<Record<string, unknown>> = [];
  try {
    await store.set(vendor, value);
    for (let n = 0; n < trials; n++) {
      const sentence = (i: number) => SENTENCES[(n * 2 + i) % SENTENCES.length] as string;
      const engine = create();
      const cold = await synthesize(engine, wire, sentence(0));
      const warm = await synthesize(engine, wire, sentence(1));
      const canceled = await synthesize(engine, wire, LONG_SENTENCE, { cancelAfterMs });
      engine.close();
      if (n === 0 && 'pcm' in cold && cold.pcm.length > 0) {
        writeFileSync(
          out.replace(/\.json$/, '-cold.wav'),
          wav(cold.pcm, cold.sampleRate ?? sampleRate),
        );
      }
      // 复用：取消确认后在同一连接上停留，记录遗留事件，再合成一句。
      const reuseEngine = create(true);
      await synthesize(reuseEngine, wire, sentence(0));
      const reuseCanceled = await synthesize(reuseEngine, wire, LONG_SENTENCE, { cancelAfterMs });
      const lingerFrom = wire.length;
      await new Promise((wait) => setTimeout(wait, lingerMs));
      const stale = wire.slice(lingerFrom).map(({ vendor: _, ...rest }) => rest);
      const reused = await synthesize(reuseEngine, wire, sentence(1));
      reuseEngine.close();
      const strip = (r: Record<string, unknown>) => {
        const { pcm: _, ...rest } = r;
        return rest;
      };
      results.push({
        trial: n + 1,
        cold: strip(cold),
        warm: strip(warm),
        canceled: strip(canceled),
        reuse: {
          canceled: strip(reuseCanceled),
          staleDuringLinger: stale,
          next: strip(reused),
          reconnected: 'connected' in reused ? reused.connected : null,
        },
      });
      const brief = (r: Record<string, unknown>) =>
        r.error ? `失败 ${String(r.error)}` : `首个 PCM ${String(r.submitToFirstPcmMs)}ms`;
      console.log(
        `第 ${n + 1} 轮：冷 ${brief(cold)}；热 ${brief(warm)}；取消确认 ${String(
          (canceled as { cancel?: { ackMs: number } }).cancel?.ackMs ?? '—',
        )}ms`,
      );
    }
  } finally {
    await store.delete(vendor);
  }

  type Sample = Record<string, unknown> & { cancel?: Record<string, number> };
  const pick = (key: 'cold' | 'warm' | 'canceled') =>
    results.map((r) => r[key] as Sample).filter((s) => !s.error);
  const metric = (samples: Sample[], key: string) =>
    summarize(samples.map((s) => Number(s[key])).filter((v) => !Number.isNaN(v)));
  const summary = {
    failures: {
      cold: results.filter((r) => (r.cold as Sample).error).length,
      warm: results.filter((r) => (r.warm as Sample).error).length,
      canceled: results.filter((r) => (r.canceled as Sample).error).length,
    },
    connectMs: metric(pick('cold'), 'connectMs'),
    coldSubmitToFirstPcmMs: metric(pick('cold'), 'submitToFirstPcmMs'),
    warmSubmitToFirstPcmMs: metric(pick('warm'), 'submitToFirstPcmMs'),
    realTimeFactor: summarize(
      pick('cold').map((s) => Number(s.synthesisMs) / Math.max(1, Number(s.audioMs))),
    ),
    wordsFirstAfterSubmitMs: metric(pick('cold'), 'wordsFirstAfterSubmitMs'),
    refinedShare: summarize(
      pick('cold').map((s) => Number(s.refinedChars) / Math.max(1, Number(s.chars))),
    ),
    cancelAckMs: summarize(pick('canceled').map((s) => Number(s.cancel?.ackMs))),
    lastAudioAfterCancelMs: summarize(
      pick('canceled').map((s) => Number(s.cancel?.lastAudioAfterCancelMs)),
    ),
    audioAfterCancelMs: summarize(
      pick('canceled').map((s) => Number(s.cancel?.audioAfterCancelMs)),
    ),
    reuseAfterCancelOk: results.filter((r) => !(r.reuse as { next: Sample }).next.error).length,
  };
  writeFileSync(
    out,
    `${JSON.stringify(
      {
        spike: 'S-07',
        part: 'cloud',
        vendor,
        started,
        finished: new Date().toISOString(),
        node: process.version,
        os: { platform: platform(), release: release(), arch: arch() },
        endpoint,
        sampleRate,
        trials,
        cancelAfterMs,
        lingerMs,
        ...(vendor === 'minimax'
          ? { model: values.model, voice: values.voice }
          : { resourceId: values['resource-id'], speaker: values.speaker, timestamps }),
        summary,
        results,
      },
      null,
      2,
    )}\n`,
  );
  console.log(JSON.stringify(summary, null, 2));
  console.log(`结果已写入 ${out}`);
}

await main();
