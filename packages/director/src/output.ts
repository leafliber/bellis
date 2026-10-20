import { VOTE_LIMITS } from '@bellis/audience';
import Type, { type Static, type TObject, type TSchema } from 'typebox';
import { Compile } from 'typebox/compile';

/**
 * 决策模型的输出：只能从枚举的意图类型里选（动作选择模式），参数由确定性代码校验。
 * 优先级不在这里：发声的优先级由确定性代码按触发来源决定（D-33）。
 * 每个意图的 `action` 写在最前面（以后增量解析时先知道动作类型）；`description` 用于提示词与严格 schema 的说明。
 */
const closed = { additionalProperties: false } as const;

export const SpeakAction = Type.Object(
  {
    action: Type.Literal('speak'),
    /** 回应的候选编号；不回应弹幕时省略。写在文本之前：先知道回应谁，再读文本。 */
    replyTo: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 64,
        description: '回应的候选弹幕编号；不回应具体某条弹幕时为 null',
      }),
    ),
    text: Type.String({ minLength: 1, maxLength: 200, description: '要说的话' }),
  },
  { ...closed, description: '说话' },
);

/** 发起投票：范围与投票插件冻结规则时核对的一致（VOTE_LIMITS）。 */
export const VoteAction = Type.Object(
  {
    action: Type.Literal('vote'),
    question: Type.String({
      minLength: 1,
      maxLength: VOTE_LIMITS.maxQuestionLength,
      description: '投票题目',
    }),
    options: Type.Array(Type.String({ minLength: 1, maxLength: VOTE_LIMITS.maxOptionLength }), {
      minItems: VOTE_LIMITS.minOptions,
      maxItems: VOTE_LIMITS.maxOptions,
      description: '选项',
    }),
    durationSec: Type.Integer({
      minimum: VOTE_LIMITS.minDurationSec,
      maximum: VOTE_LIMITS.maxDurationSec,
      description: '投票时长（秒）',
    }),
    decisionPoint: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 64,
        description: '游戏决策点编号；没有游戏决策点时为 null',
      }),
    ),
  },
  { ...closed, description: '发起投票' },
);
export type VoteAction = Static<typeof VoteAction>;

export const SilenceAction = Type.Object(
  {
    action: Type.Literal('silence'),
    reason: Type.String({ maxLength: 100, description: '保持沉默的原因' }),
  },
  { ...closed, description: '保持沉默' },
);

export const DirectorAction = Type.Union([SpeakAction, VoteAction, SilenceAction]);
export type DirectorAction = Static<typeof DirectorAction>;

/** 意图的各个变体（按 {@link DirectorAction} 的顺序）。 */
export const ACTION_VARIANTS: readonly TObject[] = [SpeakAction, VoteAction, SilenceAction];

const isAction = Compile(DirectorAction);

export type ParseResult = { ok: true; action: DirectorAction } | { ok: false; reason: string };

function check(value: unknown): ParseResult {
  if (!isAction.Check(value)) {
    const first = [...isAction.Errors(value)][0];
    return {
      ok: false,
      reason: `不是合法的意图：${first ? `${first.instancePath || '/'} ${first.message}` : ''}`,
    };
  }
  return { ok: true, action: value };
}

/** 解析模型输出；不是合法 JSON 或不符合枚举的意图时返回原因，不做修补猜测。 */
export function parseAction(text: string): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: '不是合法 JSON' };
  }
  return check(value);
}

/**
 * 解析模型输出的意图（各种输出方式共用）：先按 JSON 解析，顶层取值为 null 的字段视为省略（严格 schema 要求
 * 所有字段都出现，用不到的字段填 null，见 {@link strictIntentSchema}），再按 {@link parseAction} 的规则校验。
 * 只做这一种确定的换算，其余不合法的输出照样丢弃，不修补。
 */
export function parseIntent(text: string): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: '不是合法 JSON' };
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    value = Object.fromEntries(Object.entries(value).filter(([, field]) => field !== null));
  }
  return check(value);
}

/** 严格 schema 里允许出现的关键字：各家结构化输出都支持的最小集合。 */
export const STRICT_KEYWORDS: ReadonlySet<string> = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'description',
]);

type JsonSchema = Record<string, unknown>;

const lengthWord = (min: unknown, max: unknown, unit: string): string | undefined => {
  const low = typeof min === 'number' && min > 0 ? min : undefined;
  const high = typeof max === 'number' ? max : undefined;
  if (low !== undefined && high !== undefined) return `${low}–${high} ${unit}`;
  if (high !== undefined) return `至多 ${high} ${unit}`;
  if (low !== undefined) return `至少 ${low} ${unit}`;
  return undefined;
};

/** 字段的取值范围（中文），由 TypeBox 的约束换算；提示词与严格 schema 的说明共用。 */
export function limitsOf(schema: TSchema): string[] {
  const s = schema as unknown as JsonSchema;
  const out: string[] = [];
  if (s.type === 'string') {
    const length = lengthWord(s.minLength, s.maxLength, '字');
    if (length) out.push(length);
  } else if (s.type === 'integer' || s.type === 'number') {
    const kind = s.type === 'integer' ? '整数' : '数';
    if (typeof s.minimum === 'number' && typeof s.maximum === 'number') {
      out.push(`${kind} ${s.minimum}–${s.maximum}`);
    } else {
      out.push(kind);
    }
  } else if (s.type === 'array') {
    const count = lengthWord(s.minItems, s.maxItems, '项');
    if (count) out.push(count);
    const items = s.items as TSchema | undefined;
    if (items) {
      const each = limitsOf(items);
      if (each.length > 0) out.push(`每项 ${each.join('，')}`);
    }
  }
  return out;
}

/** 把一个字段的 TypeBox schema 换成严格 schema（只用 {@link STRICT_KEYWORDS}），约束写进说明。 */
function strictField(schema: TSchema, nullable: boolean): JsonSchema {
  const s = schema as unknown as JsonSchema;
  const type = s.type;
  if (type !== 'string' && type !== 'integer' && type !== 'number' && type !== 'boolean') {
    if (type !== 'array') throw new Error(`严格 schema 不支持这种字段：${JSON.stringify(s)}`);
  }
  const out: JsonSchema = { type: nullable ? [type, 'null'] : type };
  if (type === 'array') out.items = strictField(s.items as TSchema, false);
  const words = [
    ...(typeof s.description === 'string' ? [s.description] : []),
    ...limitsOf(schema),
  ];
  if (words.length > 0) out.description = words.join('；');
  return out;
}

/**
 * 从 {@link DirectorAction} 派生的严格兼容 JSON Schema（结构化输出的严格模式与函数参数用）：
 * - 根是一个对象，不用 anyOf：各变体的字段合在一起，`action` 是枚举并排在最前，其余字段按首次出现的顺序；
 * - 所有字段都在 `required` 里，`action` 以外的字段都可为 null（不属于所选变体、或可选而省略时填 null）；
 * - `additionalProperties: false`；只用 {@link STRICT_KEYWORDS}，长度、范围与个数写进说明。
 *
 * 它比原 schema 宽：解析时先把 null 视为省略，再按原 schema 校验（{@link parseIntent}），不合法就丢弃。
 */
export function strictIntentSchema(): JsonSchema {
  const actions: string[] = [];
  const fields = new Map<string, { schema: TSchema; usedBy: string[] }>();
  for (const variant of ACTION_VARIANTS) {
    const props = variant.properties as Record<string, TSchema>;
    const action = (props.action as unknown as JsonSchema).const;
    if (typeof action !== 'string') throw new Error('意图变体缺少 action 字面量');
    actions.push(action);
    for (const [name, schema] of Object.entries(props)) {
      if (name === 'action') continue;
      const found = fields.get(name);
      if (!found) {
        fields.set(name, { schema, usedBy: [action] });
      } else if (JSON.stringify(found.schema) === JSON.stringify(schema)) {
        found.usedBy.push(action);
      } else {
        throw new Error(`意图变体里同名字段 ${name} 的 schema 不同，不能合并`);
      }
    }
  }
  const properties: Record<string, JsonSchema> = {
    action: { type: 'string', enum: actions, description: '意图类型' },
  };
  for (const [name, { schema, usedBy }] of fields) {
    const field = strictField(schema, true);
    const scope = `仅用于 action 为 ${usedBy.join('、')} 时，其余填 null`;
    field.description = field.description ? `${field.description}；${scope}` : scope;
    properties[name] = field;
  }
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

/**
 * 把合法的意图写成严格 schema 的形状：缺的字段补 null（测试与探针用，核对两种写法一一对应）。
 */
export function toStrictIntent(action: DirectorAction): Record<string, unknown> {
  const schema = strictIntentSchema();
  const properties = schema.properties as Record<string, unknown>;
  const record = action as Record<string, unknown>;
  return Object.fromEntries(Object.keys(properties).map((name) => [name, record[name] ?? null]));
}
