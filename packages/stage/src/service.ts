import { ClockService, definePlugin, type TimerHandle } from '@bellis/kernel';
import { producesOutput, SafetyService } from '@bellis/safety';
import { Metric, type Span, TelemetryService, useTracer } from '@bellis/telemetry';
import Type from 'typebox';
import { EnvelopeBuilder } from './envelope.ts';
import {
  isPagePresentation,
  isPageTiming,
  type PagePresentation,
  type PageTiming,
} from './page-wire.ts';
import {
  type FromPage,
  type PlaybackResult,
  type Presentation,
  STAGE_AUDIO,
  type Stage,
  StagePageService,
  StageService,
} from './types.ts';

interface Playing {
  resolve(result: PlaybackResult): void;
  /** 这一句用的许可令牌：令牌变了，页面就会停下这一句。 */
  token: number;
  /** 播出的 span（见运维“观测”）。 */
  span: Span;
  /** 第一次要求页面停下这一句的时刻与方式，用于“停止到静音”。 */
  stopRequested: { at: number; by: 'truncate' | 'token' } | undefined;
  played: number;
  /** 已转发给页面的采样数；页面回报 ended 时据此判断是否完整。 */
  forwarded: number;
  /** 已要求页面截断：之后不再给这一句发字幕映射。 */
  truncating: boolean;
  envelope: EnvelopeBuilder;
  /** 逐句的回报摘要，句子结束时记入日志，供运维核对欠载与游标。 */
  report: {
    startedAt: number | undefined;
    underruns: number;
    cursors: number;
    first: [at: number, played: number] | undefined;
    last: [at: number, played: number] | undefined;
    maxCursorGapMs: number;
  };
}

/** 字幕映射不能发给页面的原因；能发时返回 undefined。 */
function timingProblem(message: PageTiming, subtitleChars: number): string | undefined {
  if (!isPageTiming.Check(message)) return '映射不合格式';
  const { starts } = message;
  if (starts.length > subtitleChars)
    return `映射有 ${starts.length} 个码点，字幕只有 ${subtitleChars} 个`;
  if (starts.some((start, k) => k > 0 && start < (starts[k - 1] as number)))
    return '映射没有按码点不减';
  return undefined;
}

const sameStarts = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((value, k) => value === b[k]);

/**
 * Stage 服务（关键平面）：只转发带有效 Stage 音频输出许可令牌的音频，把令牌变化告诉页面，
 * 定时发心跳；页面在截止时间内不应答心跳即报告失败，由安全核走急停路径（D-30）。
 * 转发音频时按句计算响度包络，供形象驱动口型。
 * 字幕的时间映射是活的：句子开始、每转发一块音频之后与音频流结束时现读，有变化就校验后整份发给页面；
 * 只发给令牌有效、还在 Stage 上且没有被要求截断的句子（字幕规则见 Stage 文档的“字幕”）。
 * 页面回报的欠载与静音即时记入日志；每句结束时记一条摘要（实际播出的采样数、欠载次数、游标回报的
 * 次数、首末两次游标与最大间隔），游标本身不逐条记录。
 * 呈现延迟（Stage 文档“对齐”）由估计插件写进来，校验后在变化时与每句开始前发给页面；没有估计插件时为 0。
 * 有遥测时每句一个播出 span（`stage.play`，页面回报的开始与欠载记为事件），并记“停止到静音”：
 * 从要求页面截断（或转告许可令牌变化）到页面回报这一句已截断。
 */
export const stageService = definePlugin({
  manifest: {
    id: 'stage-service',
    version: '0.1.0',
    tier: 'critical',
    provides: [StageService.ref],
    inject: [SafetyService.ref, ClockService.ref, StagePageService.ref, `${TelemetryService.ref}?`],
    permissions: [],
    process: 'in-process',
    config: Type.Object({
      heartbeatMs: Type.Integer({ minimum: 1, default: 250 }),
      /** 超过这么久收不到页面的心跳应答，视为 Stage 不可用。 */
      pageTimeoutMs: Type.Integer({ minimum: 1, default: 1000 }),
      /** 响度包络的窗口长度，按原始采样率折算成采样数。 */
      envelopeWindowMs: Type.Integer({ minimum: 5, maximum: 100, default: 20 }),
    }),
  },
  activate(ctx) {
    const safety = ctx.service(SafetyService);
    const clock = ctx.service(ClockService);
    const page = ctx.service(StagePageService);
    const tracer = useTracer(ctx, 'stage-service');
    const listeners = new Set<(event: FromPage) => void>();
    const playing = new Map<string, Playing>();
    let lastAck = clock.now();
    let timer: TimerHandle | undefined;
    let presentation: Presentation = { delayMs: 0, samples: 0, source: 'none' };
    const sendPresentation = () => {
      const message: PagePresentation = { kind: 'presentation', delayMs: presentation.delayMs };
      page.send(message);
    };

    const finish = (sentenceId: string, result: PlaybackResult) => {
      const entry = playing.get(sentenceId);
      if (!entry) return;
      playing.delete(sentenceId);
      const { report } = entry;
      ctx.log('stage.sentence', {
        sentenceId,
        played: result.played,
        complete: result.complete,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        startedAt: report.startedAt ?? null,
        endedAt: clock.now(),
        underruns: report.underruns,
        cursors: report.cursors,
        firstCursor: report.first ?? null,
        lastCursor: report.last ?? null,
        maxCursorGapMs: report.maxCursorGapMs,
      });
      entry.span.setAttributes({
        'bellis.stage.played_samples': result.played,
        'bellis.stage.complete': result.complete,
        'bellis.stage.underruns': report.underruns,
      });
      entry.span.end();
      entry.resolve(result);
    };

    /** 要求页面截断这一句；结果仍以页面的回报为准。 */
    const cut = (sentenceId: string) => {
      const entry = playing.get(sentenceId);
      if (entry) {
        entry.truncating = true;
        entry.stopRequested ??= { at: clock.now(), by: 'truncate' };
      }
      page.send({ kind: 'truncate', sentenceId });
    };

    /** 把页面的回报计入这一句的摘要；欠载与静音即时记录。 */
    const note = (message: FromPage, entry: Playing | undefined) => {
      const now = clock.now();
      if (message.kind === 'muted') ctx.log('stage.muted', { reason: message.reason });
      if (!entry) return;
      const { report } = entry;
      if (message.kind === 'started') {
        report.startedAt = now;
        entry.span.addEvent('bellis.stage.started');
      } else if (message.kind === 'underrun') {
        report.underruns += 1;
        entry.span.addEvent('bellis.stage.underrun');
        ctx.log('stage.underrun', { sentenceId: message.sentenceId, played: message.played });
      } else if (message.kind === 'truncated') {
        entry.span.setAttributes({ 'bellis.stage.truncated': true });
        const stop = entry.stopRequested;
        if (stop) {
          tracer.record(
            Metric.StopToSilence,
            (now - stop.at) / 1000,
            's',
            { 'bellis.stage.stop_by': stop.by },
            entry.span,
          );
        }
      } else if (message.kind === 'cursor') {
        if (report.last)
          report.maxCursorGapMs = Math.max(report.maxCursorGapMs, now - report.last[0]);
        report.cursors += 1;
        report.last = [now, message.played];
        report.first ??= report.last;
      }
    };

    ctx.register(
      page.onMessage((message) => {
        if (message.kind === 'heartbeat-ack') {
          lastAck = clock.now();
          return;
        }
        note(message, 'sentenceId' in message ? playing.get(message.sentenceId) : undefined);
        if ('sentenceId' in message) {
          const entry = playing.get(message.sentenceId);
          if (entry && 'played' in message) entry.played = message.played;
          if (message.kind === 'ended') {
            // 页面的“播完”只说明它收到的都播了：比已转发的少，就是有音频没到页面或被页面丢弃，不算完整。
            const forwarded = entry?.forwarded ?? 0;
            finish(
              message.sentenceId,
              message.played < forwarded
                ? {
                    sentenceId: message.sentenceId,
                    played: message.played,
                    complete: false,
                    reason: `页面回报播完，但只播出已转发的 ${message.played}/${forwarded} 个采样`,
                  }
                : { sentenceId: message.sentenceId, played: message.played, complete: true },
            );
          } else if (message.kind === 'truncated') {
            finish(message.sentenceId, {
              sentenceId: message.sentenceId,
              played: message.played,
              complete: false,
              reason: message.reason,
            });
          }
        }
        for (const listener of [...listeners]) listener(message);
      }),
    );

    page.send({ kind: 'token', token: null, ttlMs: 0 });
    ctx.register(
      safety.onLease((update) => {
        if (update.resource !== STAGE_AUDIO) return;
        // 令牌变了（吊销、急停、换持有者）：页面会停下持旧令牌的句子，从这一刻起算停止到静音。
        const now = clock.now();
        for (const entry of playing.values()) {
          if (entry.token !== update.lease?.token) entry.stopRequested ??= { at: now, by: 'token' };
        }
        page.send({
          kind: 'token',
          token: update.lease?.token ?? null,
          ttlMs: update.lease?.ttlMs ?? 0,
        });
      }),
    );

    /** 本轮心跳定时器预定的触发时刻。 */
    let due = clock.now();
    const beat = () => {
      const now = clock.now();
      const lateMs = now - due;
      due = now + ctx.config.heartbeatMs;
      timer = clock.setTimeout(beat, ctx.config.heartbeatMs);
      // 真实页面还没连上（例如 OBS 尚未加载 URL）：安全停止下只算未就绪；输出模式下照常计时，超时即失败。
      if (page.ready === false && !producesOutput(safety.mode)) {
        lastAck = now;
        return;
      }
      // 定时器晚到不止一个心跳周期：宿主自己刚卡过（事件循环阻塞或进程被挂起），这段时间没有发出心跳，
      // 页面自然没有应答。这一轮不判页面失败，先发心跳、从现在起重新计时。宿主卡死由外部看门狗负责，
      // 页面收不到心跳也会自静音，安全性不因此降低；真的无响应的页面最多晚一个超时被发现。
      // 阈值取一个心跳周期：S-05 实测满核负载下 250ms 定时器最多晚约 30ms，晚一整个周期只会是宿主卡过；
      // 晚到不足一个周期时，距上次应答最多约两个周期加往返（缺省约 500ms），小于页面超时（缺省 1000ms），照常判定。
      if (lateMs > ctx.config.heartbeatMs) {
        ctx.log('stage.heartbeat-late', { lateMs, sinceAckMs: now - lastAck });
        lastAck = now;
      } else if (now - lastAck > ctx.config.pageTimeoutMs) {
        for (const [id, entry] of [...playing]) {
          finish(id, {
            sentenceId: id,
            played: entry.played,
            complete: false,
            reason: 'Stage 不可用',
          });
        }
        ctx.fail(new Error('Stage 页面无响应'));
        return;
      }
      page.send({ kind: 'heartbeat' });
    };
    beat();
    ctx.register(() => {
      if (timer) clock.clearTimeout(timer);
      for (const [id, entry] of [...playing]) {
        cut(id);
        finish(id, {
          sentenceId: id,
          played: entry.played,
          complete: false,
          reason: 'Stage 服务停用',
        });
      }
    });

    const stage: Stage = {
      get ready() {
        return page.ready !== false;
      },
      async play(sentence, audio, token) {
        if (!safety.isValid(STAGE_AUDIO, token)) {
          return { sentenceId: sentence.id, played: 0, complete: false, reason: '许可无效' };
        }
        const envelope = new EnvelopeBuilder(sentence.sampleRate, ctx.config.envelopeWindowMs);
        const span = tracer.startSpan('stage.play', {
          parent: sentence.traceparent,
          attributes: {
            'bellis.stage.sentence_id': sentence.id,
            'bellis.stage.sample_rate': sentence.sampleRate,
            'bellis.stage.presentation_delay_ms': presentation.delayMs,
          },
        });
        const result = new Promise<PlaybackResult>((resolve) => {
          playing.set(sentence.id, {
            resolve,
            token,
            span,
            stopRequested: undefined,
            played: 0,
            forwarded: 0,
            truncating: false,
            envelope,
            report: {
              startedAt: undefined,
              underruns: 0,
              cursors: 0,
              first: undefined,
              last: undefined,
              maxCursorGapMs: 0,
            },
          });
        });
        // 页面可能刚重连（重连后的页面不知道呈现延迟）：每句开始前都带上。
        if (presentation.source !== 'none') sendPresentation();
        page.send({
          kind: 'begin',
          sentenceId: sentence.id,
          token,
          subtitle: sentence.subtitle,
          sampleRate: sentence.sampleRate,
        });
        const subtitleChars = [...sentence.subtitle].length;
        /** 上一次发给页面的字幕映射：没有变化就不重发。 */
        let sentStarts: readonly number[] | undefined;
        let problemLogged = false;
        /** 现读字幕映射，有变化就发给页面；映射不合格时不发，页面沿用上一份（或整句显示），每句记一次日志。 */
        const sendTiming = () => {
          const read = sentence.subtitleStarts;
          const entry = playing.get(sentence.id);
          if (!read || !entry || entry.truncating || !safety.isValid(STAGE_AUDIO, token)) return;
          let problem: string | undefined;
          try {
            const starts = read();
            if (starts === undefined || (sentStarts && sameStarts(starts, sentStarts))) return;
            const message: PageTiming = {
              kind: 'timing',
              sentenceId: sentence.id,
              token,
              starts: [...starts],
            };
            problem = timingProblem(message, subtitleChars);
            if (problem === undefined) {
              sentStarts = message.starts;
              page.send(message);
              return;
            }
          } catch (error) {
            problem = `读取映射出错：${error instanceof Error ? error.message : String(error)}`;
          }
          if (problemLogged) return;
          problemLogged = true;
          ctx.log('stage.timing-invalid', { sentenceId: sentence.id, problem });
        };
        sendTiming();
        // 转发音频与等待结果分开：结果一旦确定（播完、截断、停用）就返回，不被卡住的音频流拖住；
        // 音频流出错时截断这一句并结束等待。
        void (async () => {
          const iterator = audio[Symbol.asyncIterator]();
          try {
            for (;;) {
              const next = await Promise.race([iterator.next(), result.then(() => undefined)]);
              if (next === undefined || next.done || !playing.has(sentence.id)) break;
              if (!safety.isValid(STAGE_AUDIO, token)) {
                cut(sentence.id);
                break;
              }
              envelope.push(next.value);
              const entry = playing.get(sentence.id);
              if (entry) entry.forwarded += next.value.length;
              page.send({ kind: 'audio', sentenceId: sentence.id, token, pcm: next.value });
              // 细化的时间戳随音频到达：读完这一块再看映射。
              sendTiming();
            }
            if (playing.has(sentence.id)) {
              // 流结束后提供方已按实际采样数修正映射。
              sendTiming();
              envelope.finish();
              page.send({ kind: 'end', sentenceId: sentence.id, token });
            }
          } catch (error) {
            const entry = playing.get(sentence.id);
            finish(sentence.id, {
              sentenceId: sentence.id,
              played: entry?.played ?? 0,
              complete: false,
              reason: `音频流出错：${error instanceof Error ? error.message : String(error)}`,
            });
            page.send({ kind: 'truncate', sentenceId: sentence.id });
          } finally {
            void iterator.return?.();
          }
        })();
        return result;
      },
      truncate(sentenceId) {
        if (playing.has(sentenceId)) cut(sentenceId);
      },
      onEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      envelope(sentenceId) {
        return playing.get(sentenceId)?.envelope;
      },
      get presentation() {
        return presentation;
      },
      setPresentation(next) {
        const { delayMs, samples, source } = next;
        if (
          !isPagePresentation.Check({ kind: 'presentation', delayMs }) ||
          !Number.isInteger(samples) ||
          samples < 0 ||
          !['none', 'initial', 'meters', 'held'].includes(source)
        ) {
          ctx.log('stage.presentation-invalid', { delayMs, samples, source });
          return;
        }
        const changed = delayMs !== presentation.delayMs;
        presentation = { delayMs, samples, source };
        if (changed) sendPresentation();
      },
    };
    ctx.provide(StageService, stage);
  },
});
