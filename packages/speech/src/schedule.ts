import { ClockService, definePlugin, type TimerHandle } from '@bellis/kernel';
import Type from 'typebox';
import { SpeechService } from './types.ts';

/**
 * 定时播报：操作员预先配置的节目提示，到点以“定时播报”来源提交发声请求。
 * 时间从插件激活时算起。
 */
export const scheduledAnnouncements = definePlugin({
  manifest: {
    id: 'speech-schedule',
    version: '0.1.0',
    tier: 'ordinary',
    provides: [],
    inject: [SpeechService.ref, ClockService.ref],
    permissions: [],
    process: 'in-process',
    config: Type.Object({
      announcements: Type.Array(
        Type.Object({
          id: Type.String({ minLength: 1 }),
          atMs: Type.Integer({ minimum: 0 }),
          text: Type.String(),
        }),
      ),
      /** 到点后多久内还没播出就过期。 */
      ttlMs: Type.Integer({ minimum: 1, default: 30_000 }),
      preempt: Type.Union([Type.Literal('sentence'), Type.Literal('immediate')], {
        default: 'sentence',
      }),
    }),
  },
  activate(ctx) {
    const speech = ctx.service(SpeechService);
    const clock = ctx.service(ClockService);
    const start = clock.now();
    const timers: TimerHandle[] = [];
    for (const announcement of ctx.config.announcements) {
      timers.push(
        clock.setTimeout(
          () => {
            void speech.request({
              id: `scheduled:${announcement.id}`,
              source: 'scheduled',
              text: announcement.text,
              expiresAt: clock.now() + ctx.config.ttlMs,
              preempt: ctx.config.preempt,
              inputs: [],
              untrusted: false,
            });
          },
          Math.max(0, start + announcement.atMs - clock.now()),
        ),
      );
    }
    ctx.register(() => {
      for (const timer of timers) clock.clearTimeout(timer);
    });
  },
});
