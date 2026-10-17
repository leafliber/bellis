import { ClockService, definePlugin, type TimerHandle } from '@bellis/kernel';
import { producesOutput, SafetyService } from '@bellis/safety';
import Type from 'typebox';
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
}

/**
 * Stage 服务（关键平面）：只转发带有效 Stage 音频输出许可令牌的音频，把令牌变化告诉页面，
 * 定时发心跳；页面在截止时间内不应答心跳即报告失败，由安全核走急停路径（D-30）。
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
      entry.resolve(result);
    };

    ctx.register(
      page.onMessage((message) => {
        if (message.kind === 'heartbeat-ack') {
          lastAck = clock.now();
          return;
        }
        if ('sentenceId' in message) {
          const entry = playing.get(message.sentenceId);
          if (entry && 'played' in message) entry.played = message.played;
          if (message.kind === 'ended') {
            finish(message.sentenceId, {
              sentenceId: message.sentenceId,
              played: message.played,
              complete: true,
            });
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
        const result = new Promise<PlaybackResult>((resolve) => {
          playing.set(sentence.id, { resolve, played: 0 });
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
              page.send({ kind: 'audio', sentenceId: sentence.id, token, pcm: next.value });
            }
            if (playing.has(sentence.id))
              page.send({ kind: 'end', sentenceId: sentence.id, token });
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
    };
    ctx.provide(StageService, stage);
  },
});
