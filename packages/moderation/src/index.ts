import { ClockService, definePlugin, defineService, withDeadline } from '@bellis/kernel';
import { ModerationService, PreCheck, type Sentence } from '@bellis/speech';
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
 */
export const moderation = definePlugin({
  manifest: {
    id: 'moderation',
    version: '0.1.0',
    tier: 'ordinary',
    provides: [ModerationService.ref],
    inject: [ModerationModelService.ref, ClockService.ref],
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
    const { onError, timeoutMs, alarmAfter } = ctx.config;
    let failures = 0;

    const judge = async (sentence: Sentence, previous: string | undefined) => {
      const controller = new AbortController();
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
        return verdict.allowed ? undefined : { block: `审核不可说：${verdict.reason ?? '未说明'}` };
      } catch (error) {
        controller.abort();
        failures += 1;
        ctx.log('moderation.failed', { error: (error as Error).message, failures });
        if (failures >= alarmAfter) ctx.log('moderation.alarm', { failures });
        return onError === 'skip'
          ? { block: `审核出错，按配置跳过：${(error as Error).message}` }
          : undefined;
      }
    };

    ctx.on(PreCheck, (input) => judge(input.sentence, input.previous));
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
    inject: [],
    permissions: [],
    process: 'in-process',
    config: Type.Object({
      /** 含这些片段的句子判为不可说。 */
      blocked: Type.Array(Type.String({ minLength: 1 }), { default: [] }),
      /** 含这些片段时判定出错。 */
      failOn: Type.Array(Type.String({ minLength: 1 }), { default: [] }),
      /** 含这些片段时判定永不返回（模拟超时）。 */
      hangOn: Type.Array(Type.String({ minLength: 1 }), { default: [] }),
    }),
  },
  activate(ctx) {
    const { blocked, failOn, hangOn } = ctx.config;
    const has = (list: readonly string[], input: ModerationInput) =>
      list.find((word) => input.subtitle.includes(word) || input.spoken.includes(word));
    ctx.provide(ModerationModelService, {
      async judge(input) {
        if (has(hangOn, input)) return new Promise<never>(() => {});
        const failing = has(failOn, input);
        if (failing) throw new Error(`模拟审核模型出错：${failing}`);
        const hit = has(blocked, input);
        return hit ? { allowed: false, reason: `含“${hit}”` } : { allowed: true };
      },
    });
  },
});
