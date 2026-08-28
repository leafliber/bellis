import type { MigrationDefinition } from "../definition.js";

/**
 * state.db 0002：Phase 2 ScenePlan 持久化（ADR 0003 §2 / scene-execution.md §9）。
 *
 * - scenes 新增可空列 plan_json：Phase 2 的 commitScene 事务写入完整
 *   可审计计划（写入前经 ScenePlanSchema 校验）；Phase 1 行保持 NULL。
 * - 只增列不改写 0001 语义：payload_json 继续承载 Phase 1 冻结的 Scene。
 */
export const statePhase2ScenePlan: MigrationDefinition = {
  version: 2,
  name: "phase2-scene-plan",
  sql: `
ALTER TABLE scenes ADD COLUMN plan_json TEXT;
`,
};
