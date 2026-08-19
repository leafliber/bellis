import { z } from "zod";
import {
  AvatarIntentSchema,
  GameIntentSchema,
  OverlayIntentSchema,
  SpeechIntentSchema,
  SyncPolicySchema,
} from "./intents.js";

/**
 * ActionFrame：一次模型请求对应的一次行动机会（ADR 0001）。
 *
 * - 发言只存在于 action.speech，不存在顶层 message/speech 字段。
 * - 静默行动不需要伪造文本：无 speech 时可以只有 avatar/game/overlay。
 * - 明确静默时使用 noOp: true，维持当前场景和 Presence Engine。
 * - 至少包含一个行动或显式 noOp，不允许空帧。
 * - 行动数组必须非空；noOp 与任何实际行动互斥。
 *
 * 上述约束全部用「严格变体 union」表达（非 noOp 变体声明全部行动字段、
 * 各自要求一个非空行动；noOp 变体只声明 schemaVersion/sync/noOp），
 * 使 Zod 与生成的 JSON Schema（anyOf + additionalProperties:false +
 * minItems:1）在任意输入上判定一致，不依赖无法映射的跨字段 refine。
 */
const actionFrameBaseShape = {
  schemaVersion: z.literal(1),
  sync: SyncPolicySchema,
} as const;

const optionalAvatar = z.array(AvatarIntentSchema).min(1).max(32).optional();
const optionalGame = z.array(GameIntentSchema).min(1).max(32).optional();
const optionalOverlay = z.array(OverlayIntentSchema).min(1).max(32).optional();

export const ActionFrameSchema = z.union([
  z.strictObject({
    ...actionFrameBaseShape,
    speech: SpeechIntentSchema,
    avatar: optionalAvatar,
    game: optionalGame,
    overlay: optionalOverlay,
  }),
  z.strictObject({
    ...actionFrameBaseShape,
    speech: SpeechIntentSchema.optional(),
    avatar: z.array(AvatarIntentSchema).min(1).max(32),
    game: optionalGame,
    overlay: optionalOverlay,
  }),
  z.strictObject({
    ...actionFrameBaseShape,
    speech: SpeechIntentSchema.optional(),
    avatar: optionalAvatar,
    game: z.array(GameIntentSchema).min(1).max(32),
    overlay: optionalOverlay,
  }),
  z.strictObject({
    ...actionFrameBaseShape,
    speech: SpeechIntentSchema.optional(),
    avatar: optionalAvatar,
    game: optionalGame,
    overlay: z.array(OverlayIntentSchema).min(1).max(32),
  }),
  z.strictObject({
    ...actionFrameBaseShape,
    noOp: z.literal(true),
  }),
]);

export type ActionFrame = z.infer<typeof ActionFrameSchema>;
