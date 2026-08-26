import type { MigrationDefinition } from "../definition.js";

/**
 * state.db 0003：Phase 2 活动 Scene 索引（scene-execution.md §8）。
 *
 * - appendRecord 在 scene_lifecycle Record 落库的同事务内维护
 *   active_scenes：非终态转换 UPSERT、可证终态（completed/cancelled/
 *   failed）DELETE——「任一未证终态」由索引直接回答，不受记录窗口
 *   挤出影响（长期在途的旧 Scene 不会因新 Scene 流量被遗忘）。
 * - 只增表不改写既有语义；查询侧（list_active_scenes）专用。
 */
export const statePhase2ActiveScenes: MigrationDefinition = {
  version: 3,
  name: "phase2-active-scenes",
  sql: `
CREATE TABLE active_scenes (
  session_id TEXT NOT NULL,
  scene_id TEXT NOT NULL,
  cycle_id TEXT,
  state TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, scene_id)
);
`,
};
