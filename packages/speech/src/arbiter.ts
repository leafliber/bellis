import { ClockService, definePlugin, type TimerHandle, TraceService } from '@bellis/kernel';
import { type Lease, SafetyService } from '@bellis/safety';
import { type PlaybackResult, STAGE_AUDIO, StageService } from '@bellis/stage';
import { Metric, type Span, TelemetryService, useTracer } from '@bellis/telemetry';
import Type from 'typebox';
import { heardPrefix, Segmenter, subtitleStarts } from './segment.ts';
import {
  ModerationService,
  PREEMPTING,
  PRIORITY,
  PreCheck,
  type PreCheckVerdict,
  ReviewService,
  type Sentence,
  SPEECH_INTENT,
  type Speech,
  type SpeechRequest,
  SpeechService,
  type SpeechSource,
  type Synthesis,
  TtsExpiredError,
  TtsService,
  type UtteranceOutcome,
  UtterancePlayed,
} from './types.ts';

interface Item {
  request: SpeechRequest;
  seq: number;
  resolve(outcome: UtteranceOutcome): void;
  /** 这段发言的 span：从收到请求起，到写回之前结束。 */
  span: Span;
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
  /**
   * 急停时正在播的那一句：急停那一刻的呈现延迟，以及 OBS 应急静音是否成功（等不到结果按失败）。
   * 写回据此扣掉已交给 OBS、还没呈现就被静音的那一段。
   */
  emergency: { delayMs: number; obsOk: Promise<boolean> } | undefined;
  /** 正在播的那一句在 Stage 开始播出时调用（页面回报 started）。 */
  onStarted: ((sentenceId: string) => void) | undefined;
  /** 这段发言已有一句在 Stage 上开始播出（“弹幕到首音”只记第一句）。 */
  firstAudio: boolean;
}

/**
 * 把合成的音频原样交出，同时看第一帧何时到、迭代何时结束（遥测用）。停止读取（`return`）立即转给提供方，
 * 不等下一帧到达：提供方据此取消合成。
 */
function observeFrames(
  frames: AsyncIterable<Int16Array>,
  onFirst: () => void,
  onDone: (outcome: 'ended' | 'stopped' | 'failed') => void,
): AsyncIterable<Int16Array> {
  return {
    [Symbol.asyncIterator]() {
      const inner = frames[Symbol.asyncIterator]();
      let first = true;
      return {
        next: () =>
          inner.next().then(
            (step) => {
              if (step.done) onDone('ended');
              else if (first) {
                first = false;
                onFirst();
              }
              return step;
            },
            (error: unknown) => {
              onDone('failed');
              throw error;
            },
          ),
        return: (value?: unknown) => {
          onDone('stopped');
          return inner.return
            ? inner.return(value)
            : Promise.resolve({ value: undefined, done: true as const });
        },
      };
    },
  };
}

/** 等 OBS 应急动作结果的上限：应急批处理自己的超时是 1 秒。 */
const EMERGENCY_WAIT_MS = 3000;

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
 * - 被打断的发言按 Stage 回报的播放游标截断，只把观众实际听到的部分写回；急停且 OBS 应急静音成功时，
 *   正在播的那一句再扣掉呈现延迟（发声文档“播放游标与写回”）。
 * - 有遥测时（见运维“观测”）：每段发言一个 span（父为请求带来的链路），每句一个 span，其下是发声前检查、
 *   放行环节、授权、TTS 合成各一个 span，Stage 服务的播出 span 也挂在这一句下；另记“弹幕到首音”、
 *   “TTS 首包”与“许可续约滞后”的直方图。
 * - 在仿真里把收到的每个请求（编号、来源与文本）写进追踪（`speech.requested`），含被拒与丢弃的。
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
      `${TelemetryService.ref}?`,
      `${TraceService.ref}?`,
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
    const tracer = useTracer(ctx, 'speech-arbiter');
    const trace = ctx.optional(TraceService);
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

    /** 一段发言的 span：父为请求带来的链路，另关联它带来的上游 span（例如产生它的模型调用）。 */
    const utteranceSpan = (request: SpeechRequest) =>
      tracer.startSpan('speech.utterance', {
        parent: request.trace,
        links: request.trace?.links ?? [],
        attributes: {
          'bellis.speech.utterance_id': request.id,
          'bellis.speech.source': request.source,
          'bellis.speech.preempt': request.preempt,
          'bellis.speech.untrusted': request.untrusted,
        },
      });
    /** 发言结束：只记结束方式与计数，不记文本。重复调用无效。 */
    const endUtterance = (span: Span, result: UtteranceOutcome) => {
      span.setAttributes({
        'bellis.speech.end': result.end,
        'bellis.speech.heard_chars': [...result.heard].length,
        'bellis.speech.skipped': result.skipped.length,
        'bellis.speech.interrupted_mid_sentence': result.interruptedMidSentence,
      });
      if (result.end === 'unavailable' || result.end === 'denied') span.fail(result.end);
      span.end();
    };
    /** 没轮到就结束的发言（停止、过期、队列已满）：结束它的 span 并交回结果。 */
    const dropQueued = (item: Item, result: UtteranceOutcome) => {
      endUtterance(item.span, result);
      item.resolve(result);
    };
    /** 收到就结束的请求（停用、重复、已过期）。 */
    const refuse = (request: SpeechRequest, fields: Partial<UtteranceOutcome>) => {
      const result = outcome(request, fields);
      endUtterance(utteranceSpan(request), result);
      return Promise.resolve(result);
    };

    const ensureLease = (): { ok: true; lease: Lease } | { ok: false; reason: string } => {
      if (lease && safety.isValid(STAGE_AUDIO, lease.token)) return { ok: true, lease };
      const granted = safety.grant(STAGE_AUDIO);
      if (!granted.ok) return granted;
      lease = granted.lease;
      scheduleRenew();
      return { ok: true, lease };
    };
    // 续约间隔由许可时长决定：每个时长内续约三次。实际续约时刻相对计划的滞后记入直方图。
    const scheduleRenew = () => {
      if (renewTimer) clock.clearTimeout(renewTimer);
      if (!lease) return;
      const interval = Math.max(1, Math.floor(lease.ttlMs / 3));
      const planned = clock.now() + interval;
      renewTimer = clock.setTimeout(() => {
        renewTimer = undefined;
        if (!lease) return;
        tracer.record(Metric.LeaseRenewLag, Math.max(0, clock.now() - planned) / 1000, 's', {
          'bellis.lease.resource': STAGE_AUDIO,
        });
        const renewed = safety.renew(lease);
        if (renewed.ok) {
          lease = renewed.lease;
          scheduleRenew();
        } else {
          lease = undefined;
        }
      }, interval);
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
      for (const item of queue.splice(0)) {
        dropQueued(item, outcome(item.request, { end: 'stopped', reason }));
      }
      if (!active) return;
      interrupt(active, 'stopped', reason);
      active.abort.abort(new Error(reason));
      if (active.sentenceId) stage.truncate(active.sentenceId);
    };

    /** 等着下一次 OBS 应急动作结果的句子。 */
    const emergencyWaiters = new Set<(obsOk: boolean) => void>();
    /** 急停：记下正在播的那一句的呈现延迟，等 OBS 应急动作的结果（超时按失败）。 */
    const noteEmergency = () => {
      const current = active;
      if (!current?.sentenceId || current.emergency) return;
      const obsOk = new Promise<boolean>((resolve) => {
        let timer: TimerHandle | undefined;
        const settle = (ok: boolean) => {
          if (timer) clock.clearTimeout(timer);
          emergencyWaiters.delete(settle);
          resolve(ok);
        };
        emergencyWaiters.add(settle);
        timer = clock.setTimeout(() => settle(false), EMERGENCY_WAIT_MS);
      });
      current.emergency = { delayMs: stage.presentation.delayMs, obsOk };
    };
    ctx.register(
      safety.onControl((signal) => {
        if (signal.kind === 'stop') {
          noteEmergency();
          hardStop(signal.reason);
        } else if (signal.kind === 'mode' && signal.mode === 'safe-stop') {
          hardStop(signal.reason);
        } else if (signal.kind === 'emergency-completed') {
          for (const settle of [...emergencyWaiters]) settle(signal.obsOk);
        }
      }),
    );
    ctx.register(() => {
      for (const settle of [...emergencyWaiters]) settle(false);
    });
    ctx.register(() => {
      hardStop('仲裁停用');
      releaseLease();
    });
    // 页面回报正在播的那一句开始播出：“弹幕到首音”从这里取终点。
    ctx.register(
      stage.onEvent((event) => {
        if (event.kind === 'started') active?.onStarted?.(event.sentenceId);
      }),
    );

    /**
     * 发言的第一句在 Stage 上开始播出：回应弹幕的发言记“弹幕到首音”（从宿主收到那条弹幕起），
     * 另记加上此刻呈现延迟 D 的值（观众端声音出现在 OBS 输出里的估计）。
     */
    const firstAudio = (current: Active, span: Span) => {
      if (current.firstAudio) return;
      current.firstAudio = true;
      const { request } = current.item;
      const originAt = request.trace?.originAt;
      if (request.source !== 'danmaku-reply' || originAt === undefined) return;
      const elapsedMs = clock.now() - originAt;
      tracer.record(Metric.DanmakuFirstAudio, elapsedMs / 1000, 's', undefined, span);
      tracer.record(
        Metric.DanmakuFirstAudioPresented,
        (elapsedMs + stage.presentation.delayMs) / 1000,
        's',
        undefined,
        span,
      );
    };

    const preCheck = async (
      request: SpeechRequest,
      sentence: Sentence,
      previous: string | undefined,
      signal: AbortSignal,
      parent: Span,
    ) => {
      if (safety.moderationEnabled === true && ctx.optional(ModerationService) === undefined) {
        return '审核已启用但审核插件不可用';
      }
      const checkSpan = tracer.startSpan('speech.pre_check', { parent });
      let verdict: PreCheckVerdict | undefined;
      try {
        verdict = await ctx.extensions.serial(PreCheck, {
          utteranceId: request.id,
          source: request.source,
          sentence,
          previous,
          ...(checkSpan.traceparent ? { traceparent: checkSpan.traceparent } : {}),
        });
        checkSpan.setAttributes({ 'bellis.speech.blocked': verdict !== undefined });
      } catch (error) {
        checkSpan.fail('pre_check_failed');
        throw error;
      } finally {
        checkSpan.end();
      }
      if (verdict) return verdict.block;
      // M1：逐句等待放行，期间操作员可以否决；没有放行环节就一句也不播。
      if (safety.mode !== 'M1') return undefined;
      const review = ctx.optional(ReviewService);
      if (!review) return 'M1 需要逐句放行环节（speech-review），但它不在场';
      const reviewSpan = tracer.startSpan('speech.review', {
        parent,
        attributes: { 'bellis.review.mode': review.settings.mode },
      });
      try {
        const blocked = await review.hold(
          {
            key: `${request.id}#${sentence.index}`,
            utteranceId: request.id,
            index: sentence.index,
            source: request.source,
            subtitle: sentence.subtitle,
          },
          signal,
        );
        reviewSpan.setAttributes({ 'bellis.review.released': blocked === undefined });
        return blocked;
      } finally {
        reviewSpan.end();
      }
    };

    /**
     * 写回游标：页面回报的已播出采样数。急停且 OBS 应急静音成功时，再扣掉急停那一刻的呈现延迟：
     * 这一段已交给 OBS，还没呈现就被静音了，观众听不到。页面自己截断、静音失败时不扣。
     */
    const heardCursor = async (
      current: Active,
      played: number,
      synthesis: Synthesis | undefined,
    ): Promise<number> => {
      const emergency = current.emergency;
      if (!emergency || !synthesis || played === 0) return played;
      if (!(await emergency.obsOk)) return played;
      const unheard = Math.round((emergency.delayMs * synthesis.sampleRate) / 1000);
      const cursor = Math.max(0, played - unheard);
      ctx.log('speech.emergency-writeback', {
        utteranceId: current.item.request.id,
        played,
        delayMs: emergency.delayMs,
        cursor,
      });
      return cursor;
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

          const key = `${request.id}#${sentence.index}`;
          const sentenceSpan = tracer.startSpan('speech.sentence', {
            parent: current.item.span,
            attributes: {
              'bellis.speech.sentence_key': key,
              'bellis.speech.sentence_index': sentence.index,
            },
          });
          /** 这一句的去向，写进 span。 */
          let fate:
            | 'halted'
            | 'skipped'
            | 'denied'
            | 'duplicate'
            | 'played'
            | 'expired'
            | 'unavailable'
            | 'cut' = 'halted';
          try {
            // 审核可能很慢：被停止、软收尾或抢占时不再等它。
            const blocked = await Promise.race([
              preCheck(request, sentence, previous, current.abort.signal, sentenceSpan),
              current.interrupted.promise.then(() => undefined),
            ]);
            const afterCheck = halted();
            if (afterCheck) return finish(afterCheck);
            if (blocked !== undefined) {
              fate = 'skipped';
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
            if (!leased.ok) {
              fate = 'denied';
              return finish({ end: 'denied', reason: leased.reason });
            }
            const token = leased.lease.token;
            const payload = {
              utteranceId: request.id,
              index: sentence.index,
              subtitle: sentence.subtitle,
              spoken: sentence.spoken,
            };
            const authorizeSpan = tracer.startSpan('speech.authorize', { parent: sentenceSpan });
            let decision: Awaited<ReturnType<typeof safety.authorize>>;
            try {
              decision = await safety.authorize({
                key,
                type: SPEECH_INTENT.type,
                target: SPEECH_INTENT.target,
                payload,
                source: {
                  origin: request.source,
                  inputs: request.inputs,
                  untrusted: request.untrusted,
                },
                capabilities: [SPEECH_INTENT.capability],
                timeSensitive: true,
              });
              authorizeSpan.setAttributes({
                'bellis.safety.allowed': decision.allowed,
                'bellis.safety.duplicate': decision.allowed && decision.duplicate,
              });
            } finally {
              authorizeSpan.end();
            }
            if (!decision.allowed) {
              fate = 'denied';
              return finish({ end: 'denied', reason: decision.reason });
            }
            if (decision.duplicate) {
              fate = 'duplicate';
              result.skipped.push({ index: sentence.index, reason: '同一句已经授权过' });
              continue;
            }

            let playback: PlaybackResult | undefined;
            let synthesis: Synthesis | undefined;
            let ttsError: string | undefined;
            // 这一句的合成在发言中止时取消；合成了却没有播完（被打断、截断或出错）时也取消，
            // 不让云端 TTS 继续合成没人听的部分。
            const sentenceAbort = new AbortController();
            const ttsSignal = AbortSignal.any([current.abort.signal, sentenceAbort.signal]);
            /** 这一句因发言过期而没有播出时的原因。 */
            let expired: string | undefined;
            const ttsSpan = tracer.startSpan('tts.synthesize', { parent: sentenceSpan });
            const endTts = (how: 'ended' | 'stopped' | 'failed' | 'expired' | 'unavailable') => {
              if (how === 'failed' || how === 'unavailable' || how === 'expired') ttsSpan.fail(how);
              ttsSpan.setAttributes({ 'bellis.tts.end': how });
              ttsSpan.end();
            };
            await safety.execute(decision.intent, payload, async (p) => {
              try {
                // 授权的等待期间可能已被打断：此时这一句一个采样都没有播出，按失败记录。
                if (halted()) throw new Error('播出前被打断');
                // 合成中（例如云端 TTS 等限流）被停止、软收尾、抢占，或等到发言过期：立即取消这一句的合成，不再播出。
                let synthesizing = true;
                void current.interrupted.promise.then(() => {
                  if (synthesizing) sentenceAbort.abort(new Error('播出前被打断'));
                });
                const untilExpiry = request.expiresAt - clock.now();
                const expiry =
                  Number.isFinite(untilExpiry) && untilExpiry > 0
                    ? clock.setTimeout(() => {
                        expired = '合成中发言已过期';
                        sentenceAbort.abort(new Error('发言已过期'));
                      }, untilExpiry)
                    : undefined;
                const startedAt = clock.now();
                try {
                  // 带上发言的过期时刻：要等限流、而额度恢复时发言已过期的，引擎不等（TtsExpiredError）。
                  // 带上这一句合成的 span：以 sidecar 运行的引擎把它放进 JSON-RPC 参数。
                  synthesis = await tts.synthesize(p.spoken, ttsSignal, {
                    expiresAt: request.expiresAt,
                    ...(ttsSpan.traceparent ? { traceparent: ttsSpan.traceparent } : {}),
                  });
                } catch (error) {
                  if (error instanceof TtsExpiredError) {
                    expired = error.message;
                    endTts('expired');
                  } else {
                    ttsError = error instanceof Error ? error.message : String(error);
                    endTts('unavailable');
                  }
                  throw error;
                } finally {
                  synthesizing = false;
                  if (expiry) clock.clearTimeout(expiry);
                }
                if (halted()) throw new Error('播出前被打断');
                if (expired !== undefined) throw new Error(expired);
                const sentenceId = `${p.utteranceId}#${p.index}`;
                current.sentenceId = sentenceId;
                const voiced = synthesis;
                // 有遥测时看第一帧何时到（TTS 首包）、音频流何时结束（合成 span 的终点）。
                const frames =
                  ttsSpan.traceparent === undefined
                    ? voiced.frames
                    : observeFrames(
                        voiced.frames,
                        () => {
                          ttsSpan.addEvent('bellis.tts.first_audio');
                          tracer.record(
                            Metric.TtsFirstAudio,
                            (clock.now() - startedAt) / 1000,
                            's',
                            undefined,
                            ttsSpan,
                          );
                        },
                        endTts,
                      );
                current.onStarted = (id) => {
                  if (id !== sentenceId) return;
                  current.onStarted = undefined;
                  firstAudio(current, sentenceSpan);
                };
                playback = await stage.play(
                  {
                    id: sentenceId,
                    subtitle: p.subtitle,
                    sampleRate: voiced.sampleRate,
                    // 映射是活的（R-11）：Stage 服务转发音频时现读，换算到字幕码点后发给页面。
                    subtitleStarts: () => subtitleStarts(sentence, voiced.timing),
                    ...(sentenceSpan.traceparent ? { traceparent: sentenceSpan.traceparent } : {}),
                  },
                  frames,
                  token,
                );
                current.sentenceId = undefined;
                return { played: playback.played, complete: playback.complete };
              } finally {
                current.onStarted = undefined;
                if (!playback?.complete) sentenceAbort.abort(new Error('这一句没有播完'));
                // Stage 没有读音频（例如许可已失效）时合成的 span 在这里结束。
                endTts('stopped');
              }
            });

            if (playback?.complete) {
              fate = 'played';
              result.heard += sentence.subtitle;
              previous = sentence.subtitle;
              continue;
            }
            // 合成中等到过期，或要等的限流额度到过期之后才恢复：这一句与剩下的句子都不播。
            if (expired !== undefined) {
              fate = 'expired';
              return finish(halted() ?? { end: 'expired', reason: expired });
            }
            // 没有任何可用的 TTS 引擎：这一句一个采样都没有播出。
            if (ttsError !== undefined && !halted()) {
              fate = 'unavailable';
              return finish({ end: 'unavailable', reason: `TTS 不可用：${ttsError}` });
            }
            fate = 'cut';
            const played = await heardCursor(current, playback?.played ?? 0, synthesis);
            // 时间映射可能在合成过程中被细化（R-11），按播放游标换算时现读。
            const prefix = heardPrefix(
              sentence,
              played,
              synthesis?.timing,
              synthesis?.totalSamples,
            );
            if (prefix === undefined) result.interruptedMidSentence = played > 0;
            else result.heard += prefix;
            return finish(halted() ?? { end: 'stopped', reason: playback?.reason ?? '没有播出' });
          } finally {
            sentenceSpan.setAttributes({ 'bellis.speech.sentence_fate': fate });
            sentenceSpan.end();
          }
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
          dropQueued(item, outcome(item.request, { end: 'expired' }));
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
          emergency: undefined,
          onStarted: undefined,
          firstAudio: false,
        };
        active = current;
        item.span.addEvent('bellis.speech.dequeued');
        const result = await speak(current);
        active = undefined;
        if (result.heard || result.interruptedMidSentence) {
          history.push(result);
          if (history.length > ctx.config.historySize) history.shift();
        }
        endUtterance(item.span, result);
        safety.record('utterance.played', { ...result });
        ctx.extensions.observe(UtterancePlayed, { ...result, skipped: [...result.skipped] });
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
        trace?.record('speech.requested', {
          id: request.id,
          source: request.source,
          text: typeof request.text === 'string' ? request.text : null,
        });
        if (ctx.signal.aborted) return refuse(request, { end: 'unavailable', reason: '仲裁停用' });
        if (seen.has(request.id)) return refuse(request, { end: 'duplicate' });
        seen.add(request.id);
        if (request.expiresAt <= clock.now()) return refuse(request, { end: 'expired' });
        return new Promise((resolve) => {
          queue.push({ request, seq: seq++, resolve, span: utteranceSpan(request) });
          queue.sort(
            (a, b) => PRIORITY[b.request.source] - PRIORITY[a.request.source] || a.seq - b.seq,
          );
          if (queue.length > ctx.config.maxQueue) {
            const dropped = queue.pop() as Item;
            dropQueued(dropped, outcome(dropped.request, { end: 'expired', reason: '队列已满' }));
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
        for (const item of queue.splice(0)) {
          dropQueued(item, outcome(item.request, { end: 'stopped', reason }));
        }
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
