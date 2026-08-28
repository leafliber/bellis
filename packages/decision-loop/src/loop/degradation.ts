import type { DecisionPacket } from "@bellis/contracts";

/**
 * 确定性降级（phase-3-development-guide.md §7.4）：
 * 模型超时、断流、非法包或内容策略拒绝时不进行格式修复请求——
 * Loop 通过本地策略产生唯一合法安全包：
 * - 默认 noOp；策略允许时使用预注册轻量话术（不含未经模型确认的事实）；
 * - next=finish（Phase 3 无自动多 Provider 路由）；
 * - 降级包与原 Provider 错误记录在同一 Cycle Trace，且只采用一次。
 */
export type DegradationReason =
  | "timeout"
  | "stream_broken"
  | "invalid_packet"
  | "content_policy"
  | "aborted";

export interface DegradationPolicy {
  /** 预注册轻量话术（空字符串 → noOp）。 */
  readonly apologyText: string;
  readonly apologyEmotion?: string;
}

export const DEFAULT_DEGRADATION_POLICY: DegradationPolicy = {
  apologyText: "",
};

export function buildSafetyPacket(
  cycleId: string,
  reason: DegradationReason,
  policy: DegradationPolicy = DEFAULT_DEGRADATION_POLICY,
): DecisionPacket {
  const hasSpeech = policy.apologyText.length > 0;
  return {
    schemaVersion: 1,
    cycleId,
    toolCalls: [],
    action: hasSpeech
      ? {
          schemaVersion: 1,
          speech: {
            schemaVersion: 1,
            text: policy.apologyText,
            purpose: "aside",
            interruptible: true,
            ...(policy.apologyEmotion === undefined ? {} : { emotion: policy.apologyEmotion }),
          },
          sync: { schemaVersion: 1, hardLanes: [], softTimeoutMs: 0 },
        }
      : {
          schemaVersion: 1,
          sync: { schemaVersion: 1, hardLanes: [], softTimeoutMs: 0 },
          noOp: true,
        },
    next: "finish",
  };
}
