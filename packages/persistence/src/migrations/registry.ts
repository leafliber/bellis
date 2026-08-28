import { stateInitial } from "./state/0001-initial.js";
import { statePhase2ScenePlan } from "./state/0002-phase2-scene-plan.js";
import { statePhase2ActiveScenes } from "./state/0003-phase2-active-scenes.js";
import { statePhase3Decision } from "./state/0004-phase3-decision.js";
import { telemetryInitial } from "./telemetry/0001-initial.js";
import { validateMigrationRegistry } from "./definition.js";
import type { MigrationDefinition } from "./definition.js";

/**
 * 内置 Migration 注册表（有序、只前进）。
 * 生产使用内置表；测试/嵌入装配可通过 PersistenceClientOptions.migrations
 * 注入覆盖（例如注入故意失败的 Migration 验证回滚）。
 * 已合入 Migration 不允许原地改写：checksum 会失配并拒绝启动。
 */

export const STATE_MIGRATIONS: readonly MigrationDefinition[] = [
  stateInitial,
  statePhase2ScenePlan,
  statePhase2ActiveScenes,
  statePhase3Decision,
];
export const TELEMETRY_MIGRATIONS: readonly MigrationDefinition[] = [telemetryInitial];

export function prepareRegistry(
  migrations: readonly MigrationDefinition[],
): readonly MigrationDefinition[] {
  validateMigrationRegistry(migrations);
  return migrations;
}
