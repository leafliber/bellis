import { ClockService, definePlugin, type TimerHandle } from '@bellis/kernel';
import Type from 'typebox';
import { type Danmaku, DanmakuService } from './triage.ts';

/** 录制弹幕回放（P0 用）：按记录的时间偏移依次送出。时间从插件激活时算起。 */
export const danmakuReplay = definePlugin({
  manifest: {
    id: 'danmaku-replay',
    version: '0.1.0',
    tier: 'ordinary',
    provides: [DanmakuService.ref],
    inject: [ClockService.ref],
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
    }),
  },
  activate(ctx) {
    const clock = ctx.service(ClockService);
    const listeners = new Set<(danmaku: Danmaku) => void>();
    const start = clock.now();
    const timers: TimerHandle[] = ctx.config.messages.map((message) =>
      clock.setTimeout(
        () => {
          const danmaku: Danmaku = {
            id: message.id,
            viewer: message.viewer,
            nickname: message.nickname,
            text: message.text,
          };
          for (const listener of [...listeners]) listener(danmaku);
        },
        Math.max(0, start + message.atMs - clock.now()),
      ),
    );
    ctx.register(() => {
      for (const timer of timers) clock.clearTimeout(timer);
    });
    ctx.provide(DanmakuService, {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
  },
});
