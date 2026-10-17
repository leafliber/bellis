/**
 * P1 第 10 步的真机诊断：静默之后第一句的开头在 OBS 录音里缺几十毫秒（长测冒烟中首句缺 60ms）。
 *
 *   node spikes/drill-stage-silence.ts --stage-source 名字 [--gaps 0.5,2,3,4,5,15,60] [--repeats 3]
 *                                       [--initial 8] [--sentence-seconds 1.5] [--out 结果文件前缀]
 *
 * 本进程装配真实 Stage 页面（spikes/stage-harness.ts，本进程扮演 Stage 服务），页面认证后先静默 --initial 秒，
 * 再按 --gaps 依次在不同长度的静默之后各播一句测试音（440Hz、从相位 0 起），整组重复 --repeats 次。
 * 静默从页面回报上一句播完算起。全程分段录制：静默不短于 20 秒时在其中换段，每段一般不到 1 分钟。
 * 结束后逐段按句段分析录音，按顺序对应到句子：录音里这句比实际短多少、起点相位（判断缺的是开头还是结尾）。
 * 同时记下 OBS 音量表里 Stage 源每次读数是否出现：OBS 只为正在送来音频的来源报音量，读数消失即浏览器源
 * 在静默中不再向 OBS 送音频；记下它在静默后多久消失、句子开始后多久重新出现。
 *
 * 只改写浏览器源的 URL 并开关录制；推流或录制进行中、或有别的 Bellis 进程在运行时拒绝运行；结束后恢复。
 * 录制文件保留在 OBS 的录制目录。
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { OBS_SECRET, readObsSecret } from '@bellis/config';
import { ObsClient, type ObsResult } from '@bellis/obs';
import { KeyringSecretStore } from '@bellis/secret-store';
import { waitForNoOtherBellis } from './bellis-processes.ts';
import { differences, restoreSnapshot, snapshot } from './obs-snapshot.ts';
import {
  analyzeSegments,
  type Segment,
  type WindowLevel,
  windowLevels,
} from './s01-stage/analyze-recording.ts';
import { type MeterReading, ObsMeters } from './s01-stage/meters.ts';
import { startStageHarness } from './stage-harness.ts';

const TONE_HZ = 440;
const SOUND_DB = -40;
/** 不短于这么长的静默里换录制段。 */
const SPLIT_GAP_SECONDS = 20;

function ok(result: ObsResult): Record<string, unknown> {
  if (!result.ok)
    throw new Error(`${result.requestType} 失败：${result.code} ${result.comment ?? ''}`);
  return result.data ?? {};
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

interface Sentence {
  index: number;
  gapSeconds: number | 'initial';
  recording: number;
  sentAt: number;
  startedAt: number | null;
  finishedAt: number;
  finished: unknown;
  /** 上一句播完（或页面认证）到这一句发出的实际静默。 */
  silenceMs: number;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'stage-source': { type: 'string' },
      'safe-scene': { type: 'string', default: 'Safe' },
      gaps: { type: 'string', default: '0.5,2,3,4,5,15,60' },
      repeats: { type: 'string', default: '3' },
      initial: { type: 'string', default: '8' },
      'sentence-seconds': { type: 'string', default: '1.5' },
      out: { type: 'string' },
    },
  });
  const stageSource = values['stage-source'];
  if (!stageSource) throw new Error('需要 --stage-source');
  const gaps = values.gaps.split(',').map(Number);
  const repeats = Number(values.repeats);
  const initialSeconds = Number(values.initial);
  const sentenceSeconds = Number(values['sentence-seconds']);
  const started = new Date().toISOString();
  const out = resolve(
    values.out ?? join('reports', `drill-stage-silence-${started.replace(/[:.]/g, '-')}`),
  );
  const say = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

  await waitForNoOtherBellis({ log: say });
  const secret = await readObsSecret(new KeyringSecretStore('bellis'), OBS_SECRET);
  const obs = await ObsClient.connect(secret.url, secret.password);
  /** 每次音量表事件里 Stage 源是否出现、峰值多少。 */
  const meter: Array<{ at: number; present: boolean; db: number | null }> = [];
  const meters = await ObsMeters.connect(
    secret.url,
    secret.password,
    (readings: MeterReading[]) => {
      const reading = readings.find((r) => r.name === stageSource);
      meter.push({
        at: Date.now(),
        present: reading !== undefined,
        db: reading && Number.isFinite(reading.peakDb) ? round(reading.peakDb) : null,
      });
    },
  );
  const original = await snapshot(obs, stageSource, values['safe-scene']);
  const result: Record<string, unknown> = {
    gaps,
    repeats,
    initialSeconds,
    sentenceSeconds,
  };
  const recordings: Array<{ path: string; startedAt: number; stoppedAt: number }> = [];
  let recordingSince: number | undefined;
  const sentences: Sentence[] = [];
  let harness: Awaited<ReturnType<typeof startStageHarness>> | undefined;

  const startRecording = async () => {
    ok(await obs.request('StartRecord'));
    recordingSince = Date.now();
    say(`录制第 ${recordings.length + 1} 段`);
  };
  const stopRecording = async () => {
    if (recordingSince === undefined) return;
    const path = ok(await obs.request('StopRecord')).outputPath as string;
    const stoppedAt = Date.now();
    recordings.push({ path, startedAt: recordingSince, stoppedAt });
    recordingSince = undefined;
    // StopRecord 返回时 OBS 可能还在写文件末尾：等录制确实停下、文件大小稳定。
    for (let size = -1; ; ) {
      await sleep(1000);
      const active = ok(await obs.request('GetRecordStatus')).outputActive;
      const now = statSync(path).size;
      if (!active && now === size) break;
      size = now;
    }
  };

  try {
    if (ok(await obs.request('GetStreamStatus')).outputActive)
      throw new Error('推流进行中，拒绝运行');
    if (ok(await obs.request('GetRecordStatus')).outputActive)
      throw new Error('录制进行中，拒绝运行');
    if (original.programScene === values['safe-scene'])
      throw new Error('节目场景是安全场景，Stage 源不在节目里');
    ok(await obs.request('SetInputMute', { inputName: stageSource, inputMuted: false }));
    result.obsVersion = ok(await obs.request('GetVersion')).obsVersion;

    harness = await startStageHarness({
      url: secret.url,
      password: secret.password,
      stageSource,
    });
    await harness.waitReady(30_000);
    const authenticatedAt = Date.now();
    say(`页面已认证，静默 ${initialSeconds} 秒后开始`);
    await startRecording();
    await sleep(initialSeconds * 1000);

    const plan: Array<number | 'initial'> = ['initial'];
    for (let r = 0; r < repeats; r++) plan.push(...gaps);
    let lastFinished = authenticatedAt;
    for (const [index, gap] of plan.entries()) {
      if (gap !== 'initial') {
        const wait = gap * 1000;
        if (gap >= SPLIT_GAP_SECONDS) {
          // 在长静默里换段：静默开始 3 秒后停，离下一句还有 10 秒时开新的一段。
          await sleep(3000);
          await stopRecording();
          await sleep(Math.max(0, lastFinished + wait - 10_000 - Date.now()));
          await startRecording();
        }
        await sleep(Math.max(0, lastFinished + wait - Date.now()));
      }
      const silenceMs = Date.now() - lastFinished;
      const played = await harness.play(sentenceSeconds);
      lastFinished = played.finishedAt;
      sentences.push({
        index,
        gapSeconds: gap,
        recording: recordings.length,
        sentAt: played.sentAt,
        startedAt: played.startedAt,
        finishedAt: played.finishedAt,
        finished: played.finished,
        silenceMs,
      });
      say(
        `第 ${index} 句（静默 ${round(silenceMs / 1000, 2)} 秒）：${JSON.stringify(played.finished)}`,
      );
    }
    await sleep(3000);
    await stopRecording();

    // ---------------- 分析 ----------------
    const expectedSeconds = sentenceSeconds;
    const perRecording: Array<Record<string, unknown>> = [];
    const segmentsByRecording: Segment[][] = [];
    /** 句前唤醒信号所在窗口与静默中段的电平（只量前面静默不短于 1 秒的句子），键为“录音:句段”。 */
    const preRoll = new Map<
      string,
      { silence: WindowLevel | undefined; wake: WindowLevel | undefined }
    >();
    for (const [i, recording] of recordings.entries()) {
      say(`分析第 ${i + 1} 段录音……`);
      // 句前可能有唤醒信号（峰值 -50dBFS）：无声阈值调到 0.05，免得把它算进句段。
      const analysis = await analyzeSegments(recording.path, {
        toneHz: TONE_HZ,
        expectedSeconds,
        silence: 0.05,
      });
      const listed = analysis.segments.listed;
      segmentsByRecording.push(listed);
      const quiet = listed.flatMap((segment, k) => {
        const previous = listed[k - 1];
        const gapStart = previous ? previous.atSeconds + previous.seconds : 0;
        return segment.atSeconds - gapStart >= 1 ? [k] : [];
      });
      const levels = await windowLevels(
        recording.path,
        quiet.flatMap((k) => {
          const at = listed[k]?.atSeconds ?? 0;
          return [
            [at - 0.8, at - 0.7],
            [at - 0.12, at - 0.002],
          ] as Array<readonly [number, number]>;
        }),
      );
      for (const [j, k] of quiet.entries())
        preRoll.set(`${i}:${k}`, { silence: levels[j * 2], wake: levels[j * 2 + 1] });
      perRecording.push({
        path: recording.path,
        bytes: statSync(recording.path).size,
        seconds: round(analysis.seconds, 2),
        segments: analysis.segments.count,
        sentences: sentences.filter((s) => s.recording === i).length,
        spikes: analysis.spikes.count,
        discontinuities: analysis.discontinuities.count,
        hz: analysis.hz,
      });
    }
    const rows = sentences.map((s) => {
      const inRecording = sentences.filter((x) => x.recording === s.recording);
      const segments = segmentsByRecording[s.recording] ?? [];
      const segment =
        segments.length === inRecording.length ? segments[inRecording.indexOf(s)] : undefined;
      const shortMs = segment ? round((expectedSeconds - segment.seconds) * 1000) : null;
      // 音量表：上一句播完到这一句发出之间 Stage 源的读数是否消失过；这一句开始后多久重新出现、多久有声。
      const previous = sentences[sentences.indexOf(s) - 1];
      const silenceFrom = previous?.finishedAt ?? authenticatedAt;
      const during = meter.filter((m) => m.at > silenceFrom && m.at < s.sentAt);
      const firstAbsent = during.find((m) => !m.present);
      const lastPresentBeforeSend = [...during].reverse().find((m) => m.present);
      const after = meter.filter((m) => m.at >= s.sentAt && m.at < s.finishedAt + 1000);
      const reappeared = after.find((m) => m.present);
      const loud = after.find((m) => m.present && m.db !== null && m.db > SOUND_DB);
      const startedAt = s.startedAt ?? s.sentAt;
      return {
        index: s.index,
        gapSeconds: s.gapSeconds,
        silenceSeconds: round(s.silenceMs / 1000, 2),
        recording: s.recording + 1,
        pageStartedAfterSendMs: s.startedAt === null ? null : s.startedAt - s.sentAt,
        pageReport: s.finished,
        meter: {
          absentDuringSilence: firstAbsent !== undefined,
          absentAfterSilenceMs: firstAbsent ? firstAbsent.at - silenceFrom : null,
          presentRightBeforeSend: lastPresentBeforeSend
            ? s.sentAt - lastPresentBeforeSend.at < 200
            : false,
          reappearedAfterStartedMs: reappeared ? reappeared.at - startedAt : null,
          firstLoudAfterStartedMs: loud ? loud.at - startedAt : null,
        },
        recorded: segment
          ? {
              seconds: segment.seconds,
              shortMs,
              startPhase: segment.startPhase,
              // 缺的若是开头，起点相位应接近缺失时长对应的相位。
              phaseIfStartCut: shortMs === null ? null : round(((shortMs / 1000) * TONE_HZ) % 1, 3),
              discontinuities: segment.discontinuities,
              preRoll: preRoll.get(`${s.recording}:${inRecording.indexOf(s)}`) ?? null,
            }
          : null,
      };
    });
    result.recordings = perRecording;
    result.sentences = rows;
    // 按静默长度汇总：录音里缺了多少毫秒、音量表读数是否在静默中消失。
    const byGap = new Map<string, Array<(typeof rows)[number]>>();
    for (const row of rows) {
      const key = String(row.gapSeconds);
      byGap.set(key, [...(byGap.get(key) ?? []), row]);
    }
    result.summary = [...byGap].map(([gap, list]) => ({
      gapSeconds: gap,
      n: list.length,
      shortMs: list.map((r) => r.recorded?.shortMs ?? null),
      startPhase: list.map((r) => r.recorded?.startPhase ?? null),
      meterAbsentDuringSilence: list.map((r) => r.meter.absentDuringSilence),
      meterAbsentAfterSilenceMs: list.map((r) => r.meter.absentAfterSilenceMs),
      meterReappearedAfterStartedMs: list.map((r) => r.meter.reappearedAfterStartedMs),
    }));
    // 音量表读数的出现与消失（相对页面认证时刻，秒），便于对照。
    const transitions: Array<{ s: number; present: boolean }> = [];
    for (const m of meter) {
      if (transitions.at(-1)?.present === m.present) continue;
      transitions.push({ s: round((m.at - authenticatedAt) / 1000, 3), present: m.present });
    }
    result.meterTransitions = transitions;
    result.pageLogs = harness.logs.map((l) => ({
      s: round((l.at - authenticatedAt) / 1000, 3),
      event: l.event,
      reason: l.fields.reason ?? null,
    }));
  } catch (error) {
    result.error = (error as Error).stack ?? String(error);
    say(`诊断中止：${(error as Error).message}`);
  } finally {
    if (recordingSince !== undefined) await stopRecording().catch(() => {});
    await harness?.close();
    meters.close();
    const steps = await restoreSnapshot(obs, original, stageSource);
    const diffs = differences(original, await snapshot(obs, stageSource, values['safe-scene']));
    result.obsRestored = { ok: steps.length === 0 && diffs.length === 0, steps, diffs };
    say(`OBS 恢复：${JSON.stringify(result.obsRestored)}`);
    obs.close();
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    `${out}.json`,
    `${JSON.stringify({ drill: 'stage-silence', started, finished: new Date().toISOString(), node: process.version, stageSource, ...result }, null, 2)}\n`,
  );
  console.log(`结果已写入 ${out}.json`);
}

await main();
