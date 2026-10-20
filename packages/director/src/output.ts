import { VOTE_LIMITS } from '@bellis/audience';
import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';

/**
 * 决策模型的输出：只能从枚举的意图类型里选（动作选择模式），参数由确定性代码校验。
 * 优先级不在这里：发声的优先级由确定性代码按触发来源决定（D-33）。
 */
const closed = { additionalProperties: false } as const;

export const SpeakAction = Type.Object(
  {
    action: Type.Literal('speak'),
    text: Type.String({ minLength: 1, maxLength: 200 }),
    /** 回应的候选编号；不回应弹幕时省略。 */
    replyTo: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  },
  closed,
);

/** 发起投票：范围与投票插件冻结规则时核对的一致（VOTE_LIMITS）。 */
export const VoteAction = Type.Object(
  {
    action: Type.Literal('vote'),
    question: Type.String({ minLength: 1, maxLength: VOTE_LIMITS.maxQuestionLength }),
    options: Type.Array(Type.String({ minLength: 1, maxLength: VOTE_LIMITS.maxOptionLength }), {
      minItems: VOTE_LIMITS.minOptions,
      maxItems: VOTE_LIMITS.maxOptions,
    }),
    durationSec: Type.Integer({
      minimum: VOTE_LIMITS.minDurationSec,
      maximum: VOTE_LIMITS.maxDurationSec,
    }),
    decisionPoint: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  },
  closed,
);
export type VoteAction = Static<typeof VoteAction>;

export const SilenceAction = Type.Object(
  { action: Type.Literal('silence'), reason: Type.String({ maxLength: 100 }) },
  closed,
);

export const DirectorAction = Type.Union([SpeakAction, VoteAction, SilenceAction]);
export type DirectorAction = Static<typeof DirectorAction>;

const isAction = Compile(DirectorAction);

/** 解析模型输出；不是合法 JSON 或不符合枚举的意图时返回原因，不做修补猜测。 */
export function parseAction(
  text: string,
): { ok: true; action: DirectorAction } | { ok: false; reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: '不是合法 JSON' };
  }
  if (!isAction.Check(value)) {
    const first = [...isAction.Errors(value)][0];
    return {
      ok: false,
      reason: `不是合法的意图：${first ? `${first.instancePath || '/'} ${first.message}` : ''}`,
    };
  }
  return { ok: true, action: value };
}
