import { z } from "zod";
import { DecimalStringSchema } from "../common/decimal-string.js";
import { extensibleJsonObject } from "../common/json-value.js";

/**
 * Stage 能力声明（Phase 2，docs/archive/phase-2/development-guide.md §5.2）。
 *
 * Stage 在握手后通过 `stage.capabilities` 上报本连接可执行的 Lane 与限制；
 * Runtime 的 Action Compiler 用该快照做编译期能力判定（不支持的能力返回
 * 稳定 Issue，是否降级由编译策略决定），Stage 不参与业务决策。
 *
 * - audio.contentTypes：本 Stage 可接受的音频 contentType 闭合列表
 *   （Phase 2 基线见 PHASE_2_PCM_CONTENT_TYPE）。
 * - audio.maxBufferedUs：Stage 愿意缓冲的未来音频时长上限（微秒，
 *   Wire 上为非负十进制字符串）。发送端的三重背压限制必须 ≤ 该值。
 * - subtitle.supported：字幕 Lane 是否可用。
 * - avatar：adapter 标识与已授权模型可用的语义 motion/expression 名称；
 *   编译器据此拒绝未声明的动作名，Stage 不做语义回退。
 */
export const StageCapabilitiesSchema = extensibleJsonObject({
  schemaVersion: z.literal(1),
  audio: extensibleJsonObject({
    contentTypes: z.array(z.string().min(1).max(128)).min(1).max(8),
    maxBufferedUs: DecimalStringSchema,
  }),
  subtitle: extensibleJsonObject({
    supported: z.boolean(),
  }),
  avatar: extensibleJsonObject({
    adapter: z.string().min(1).max(64),
    motions: z.array(z.string().min(1).max(128)).max(64),
    expressions: z.array(z.string().min(1).max(128)).max(64),
  }),
});

export type StageCapabilities = z.infer<typeof StageCapabilitiesSchema>;
