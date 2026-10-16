import { ClockService, definePlugin, type TimerHandle } from '@bellis/kernel';
import { SafetyService } from '@bellis/safety';
import Type from 'typebox';
import { type HeldSentence, type Review, ReviewService } from './types.ts';

interface Pending {
  sentence: HeldSentence;
  timer: TimerHandle;
  done(reason: string | undefined): void;
  detach(): void;
}

/**
 * M1 的固定延迟加否决：每句播出前等待 profile 配置的延迟，期间操作员可以否决
 * （`pnpm operator veto`，经安全核的控制通道送到这里）。被否决的句子不播出。
 * 每句等待恰好以一个事件结束：期满放行 `speech.released`、操作员否决 `speech.vetoed`，
 * 或因停止、模式变化、发言中止、插件停用而撤回 `speech.withdrawn`（都不播出）。
 */
export const speechReview = definePlugin({
  manifest: {
    id: 'speech-review',
    version: '0.1.0',
    tier: 'ordinary',
    provides: [ReviewService.ref],
    inject: [SafetyService.ref, ClockService.ref],
    permissions: [],
    process: 'in-process',
    config: Type.Object({
      /** 每句播出前等待的时间，操作员在此期间可以否决。 */
      delayMs: Type.Integer({ minimum: 0, default: 3000 }),
    }),
  },
  activate(ctx) {
    const safety = ctx.service(SafetyService);
    const clock = ctx.service(ClockService);
    const pending = new Map<string, Pending>();

    /** 结束一句的等待：undefined 为放行，否则为拦下的原因。 */
    const settle = (key: string, event: 'released' | 'vetoed' | 'withdrawn', reason?: string) => {
      const item = pending.get(key);
      if (!item) return;
      pending.delete(key);
      clock.clearTimeout(item.timer);
      item.detach();
      if (event === 'vetoed') safety.record('speech.vetoed', { ...item.sentence, reason });
      else safety.record(`speech.${event}`, { key, ...(reason ? { reason } : {}) });
      item.done(event === 'released' ? undefined : reason);
    };
    const withdrawAll = (reason: string) => {
      for (const key of [...pending.keys()]) settle(key, 'withdrawn', reason);
    };

    ctx.register(
      safety.onControl((signal) => {
        if (signal.kind === 'veto') {
          const keys = signal.key === undefined ? [...pending.keys()] : [signal.key];
          for (const key of keys) settle(key, 'vetoed', signal.reason);
        } else if (signal.kind === 'stop') {
          withdrawAll(signal.reason);
        } else if (signal.mode !== 'M1') {
          withdrawAll(`监督模式已切到 ${signal.mode}`);
        }
      }),
    );
    ctx.register(() => withdrawAll('放行环节停用'));

    const review: Review = {
      hold(sentence, signal) {
        if (ctx.signal.aborted) return Promise.resolve('放行环节停用');
        if (signal.aborted) return Promise.resolve('发言已中止');
        return new Promise((resolve) => {
          const onAbort = () => settle(sentence.key, 'withdrawn', '发言已中止');
          signal.addEventListener('abort', onAbort, { once: true });
          safety.record('speech.held', { ...sentence, delayMs: ctx.config.delayMs });
          pending.set(sentence.key, {
            sentence,
            timer: clock.setTimeout(() => settle(sentence.key, 'released'), ctx.config.delayMs),
            done: resolve,
            detach: () => signal.removeEventListener('abort', onAbort),
          });
        });
      },
    };
    ctx.provide(ReviewService, review);
  },
});
