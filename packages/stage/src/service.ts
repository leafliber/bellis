import { ClockService, definePlugin, type TimerHandle } from '@bellis/kernel';
import { producesOutput, SafetyService } from '@bellis/safety';
import Type from 'typebox';
import { EnvelopeBuilder } from './envelope.ts';
import {
  type FromPage,
  type PlaybackResult,
  STAGE_AUDIO,
  type Stage,
  StagePageService,
  StageService,
} from './types.ts';

interface Playing {
  resolve(result: PlaybackResult): void;
  played: number;
  /** 已转发给页面的采样数；页面回报 ended 时据此判断是否完整。 */
  forwarded: number;
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

/**
 * Stage 服务（关键平面）：只转发带有效 Stage 音频输出许可令牌的音频，把令牌变化告诉页面，
 * 定时发心跳；页面在截止时间内不应答心跳即报告失败，由安全核走急停路径（D-30）。
 * 转发音频时按句计算响度包络，供形象驱动口型。
 * 页面回报的欠载与静音即时记入日志；每句结束时记一条摘要（实际播出的采样数、欠载次数、游标回报的
 * 次数、首末两次游标与最大间隔），游标本身不逐条记录。
 */
export const stageService = definePlugin({
  manifest: {
    id: 'stage-service',
    version: '0.1.0',
    tier: 'critical',
    provides: [StageService.ref],
    inject: [SafetyService.ref, ClockService.ref, StagePageService.ref],
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
    const listeners = new Set<(event: FromPage) => void>();
    const playing = new Map<string, Playing>();
    let lastAck = clock.now();
    let timer: TimerHandle | undefined;

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
      entry.resolve(result);
    };

    /** 把页面的回报计入这一句的摘要；欠载与静音即时记录。 */
    const note = (message: FromPage, entry: Playing | undefined) => {
      const now = clock.now();
      if (message.kind === 'muted') ctx.log('stage.muted', { reason: message.reason });
      if (!entry) return;
      const { report } = entry;
      if (message.kind === 'started') report.startedAt = now;
      else if (message.kind === 'underrun') {
        report.underruns += 1;
        ctx.log('stage.underrun', { sentenceId: message.sentenceId, played: message.played });
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
        page.send({
          kind: 'token',
          token: update.lease?.token ?? null,
          ttlMs: update.lease?.ttlMs ?? 0,
        });
      }),
    );

    const beat = () => {
      timer = clock.setTimeout(beat, ctx.config.heartbeatMs);
      // 真实页面还没连上（例如 OBS 尚未加载 URL）：安全停止下只算未就绪；输出模式下照常计时，超时即失败。
      if (page.ready === false && !producesOutput(safety.mode)) {
        lastAck = clock.now();
        return;
      }
      if (clock.now() - lastAck > ctx.config.pageTimeoutMs) {
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
        page.send({ kind: 'truncate', sentenceId: id });
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
        const result = new Promise<PlaybackResult>((resolve) => {
          playing.set(sentence.id, {
            resolve,
            played: 0,
            forwarded: 0,
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
        page.send({
          kind: 'begin',
          sentenceId: sentence.id,
          token,
          subtitle: sentence.subtitle,
          sampleRate: sentence.sampleRate,
        });
        // 转发音频与等待结果分开：结果一旦确定（播完、截断、停用）就返回，不被卡住的音频流拖住；
        // 音频流出错时截断这一句并结束等待。
        void (async () => {
          const iterator = audio[Symbol.asyncIterator]();
          try {
            for (;;) {
              const next = await Promise.race([iterator.next(), result.then(() => undefined)]);
              if (next === undefined || next.done || !playing.has(sentence.id)) break;
              if (!safety.isValid(STAGE_AUDIO, token)) {
                page.send({ kind: 'truncate', sentenceId: sentence.id });
                break;
              }
              envelope.push(next.value);
              const entry = playing.get(sentence.id);
              if (entry) entry.forwarded += next.value.length;
              page.send({ kind: 'audio', sentenceId: sentence.id, token, pcm: next.value });
            }
            if (playing.has(sentence.id)) {
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
        if (playing.has(sentenceId)) page.send({ kind: 'truncate', sentenceId });
      },
      onEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      envelope(sentenceId) {
        return playing.get(sentenceId)?.envelope;
      },
    };
    ctx.provide(StageService, stage);
  },
});
