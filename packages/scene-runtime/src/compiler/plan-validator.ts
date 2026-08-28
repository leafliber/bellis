import { ScenePlanSchema, type ScenePlan } from "@bellis/contracts";
import { isKnownAnchor } from "./anchors.js";
import type { CompileIssue } from "./issues.js";

/**
 * ScenePlan 结构不变量校验（纯函数）。
 *
 * Schema 承载可映射到 JSON Schema 的结构约束；以下不变量属于编译器
 * 生产者契约（cueId 唯一、组内 lane 唯一、anchor 闭合、无孤立 Lane），
 * 由本函数显式校验——编译器对自己的输出运行它（§6.1「编译结果再次
 * 通过 ScenePlanSchema，不依赖 TypeScript 静态类型代替运行期校验」），
 * Director/应用层也可对反序列化的 Plan 复核。
 */
export function validateScenePlan(plan: unknown):
  | { ok: true; plan: ScenePlan }
  | {
      ok: false;
      issues: CompileIssue[];
    } {
  const schemaCheck = ScenePlanSchema.safeParse(plan);
  if (!schemaCheck.success) {
    return {
      ok: false,
      issues: [{ code: "plan_invalid", message: "scene plan does not pass ScenePlanSchema" }],
    };
  }
  const parsed = schemaCheck.data;
  const issues: CompileIssue[] = [];

  const cueIds = new Set<string>();
  for (const cue of parsed.cues) {
    if (cueIds.has(cue.cueId)) {
      issues.push({
        code: "plan_invalid",
        message: `duplicate cueId ${cue.cueId}`,
        lane: cue.lane,
      });
    }
    cueIds.add(cue.cueId);
    if (!isKnownAnchor(cue.anchor)) {
      issues.push({
        code: "anchor_unresolved",
        message: `cue ${cue.cueId} has non-closed anchor ${cue.anchor}`,
        lane: cue.lane,
      });
    }
  }

  const groupedLanes = new Set<string>();
  for (const group of parsed.scene.groups) {
    const lanes = new Set<string>();
    for (const lane of group.lanes) {
      if (lanes.has(lane)) {
        issues.push({
          code: "lane_conflict",
          message: `group ${group.groupId} repeats lane ${lane}`,
          lane,
        });
      }
      lanes.add(lane);
      groupedLanes.add(lane);
    }
  }
  for (const cue of parsed.cues) {
    if (!groupedLanes.has(cue.lane)) {
      issues.push({
        code: "plan_invalid",
        message: `cue ${cue.cueId} lane ${cue.lane} belongs to no sync group`,
        lane: cue.lane,
      });
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, plan: parsed };
}
