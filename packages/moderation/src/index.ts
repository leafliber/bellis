import {
  ClockService,
  DeadlineError,
  definePlugin,
  defineService,
  withDeadline,
} from '@bellis/kernel';
import { ModerationService, PreCheck, type PreCheckInput } from '@bellis/speech';
import { Metric, TelemetryService, useTracer } from '@bellis/telemetry';
import Type from 'typebox';

export interface ModerationInput {
  subtitle: string;
  spoken: string;
  /** 上一句，作为上下文。 */
  previous: string | undefined;
}

export interface ModerationVerdict {
  allowed: boolean;
  reason?: string;
}

/** 独立的审核模型，与决策模型分开（D-18）。P0 为模拟实现，真实模型待 R-12。 */
export interface ModerationModel {
  judge(input: ModerationInput, signal: AbortSignal): Promise<ModerationVerdict>;
}

export const ModerationModelService = defineService<ModerationModel>('moderation-model', 1);

/**
 * 审核插件（普通插件，可关闭）：在发声前检查扩展点上，对每句的字幕文本与朗读文本一起判定一次。
 * 不可说即跳过该句；判定超时或出错时按 `onError` 处理（默认跳过，可改为放行）；连续失败告警。
 * 有遥测时每句一个 `moderation.check` span（挂在仲裁的发声前检查下），并记“逐句审核耗时”：
 * 从开始判定到得出结论（含超时与出错），按结论分 allow、block、error。不记句子与判定理由。
 */
export const moderation = definePlugin({
  manifest: {
    id: 'moderation',
    version: '0.1.0',
    tier: 'ordinary',
    provides: [ModerationService.ref],
    inject: [ModerationModelService.ref, ClockService.ref, `${TelemetryService.ref}?`],
    permissions: [],
    process: 'in-process',
    config: Type.Object({
      onError: Type.Union([Type.Literal('skip'), Type.Literal('pass')], { default: 'skip' }),
      timeoutMs: Type.Integer({ minimum: 1, default: 1500 }),
      /** 连续失败这么多次后告警。 */
      alarmAfter: Type.Integer({ minimum: 1, default: 3 }),
    }),
  },
  activate(ctx) {
    const model = ctx.service(ModerationModelService);
    const clock = ctx.service(ClockService);
    const tracer = useTracer(ctx, 'moderation');
    const { onError, timeoutMs, alarmAfter } = ctx.config;
    let failures = 0;

    const judge = async ({ sentence, previous, traceparent }: PreCheckInput) => {
      const controller = new AbortController();
      const span = tracer.startSpan('moderation.check', { parent: traceparent });
      const startedAt = clock.now();
      const done = (outcome: 'allow' | 'block' | 'error', errorType?: string) => {
        span.setAttributes({ 'bellis.moderation.outcome': outcome });
        if (errorType) span.fail(errorType);
        tracer.record(
          Metric.ModerationDuration,
          (clock.now() - startedAt) / 1000,
          's',
          { 'bellis.moderation.outcome': outcome },
          span,
        );
        span.end();
      };
      try {
        const verdict = await withDeadline(
          clock,
          model.judge(
            { subtitle: sentence.subtitle, spoken: sentence.spoken, previous },
            controller.signal,
          ),
          timeoutMs,
          '审核判定',
        );
        failures = 0;
        done(verdict.allowed ? 'allow' : 'block');
        return verdict.allowed ? undefined : { block: `审核不可说：${verdict.reason ?? '未说明'}` };
      } catch (error) {
        controller.abort();
        failures += 1;
        done('error', error instanceof DeadlineError ? 'timeout' : 'model_error');
        ctx.log('moderation.failed', { error: (error as Error).message, failures });
        if (failures >= alarmAfter) ctx.log('moderation.alarm', { failures });
        return onError === 'skip'
          ? { block: `审核出错，按配置跳过：${(error as Error).message}` }
          : undefined;
      }
    };

    ctx.on(PreCheck, judge);
    ctx.provide(ModerationService, { onError });
  },
});

/** 模拟审核模型：按脚本判定，可以模拟出错与超时。 */
export const simModerationModel = definePlugin({
  manifest: {
    id: 'moderation-model-sim',
    version: '0.1.0',
    tier: 'ordinary',
    provides: [ModerationModelService.ref],
    inject: [ClockService.ref],
    permissions: [],
    process: 'in-process',
    config: Type.Object({
      /** 含这些片段的句子判为不可说。 */
      blocked: Type.Array(Type.String({ minLength: 1 }), { default: [] }),
      /** 含这些片段时判定出错。 */
      failOn: Type.Array(Type.String({ minLength: 1 }), { default: [] }),
      /** 含这些片段时判定永不返回（模拟超时）。 */
      hangOn: Type.Array(Type.String({ minLength: 1 }), { default: [] }),
      /** 每次判定的耗时。 */
      delayMs: Type.Integer({ minimum: 0, default: 0 }),
    }),
  },
  activate(ctx) {
    const { blocked, failOn, hangOn, delayMs } = ctx.config;
    const clock = ctx.service(ClockService);
    const has = (list: readonly string[], input: ModerationInput) =>
      list.find((word) => input.subtitle.includes(word) || input.spoken.includes(word));
    ctx.provide(ModerationModelService, {
      async judge(input) {
        if (has(hangOn, input)) return new Promise<never>(() => {});
        if (delayMs > 0)
          await new Promise((resolve) => clock.setTimeout(() => resolve(undefined), delayMs));
        const failing = has(failOn, input);
        if (failing) throw new Error(`模拟审核模型出错：${failing}`);
        const hit = has(blocked, input);
        return hit ? { allowed: false, reason: `含“${hit}”` } : { allowed: true };
      },
    });
  },
});
