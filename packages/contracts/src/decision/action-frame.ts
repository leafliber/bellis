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
 */
export const ActionFrameSchema = z
  .object({
    schemaVersion: z.literal(1),
    speech: SpeechIntentSchema.optional(),
    avatar: z.array(AvatarIntentSchema).max(32).optional(),
    game: z.array(GameIntentSchema).max(32).optional(),
    overlay: z.array(OverlayIntentSchema).max(32).optional(),
    sync: SyncPolicySchema,
    noOp: z.literal(true).optional(),
  })
  .refine(
    (frame) =>
      frame.speech !== undefined ||
      frame.avatar !== undefined ||
      frame.game !== undefined ||
      frame.overlay !== undefined ||
      frame.noOp === true,
    { message: "action frame must contain at least one action or an explicit noOp" },
  );

export type ActionFrame = z.infer<typeof ActionFrameSchema>;
