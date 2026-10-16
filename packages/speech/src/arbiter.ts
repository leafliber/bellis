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
  ReviewService,
  type Sentence,
  type Speech,
  type SpeechRequest,
  SpeechService,
  type SpeechSource,
  type Synthesis,
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
  /** 停止、软收尾或被抢占时 resolve，用来打断等待中的文本流。 */
  interrupted: PromiseWithResolvers<void>;
}

/** 静止中需要用到的实例状态，按插件上下文索引。 */
const instances = new WeakMap<object, { hardStop(reason: string): void; idle(): Promise<void> }>();

/** 逐句读出文本流；一旦被打断就不再等待流的下一段。 */
async function* sentencesOf(
  text: string | AsyncIterable<string>,
  interrupted: Promise<void>,
): AsyncGenerator<Sentence> {
  const segmenter = new Segmenter();
  if (typeof text === 'string') {
    yield* segmenter.push(text);
  } else {
    const iterator = text[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await Promise.race([iterator.next(), interrupted.then(() => undefined)]);
        if (next === undefined || next.done) break;
        yield* segmenter.push(next.value);
      }
    } finally {
      void iterator.return?.();
    }
  }
  yield* segmenter.flush();
}

/**
 * 发声仲裁（关键平面）：任何时刻只有一张嘴。
 * - 按来源定优先级（D-33），过期丢弃，按去重键去重；
 * - 更高优先级、且属于可抢占来源的请求，在当前发言声明的可抢占点打断它（句边界或立即）；
 * - 每句先经发声前检查（审核插件），持有 Stage 音频输出许可、经安全核授权后才合成与播放；
 *   每次等待之后都重新检查停止、软收尾与抢占；
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
      `${ReviewService.ref}?`,
    ],
    permissions: ['speech.output'],
    process: 'in-process',
    config: Type.Object({
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

    const ensureLease = (): { ok: true; lease: Lease } | { ok: false; reason: string } => {
      if (lease && safety.isValid(STAGE_AUDIO, lease.token)) return { ok: true, lease };
      const granted = safety.grant(STAGE_AUDIO);
      if (!granted.ok) return granted;
      lease = granted.lease;
      scheduleRenew();
      return { ok: true, lease };
    };
    // 续约间隔由许可时长决定：每个时长内续约三次。
    const scheduleRenew = () => {
      if (renewTimer) clock.clearTimeout(renewTimer);
      if (!lease) return;
      renewTimer = clock.setTimeout(
        () => {
          renewTimer = undefined;
          if (!lease) return;
          const renewed = safety.renew(lease);
          if (renewed.ok) {
            lease = renewed.lease;
            scheduleRenew();
          } else {
            lease = undefined;
          }
        },
        Math.max(1, Math.floor(lease.ttlMs / 3)),
      );
    };
    const releaseLease = () => {
      if (renewTimer) clock.clearTimeout(renewTimer);
      renewTimer = undefined;
      if (lease) safety.release(lease);
      lease = undefined;
    };

    const interrupt = (current: Active, field: 'stopped' | 'softStopped', reason: string) => {
      current[field] ??= reason;
      current.interrupted.resolve();
    };
    const hardStop = (reason: string) => {
      for (const item of queue.splice(0))
        item.resolve(outcome(item.request, { end: 'stopped', reason }));
      if (!active) return;
      interrupt(active, 'stopped', reason);
      active.abort.abort(new Error(reason));
      if (active.sentenceId) stage.truncate(active.sentenceId);
    };

    ctx.register(
      safety.onControl((signal) => {
        if (signal.kind === 'stop') hardStop(signal.reason);
        else if (signal.kind === 'mode' && signal.mode === 'safe-stop') hardStop(signal.reason);
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
      signal: AbortSignal,
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
      if (verdict) return verdict.block;
      // M1：逐句等待放行，期间操作员可以否决；没有放行环节就一句也不播。
      if (safety.mode !== 'M1') return undefined;
      const review = ctx.optional(ReviewService);
      if (!review) return 'M1 需要逐句放行环节（speech-review），但它不在场';
      return review.hold(
        {
          key: `${request.id}#${sentence.index}`,
          utteranceId: request.id,
          index: sentence.index,
          source: request.source,
          subtitle: sentence.subtitle,
        },
        signal,
      );
    };

    const speak = async (current: Active): Promise<UtteranceOutcome> => {
      const { request } = current.item;
      const result = outcome(request, {});
      const finish = (fields: Partial<UtteranceOutcome>) => Object.assign(result, fields);
      /** 停止、软收尾或被抢占时返回结束方式；每次等待之后都要检查。 */
      const halted = (): Partial<UtteranceOutcome> | undefined => {
        if (current.stopped) return { end: 'stopped', reason: current.stopped };
        if (current.softStopped) return { end: 'stopped', reason: current.softStopped };
        if (current.preemptedBy)
          return { end: 'preempted', reason: `被 ${current.preemptedBy} 抢占` };
        return undefined;
      };
      let previous: string | undefined;
      try {
        for await (const sentence of sentencesOf(request.text, current.interrupted.promise)) {
          const before = halted();
          if (before) return finish(before);
          if (sentence.index === 0 && request.expiresAt <= clock.now())
            return finish({ end: 'expired' });

          // 审核可能很慢：被停止、软收尾或抢占时不再等它。
          const blocked = await Promise.race([
            preCheck(request, sentence, previous, current.abort.signal),
            current.interrupted.promise.then(() => undefined),
          ]);
          const afterCheck = halted();
          if (afterCheck) return finish(afterCheck);
          if (blocked !== undefined) {
            result.skipped.push({ index: sentence.index, reason: blocked });
            safety.record('sentence.skipped', {
              utteranceId: request.id,
              index: sentence.index,
              reason: blocked,
            });
            continue;
          }

          // 先取得许可再授权：授权之后到执行之间不再有等待，意图不会停在待执行。
          const leased = ensureLease();
          if (!leased.ok) return finish({ end: 'denied', reason: leased.reason });
          const token = leased.lease.token;
          const payload = {
            utteranceId: request.id,
            index: sentence.index,
            subtitle: sentence.subtitle,
            spoken: sentence.spoken,
          };
          const decision = await safety.authorize({
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

          let playback: PlaybackResult | undefined;
          let synthesis: Synthesis | undefined;
          await safety.execute(decision.intent, payload, async (p) => {
            // 授权的等待期间可能已被打断：此时这一句一个采样都没有播出，按失败记录。
            if (halted()) throw new Error('播出前被打断');
            synthesis = await tts.synthesize(p.spoken, current.abort.signal);
            if (halted()) throw new Error('播出前被打断');
            const sentenceId = `${p.utteranceId}#${p.index}`;
            current.sentenceId = sentenceId;
            playback = await stage.play(
              { id: sentenceId, subtitle: p.subtitle, sampleRate: synthesis.sampleRate },
              synthesis.frames,
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
          const prefix = heardPrefix(sentence, played, synthesis?.timing, synthesis?.totalSamples);
          if (prefix === undefined) result.interruptedMidSentence = played > 0;
          else result.heard += prefix;
          return finish(halted() ?? { end: 'stopped', reason: playback?.reason ?? '没有播出' });
        }
        return finish(halted() ?? {});
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
          interrupted: Promise.withResolvers<void>(),
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
        if (ctx.signal.aborted) {
          return Promise.resolve(outcome(request, { end: 'unavailable', reason: '仲裁停用' }));
        }
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
            !active.preemptedBy &&
            PREEMPTING.has(request.source) &&
            PRIORITY[request.source] > PRIORITY[active.item.request.source]
          ) {
            active.preemptedBy = request.source;
            active.interrupted.resolve();
            if (active.item.request.preempt === 'immediate' && active.sentenceId) {
              stage.truncate(active.sentenceId);
            }
          }
          pump();
        });
      },
      softStop(reason) {
        for (const item of queue.splice(0))
          item.resolve(outcome(item.request, { end: 'stopped', reason }));
        if (active) interrupt(active, 'softStopped', reason);
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
