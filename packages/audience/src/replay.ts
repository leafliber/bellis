import { ClockService, definePlugin, type TimerHandle, TraceService } from '@bellis/kernel';
import { isRealOutput, SafetyService } from '@bellis/safety';
import { TelemetryService, traceRef, useTracer } from '@bellis/telemetry';
import Type from 'typebox';
import { type Danmaku, type DanmakuGap, DanmakuService, receiveSpan } from './triage.ts';

/**
 * 录制弹幕回放（P0 用）：按记录的时间偏移依次送出。时间从插件激活时算起；`startOn: "output"` 时从第一次进入
 * 真实输出模式（M1–M3）时算起，用于真机演练里以录制回放注入弹幕，对齐操作员开播的时刻（之后模式再变也不暂停）。
 * 可以模拟接收缺口：缺口期间到点的弹幕收不到（丢弃），缺口的开始与结束经 `danmaku@1` 通知。
 * 在仿真里把送出的弹幕与缺口写进追踪。有遥测时与真实接入一样为每条送出的弹幕开一个根 span。
 */
export const danmakuReplay = definePlugin({
  manifest: {
    id: 'danmaku-replay',
    version: '0.2.0',
    tier: 'ordinary',
    provides: [DanmakuService.ref],
    inject: [
      ClockService.ref,
      `${SafetyService.ref}?`,
      `${TraceService.ref}?`,
      `${TelemetryService.ref}?`,
    ],
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
      /** 时间从何时算起：插件激活（缺省），或第一次进入真实输出模式（M1–M3）。 */
      startOn: Type.Union([Type.Literal('activation'), Type.Literal('output')], {
        default: 'activation',
      }),
    }),
  },
  activate(ctx) {
    const clock = ctx.service(ClockService);
    const trace = ctx.optional(TraceService);
    const tracer = useTracer(ctx, 'danmaku-replay');
    const listeners = new Set<(danmaku: Danmaku) => void>();
    const gapListeners = new Set<(gap: DanmakuGap | undefined) => void>();
    let gap: DanmakuGap | undefined;
    let started = false;
    const timers: TimerHandle[] = [];
    const setGap = (next: DanmakuGap | undefined) => {
      if ((gap === undefined) === (next === undefined)) return;
      gap = next;
      trace?.record(next ? 'danmaku.gap-started' : 'danmaku.gap-ended', next ? { ...next } : {});
      for (const listener of [...gapListeners]) listener(next);
    };
    const deliver = (message: (typeof ctx.config.messages)[number]) => {
      if (gap) {
        trace?.record('danmaku.lost', { id: message.id });
        return;
      }
      const span = receiveSpan(tracer, 'replay', message.id);
      const ref = traceRef(span, clock.now());
      const danmaku: Danmaku = {
        id: message.id,
        viewer: message.viewer,
        nickname: message.nickname,
        text: message.text,
        ...(ref ? { trace: ref } : {}),
      };
      trace?.record('danmaku.delivered', {
        id: danmaku.id,
        viewer: danmaku.viewer,
        nickname: danmaku.nickname,
        text: danmaku.text,
      });
      for (const listener of [...listeners]) listener(danmaku);
      span.end();
    };
    /** 开始计时：按偏移排好全部缺口与弹幕。 */
    const start = () => {
      if (started || ctx.signal.aborted) return;
      started = true;
      for (const g of ctx.config.gaps) {
        timers.push(
          clock.setTimeout(() => setGap({ reason: g.reason }), g.atMs),
          clock.setTimeout(() => setGap(undefined), g.atMs + g.durationMs),
        );
      }
      for (const message of ctx.config.messages) {
        timers.push(clock.setTimeout(() => deliver(message), message.atMs));
      }
      if (ctx.config.startOn === 'output') {
        ctx.log('danmaku-replay.started', {
          messages: ctx.config.messages.length,
          gaps: ctx.config.gaps.length,
        });
      }
    };
    ctx.register(() => {
      for (const timer of timers) clock.clearTimeout(timer);
    });
    if (ctx.config.startOn === 'activation') start();
    else {
      const safety = ctx.optional(SafetyService);
      if (!safety) throw new Error('startOn 为 output 时需要安全核的门面（SafetyService）');
      if (isRealOutput(safety.mode)) start();
      else
        ctx.register(
          safety.onControl((signal) => {
            if (signal.kind === 'mode' && isRealOutput(signal.mode)) start();
          }),
        );
    }
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
      // 回放没有要连接的平台：恒为就绪（缺口照常经 gap() 报告）。
      ready: true,
      get status() {
        return started ? '回放' : '回放（进入真实输出模式后开始）';
      },
    });
  },
});
