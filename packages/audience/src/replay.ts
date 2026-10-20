import { ClockService, definePlugin, type TimerHandle, TraceService } from '@bellis/kernel';
import Type from 'typebox';
import { type Danmaku, type DanmakuGap, DanmakuService } from './triage.ts';

/**
 * 录制弹幕回放（P0 用）：按记录的时间偏移依次送出。时间从插件激活时算起。
 * 可以模拟接收缺口：缺口期间到点的弹幕收不到（丢弃），缺口的开始与结束经 `danmaku@1` 通知。
 * 在仿真里把送出的弹幕与缺口写进追踪。
 */
export const danmakuReplay = definePlugin({
  manifest: {
    id: 'danmaku-replay',
    version: '0.1.0',
    tier: 'ordinary',
    provides: [DanmakuService.ref],
    inject: [ClockService.ref, `${TraceService.ref}?`],
    permissions: [],
    process: 'in-process',
    config: Type.Object({
      messages: Type.Array(
        Type.Object({
          atMs: Type.Integer({ minimum: 0 }),
          id: Type.String({ minLength: 1 }),
          viewer: Type.String({ minLength: 1 }),
          nickname: Type.String(),
          text: Type.String(),
        }),
      ),
      gaps: Type.Array(
        Type.Object({
          atMs: Type.Integer({ minimum: 0 }),
          durationMs: Type.Integer({ minimum: 1 }),
          reason: Type.String({ default: '回放的缺口' }),
        }),
        { default: [] },
      ),
    }),
  },
  activate(ctx) {
    const clock = ctx.service(ClockService);
    const trace = ctx.optional(TraceService);
    const listeners = new Set<(danmaku: Danmaku) => void>();
    const gapListeners = new Set<(gap: DanmakuGap | undefined) => void>();
    let gap: DanmakuGap | undefined;
    const start = clock.now();
    const at = (offset: number) => Math.max(0, start + offset - clock.now());
    const setGap = (next: DanmakuGap | undefined) => {
      if ((gap === undefined) === (next === undefined)) return;
      gap = next;
      trace?.record(next ? 'danmaku.gap-started' : 'danmaku.gap-ended', next ? { ...next } : {});
      for (const listener of [...gapListeners]) listener(next);
    };
    const timers: TimerHandle[] = ctx.config.gaps.flatMap((g) => [
      clock.setTimeout(() => setGap({ reason: g.reason }), at(g.atMs)),
      clock.setTimeout(() => setGap(undefined), at(g.atMs + g.durationMs)),
    ]);
    for (const message of ctx.config.messages) {
      timers.push(
        clock.setTimeout(() => {
          if (gap) {
            trace?.record('danmaku.lost', { id: message.id });
            return;
          }
          const danmaku: Danmaku = {
            id: message.id,
            viewer: message.viewer,
            nickname: message.nickname,
            text: message.text,
          };
          trace?.record('danmaku.delivered', { ...danmaku });
          for (const listener of [...listeners]) listener(danmaku);
        }, at(message.atMs)),
      );
    }
    ctx.register(() => {
      for (const timer of timers) clock.clearTimeout(timer);
    });
    ctx.provide(DanmakuService, {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      gap: () => gap,
      onGap(listener) {
        gapListeners.add(listener);
        return () => gapListeners.delete(listener);
      },
    });
  },
});
