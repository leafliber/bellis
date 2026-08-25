import { z } from "zod";
import { UuidSchema } from "../common/ids.js";
import { extensibleJsonObject } from "../common/json-value.js";

/**
 * Phase 2 审计 Record 的版本化 Payload（SessionRecordSchema 的闭合约定：
 * payload 写入前必须通过对应 recordType 的版本化 Schema）。
 *
 * - payloadVersion：本文件全部形态共用字面量版本（升级 = 新版本共存，
 *   读取端未知版本必须返回明确兼容性错误，不静默猜测）；
 * - 不携带发言全文/PCM 等敏感或大体积内容（审计事实的最小充分集）；
 * - scene_lifecycle 的 from/to 为 Director 内部状态机转换（生命周期
 *   Record 的确定性证据，跨进程快照对账据此推导终态）。
 */
export const PHASE_2_AUDIT_PAYLOAD_VERSION = 1;

const payloadVersion = z.literal(PHASE_2_AUDIT_PAYLOAD_VERSION);

/** recordType=phase2_signal_accepted。 */
export const Phase2SignalAcceptedPayloadSchema = extensibleJsonObject({
  payloadVersion,
  signalId: UuidSchema,
  kind: z.string().min(1).max(64),
  source: z.string().min(1).max(64),
  cycleId: UuidSchema,
});

/** recordType=phase2_decision_packet。 */
export const Phase2DecisionPacketPayloadSchema = extensibleJsonObject({
  payloadVersion,
  cycleId: UuidSchema,
  accepted: z.boolean(),
});

/** recordType=phase2_scene_plan_compiled。 */
export const Phase2ScenePlanCompiledPayloadSchema = extensibleJsonObject({
  payloadVersion,
  sceneId: UuidSchema,
  cycleId: UuidSchema,
  cueCount: z.number().int().nonnegative(),
  lanes: z.array(z.string().min(1).max(64)),
});

/** recordType=scene_lifecycle（Director 状态机转换证据）。 */
export const SceneLifecyclePayloadSchema = extensibleJsonObject({
  payloadVersion,
  sceneId: UuidSchema,
  cycleId: UuidSchema,
  from: z.string().min(1).max(32),
  to: z.string().min(1).max(32),
  reason: z.string().max(256).optional(),
});

export type Phase2SignalAcceptedPayload = z.infer<typeof Phase2SignalAcceptedPayloadSchema>;
export type Phase2DecisionPacketPayload = z.infer<typeof Phase2DecisionPacketPayloadSchema>;
export type Phase2ScenePlanCompiledPayload = z.infer<typeof Phase2ScenePlanCompiledPayloadSchema>;
export type SceneLifecyclePayload = z.infer<typeof SceneLifecyclePayloadSchema>;
