import type { Cue, ScenePlan } from "@bellis/contracts";
import { parseAnchor, resolveAnchorBaseUs, type Anchor } from "../compiler/anchors.js";

/**
 * Cue 目标时刻解析（纯函数，Runtime 侧）。
 *
 * 输入是已提交 Scene 的 T0（Runtime 单调微秒）与可选的 speech 时长上下文
 * （Fake TTS 在 Prepare 阶段产出），输出每个 Cue 的目标时刻。相同输入
 * 得到相同输出；不读取时钟，不持有状态。
 *
 * speech_end / speech.word:<n> 在时长或词表缺失时返回 pending 条目，
 * 由调用方（P4 媒体调度）决定等待或放弃——Stage 侧对同一目标时刻的
 * 本地映射属于 apps/stage 的 Timeline（P2），不在本包。
 */

export interface CueTarget {
  readonly cueId: string;
  readonly lane: Cue["lane"];
  readonly anchor: string;
  /** 相对 T0 的偏移（含 cue.offsetMs），未知时为 null。 */
  readonly targetOffsetUs: bigint | null;
}

export interface SpeechTimingContext {
  readonly speechStartOffsetUs?: bigint;
  readonly speechDurationUs?: bigint;
  readonly wordStartOffsetUs?: readonly bigint[];
}

function anchorBase(anchorText: string, timing: SpeechTimingContext): bigint | null {
  const anchor: Anchor | null = parseAnchor(anchorText);
  if (anchor === null) {
    return null;
  }
  return resolveAnchorBaseUs(anchor, timing);
}

export function resolveCueTargets(
  plan: ScenePlan,
  timing: SpeechTimingContext = {},
): readonly CueTarget[] {
  return plan.cues.map((cue) => {
    const base = anchorBase(cue.anchor, timing);
    const offsetUs = BigInt(cue.offsetMs) * 1000n;
    return {
      cueId: cue.cueId,
      lane: cue.lane,
      anchor: cue.anchor,
      targetOffsetUs: base === null ? null : base + offsetUs,
    };
  });
}

/** 绝对目标时刻（T0 + offset）；offset 未知（null）的条目返回 null。 */
export function absoluteTargetUs(target: CueTarget, t0Us: bigint): bigint | null {
  return target.targetOffsetUs === null ? null : t0Us + target.targetOffsetUs;
}
