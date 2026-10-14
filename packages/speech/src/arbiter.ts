import { ClockService, definePlugin, type TimerHandle } from '@bellis/kernel';
import { type Lease, SafetyService } from '@bellis/safety';
import { type PlaybackResult, STAGE_AUDIO, StageService } from '@bellis/stage';
import Type from 'typebox';
import { heardPrefix, Segmenter } from './segment.ts';
import {
  ModerationService,
  PREEMPTING,
  PRIORITY,
  PreCheck,
  type Sentence,
  type Speech,
  type SpeechRequest,
  SpeechService,
  type SpeechSource,
  TtsService,
  type UtteranceOutcome,
} from './types.ts';

interface Item {
  request: SpeechRequest;
  seq: number;
  resolve(outcome: UtteranceOutcome): void;
}

interface Active {
  item: Item;
  abort: AbortController;
  sentenceId: string | undefined;
  preemptedBy: SpeechSource | undefined;
  stopped: string | undefined;
  softStopped: string | undefined;
}

/** 静止中需要用到的实例状态，按插件上下文索引。 */
const instances = new WeakMap<object, { hardStop(reason: string): void; idle(): Promise<void> }>();

async function* sentencesOf(text: string | AsyncIterable<string>): AsyncGenerator<Sentence> {
  const segmenter = new Segmenter();
  if (typeof text === 'string') {
    yield* segmenter.push(text);
  } else {
    for await (const chunk of text) yield* segmenter.push(chunk);
  }
  yield* segmenter.flush();
}

async function* counting(frames: AsyncIterable<Int16Array>, add: (n: number) => void) {
  for await (const frame of frames) {
    add(frame.length);
    yield frame;
  }
}

/**
 * 发声仲裁（关键平面）：任何时刻只有一张嘴。
 * - 按来源定优先级（D-33），过期丢弃，按去重键去重；
 * - 更高优先级、且属于可抢占来源的请求，在当前发言声明的可抢占点打断它（句边界或立即）；
 * - 每句先经发声前检查（审核插件），再经安全核授权，持有 Stage 音频输出许可才合成与播放；
 * - 被打断的发言按 Stage 回报的播放游标截断，只把观众实际听到的部分写回。
 */
export const speechArbiter = definePlugin({
  manifest: {
    id: 'speech-arbiter',
    version: '0.1.0',
    tier: 'critical',
    provides: [SpeechService.ref],
    inject: [
      SafetyService.ref,
      ClockService.ref,
      StageService.ref,
      TtsService.ref,
      `${ModerationService.ref}?`,
    ],
    permissions: ['speech.output'],
    process: 'in-process',
    config: Type.Object({
      renewEveryMs: Type.Integer({ minimum: 1, default: 800 }),
      historySize: Type.Integer({ minimum: 1, default: 20 }),
      maxQueue: Type.Integer({ minimum: 1, default: 16 }),
    }),
  },
  activate(ctx) {
    const safety = ctx.service(SafetyService);
    const clock = ctx.service(ClockService);
    const stage = ctx.service(StageService);
    const tts = ctx.service(TtsService);
    const queue: Item[] = [];
    const history: UtteranceOutcome[] = [];
    const seen = new Set<string>();
    let active: Active | undefined;
    let running: Promise<void> | undefined;
    let lease: Lease | undefined;
    let renewTimer: TimerHandle | undefined;
    let seq = 0;

    const outcome = (
      request: SpeechRequest,
      fields: Partial<UtteranceOutcome>,
    ): UtteranceOutcome => ({
      id: request.id,
      source: request.source,
      heard: '',
      interruptedMidSentence: false,
      end: 'complete',
      skipped: [],
      ...fields,
    });

    const ensureLease = (): { ok: true } | { ok: false; reason: string } => {
      if (lease && safety.isValid(STAGE_AUDIO, lease.token)) return { ok: true };
      const granted = safety.grant(ctx.instanceId, STAGE_AUDIO);
      if (!granted.ok) return granted;
      lease = granted.lease;
      scheduleRenew();
      return { ok: true };
    };
    const scheduleRenew = () => {
      if (renewTimer) clock.clearTimeout(renewTimer);
      renewTimer = clock.setTimeout(() => {
        renewTimer = undefined;
        if (!lease) return;
        const renewed = safety.renew(lease);
        if (renewed.ok) {
          lease = renewed.lease;
          scheduleRenew();
        } else {
          lease = undefined;
        }
      }, ctx.config.renewEveryMs);
    };
    const releaseLease = () => {
      if (renewTimer) clock.clearTimeout(renewTimer);
      renewTimer = undefined;
      if (lease) safety.release(lease);
      lease = undefined;
    };

    const hardStop = (reason: string) => {
      for (const item of queue.splice(0))
        item.resolve(outcome(item.request, { end: 'stopped', reason }));
      if (!active) return;
      active.stopped ??= reason;
      active.abort.abort(new Error(reason));
      if (active.sentenceId) stage.truncate(active.sentenceId);
    };

    ctx.register(
      safety.onControl((signal) => {
        if (signal.kind === 'stop') hardStop(signal.reason);
        else if (signal.mode === 'safe-stop') hardStop(signal.reason);
      }),
    );
    ctx.register(() => {
      hardStop('仲裁停用');
      releaseLease();
    });

    const preCheck = async (
      request: SpeechRequest,
      sentence: Sentence,
      previous: string | undefined,
    ) => {
      if (safety.moderationEnabled === true && ctx.optional(ModerationService) === undefined) {
        return '审核已启用但审核插件不可用';
      }
      const verdict = await ctx.extensions.serial(PreCheck, {
        utteranceId: request.id,
        source: request.source,
        sentence,
        previous,
      });
      return verdict?.block;
    };

    const speak = async (current: Active): Promise<UtteranceOutcome> => {
      const { request } = current.item;
      const result = outcome(request, {});
      const finish = (fields: Partial<UtteranceOutcome>) => Object.assign(result, fields);
      let previous: string | undefined;
      try {
        for await (const sentence of sentencesOf(request.text)) {
          if (current.stopped) return finish({ end: 'stopped', reason: current.stopped });
          if (current.softStopped) return finish({ end: 'stopped', reason: current.softStopped });
          if (current.preemptedBy)
            return finish({ end: 'preempted', reason: `被 ${current.preemptedBy} 抢占` });
          if (sentence.index === 0 && request.expiresAt <= clock.now())
            return finish({ end: 'expired' });

          const blocked = await preCheck(request, sentence, previous);
          if (blocked !== undefined) {
            result.skipped.push({ index: sentence.index, reason: blocked });
            safety.record('sentence.skipped', {
              utteranceId: request.id,
              index: sentence.index,
              reason: blocked,
            });
            continue;
          }
          if (current.stopped) return finish({ end: 'stopped', reason: current.stopped });

          const payload = {
            utteranceId: request.id,
            index: sentence.index,
            subtitle: sentence.subtitle,
            spoken: sentence.spoken,
          };
          const decision = await safety.authorize({
            holder: ctx.instanceId,
            key: `${request.id}#${sentence.index}`,
            type: 'speech.play',
            target: 'stage',
            payload,
            source: {
              origin: request.source,
              inputs: request.inputs,
              untrusted: request.untrusted,
            },
            capabilities: ['speech.output'],
            timeSensitive: true,
          });
          if (!decision.allowed) return finish({ end: 'denied', reason: decision.reason });
          if (decision.duplicate) {
            result.skipped.push({ index: sentence.index, reason: '同一句已经授权过' });
            continue;
          }
          const leased = ensureLease();
          if (!leased.ok || !lease)
            return finish({ end: 'denied', reason: leased.ok ? '没有许可' : leased.reason });
          const token = lease.token;

          let playback: PlaybackResult | undefined;
          let total = 0;
          let timing: Awaited<ReturnType<typeof tts.synthesize>>['timing'];
          await safety.execute(decision.intent, payload, async (p) => {
            const synthesis = await tts.synthesize(p.spoken, current.abort.signal);
            timing = synthesis.timing;
            const sentenceId = `${p.utteranceId}#${p.index}`;
            current.sentenceId = sentenceId;
            playback = await stage.play(
              { id: sentenceId, subtitle: p.subtitle, sampleRate: synthesis.sampleRate },
              counting(synthesis.frames, (n) => {
                total += n;
              }),
              token,
            );
            current.sentenceId = undefined;
            return { played: playback.played, complete: playback.complete };
          });

          if (playback?.complete) {
            result.heard += sentence.subtitle;
            previous = sentence.subtitle;
            continue;
          }
          const played = playback?.played ?? 0;
          const prefix = heardPrefix(sentence, played, timing, total);
          if (prefix === undefined) result.interruptedMidSentence = played > 0;
          else result.heard += prefix;
          if (current.stopped) return finish({ end: 'stopped', reason: current.stopped });
          if (current.preemptedBy)
            return finish({ end: 'preempted', reason: `被 ${current.preemptedBy} 抢占` });
          return finish({ end: 'stopped', reason: playback?.reason ?? 'Stage 未完成播放' });
        }
        return result;
      } catch (error) {
        return finish({
          end: 'unavailable',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const run = async () => {
      while (queue.length > 0) {
        const item = queue.shift() as Item;
        if (item.request.expiresAt <= clock.now()) {
          item.resolve(outcome(item.request, { end: 'expired' }));
          continue;
        }
        const current: Active = {
          item,
          abort: new AbortController(),
          sentenceId: undefined,
          preemptedBy: undefined,
          stopped: undefined,
          softStopped: undefined,
        };
        active = current;
        const result = await speak(current);
        active = undefined;
        if (result.heard || result.interruptedMidSentence) {
          history.push(result);
          if (history.length > ctx.config.historySize) history.shift();
        }
        safety.record('utterance.played', { ...result });
        item.resolve(result);
      }
      releaseLease();
    };
    const pump = () => {
      running ??= run().finally(() => {
        running = undefined;
        if (queue.length > 0) pump();
      });
    };

    const speech: Speech = {
      request(request) {
        if (ctx.signal.aborted)
          return Promise.resolve(outcome(request, { end: 'unavailable', reason: '仲裁停用' }));
        if (seen.has(request.id)) return Promise.resolve(outcome(request, { end: 'duplicate' }));
        seen.add(request.id);
        if (request.expiresAt <= clock.now())
          return Promise.resolve(outcome(request, { end: 'expired' }));
        return new Promise((resolve) => {
          queue.push({ request, seq: seq++, resolve });
          queue.sort(
            (a, b) => PRIORITY[b.request.source] - PRIORITY[a.request.source] || a.seq - b.seq,
          );
          if (queue.length > ctx.config.maxQueue) {
            const dropped = queue.pop() as Item;
            dropped.resolve(outcome(dropped.request, { end: 'expired', reason: '队列已满' }));
          }
          if (
            active &&
            PREEMPTING.has(request.source) &&
            PRIORITY[request.source] > PRIORITY[active.item.request.source]
          ) {
            active.preemptedBy ??= request.source;
            if (active.item.request.preempt === 'immediate' && active.sentenceId)
              stage.truncate(active.sentenceId);
          }
          pump();
        });
      },
      softStop(reason) {
        for (const item of queue.splice(0))
          item.resolve(outcome(item.request, { end: 'stopped', reason }));
        if (active) active.softStopped ??= reason;
      },
      heard: () => [...history],
    };
    ctx.provide(SpeechService, speech);
    instances.set(ctx, { hardStop, idle: () => running ?? Promise.resolve() });
  },
  async quiesce(ctx) {
    // 对在途发言发出停止，并等待 Stage 回报截断（物理确认）；截止时间由内核控制。
    const instance = instances.get(ctx);
    instance?.hardStop('仲裁停用');
    await instance?.idle();
  },
});
