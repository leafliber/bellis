import { ClockService, definePlugin, type TimerHandle } from '@bellis/kernel';
import { SafetyService } from '@bellis/safety';
import Type from 'typebox';
import {
  type HeldSentence,
  type Review,
  ReviewService,
  type ReviewSettings,
  type ReviewVerdict,
} from './types.ts';

interface Pending {
  sentence: HeldSentence;
  timer: TimerHandle;
  done(verdict: ReviewVerdict | undefined): void;
  detach(): void;
}

type Ending =
  | { event: 'released'; by: 'operator' | 'delay' }
  | { event: 'vetoed'; reason: string; abandon: boolean }
  | { event: 'withdrawn'; reason: string; timedOut?: true };

/**
 * M1 的逐句放行环节，两种方式（配置 `mode`）：
 * - `delay`（缺省）：每句播出前等待 profile 配置的延迟，期满放行；期间操作员可以否决，也可以提前放行。
 * - `approve`：每句等操作员放行才播出；超过 `approveTimeoutMs` 没放行就撤回，不播出。
 * 否决与放行都经安全核的控制通道送到这里（`pnpm operator veto` / `release`，或操作台）。给句键时只针对那一句；
 * 不给句键的否决否决此刻等待中的句子，并告诉仲裁放弃它们所属发言剩下的句子（`abandon`，事实里记 `abandoned`）。
 * 每句等待恰好以一个事件结束：放行 `speech.released`（`by` 为 operator 或 delay）、否决 `speech.vetoed`，
 * 或撤回 `speech.withdrawn`（超时、停止、模式变化、发言中止、插件停用；都不播出）。
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
      /** 放行方式：delay 为固定延迟加否决，approve 为逐句等操作员放行。 */
      mode: Type.Union([Type.Literal('delay'), Type.Literal('approve')], { default: 'delay' }),
      /** delay：每句播出前等待的时间，操作员在此期间可以否决或提前放行。 */
      delayMs: Type.Integer({ minimum: 0, default: 3000 }),
      /** approve：等操作员放行的上限，超过就撤回这一句。 */
      approveTimeoutMs: Type.Integer({ minimum: 1, default: 30_000 }),
    }),
  },
  activate(ctx) {
    const safety = ctx.service(SafetyService);
    const clock = ctx.service(ClockService);
    const settings: ReviewSettings = {
      mode: ctx.config.mode,
      delayMs: ctx.config.delayMs,
      approveTimeoutMs: ctx.config.approveTimeoutMs,
    };
    const pending = new Map<string, Pending>();

    const settle = (key: string, ending: Ending) => {
      const item = pending.get(key);
      if (!item) return;
      pending.delete(key);
      clock.clearTimeout(item.timer);
      item.detach();
      if (ending.event === 'vetoed') {
        safety.record('speech.vetoed', {
          ...item.sentence,
          reason: ending.reason,
          ...(ending.abandon ? { abandoned: true } : {}),
        });
      } else if (ending.event === 'released') {
        safety.record('speech.released', { key, by: ending.by });
      } else {
        safety.record('speech.withdrawn', {
          key,
          reason: ending.reason,
          ...(ending.timedOut ? { timedOut: true } : {}),
        });
      }
      item.done(
        ending.event === 'released'
          ? undefined
          : ending.event === 'vetoed' && ending.abandon
            ? { block: ending.reason, abandon: true }
            : { block: ending.reason },
      );
    };
    const withdrawAll = (reason: string) => {
      for (const key of [...pending.keys()]) settle(key, { event: 'withdrawn', reason });
    };
    const keysOf = (key: string | undefined) => (key === undefined ? [...pending.keys()] : [key]);

    ctx.register(
      safety.onControl((signal) => {
        if (signal.kind === 'veto') {
          // 不给句键：否决此刻等待中的句子，并放弃它们所属发言剩下的句子。
          const abandon = signal.key === undefined;
          for (const key of keysOf(signal.key))
            settle(key, { event: 'vetoed', reason: signal.reason, abandon });
        } else if (signal.kind === 'release') {
          for (const key of keysOf(signal.key)) settle(key, { event: 'released', by: 'operator' });
        } else if (signal.kind === 'stop') {
          withdrawAll(signal.reason);
        } else if (signal.kind === 'mode' && signal.mode !== 'M1') {
          withdrawAll(`监督模式已切到 ${signal.mode}`);
        }
      }),
    );
    ctx.register(() => withdrawAll('放行环节停用'));

    const review: Review = {
      settings,
      hold(sentence, signal) {
        if (ctx.signal.aborted) return Promise.resolve({ block: '放行环节停用' });
        if (signal.aborted) return Promise.resolve({ block: '发言已中止' });
        return new Promise((resolve) => {
          const key = sentence.key;
          const onAbort = () => settle(key, { event: 'withdrawn', reason: '发言已中止' });
          signal.addEventListener('abort', onAbort, { once: true });
          const approve = settings.mode === 'approve';
          safety.record(
            'speech.held',
            approve
              ? { ...sentence, mode: 'approve', timeoutMs: settings.approveTimeoutMs }
              : { ...sentence, mode: 'delay', delayMs: settings.delayMs },
          );
          const timer = approve
            ? clock.setTimeout(
                () =>
                  settle(key, {
                    event: 'withdrawn',
                    reason: `等待放行超时（${settings.approveTimeoutMs}ms）`,
                    timedOut: true,
                  }),
                settings.approveTimeoutMs,
              )
            : clock.setTimeout(
                () => settle(key, { event: 'released', by: 'delay' }),
                settings.delayMs,
              );
          pending.set(key, {
            sentence,
            timer,
            done: resolve,
            detach: () => signal.removeEventListener('abort', onAbort),
          });
        });
      },
    };
    ctx.provide(ReviewService, review);
  },
});
