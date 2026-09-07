import { statePhase4HistoryVerification } from "./state/0020-phase4-history-verification.js";
import { statePhase4HistoryInventory } from "./state/0018-phase4-history-inventory.js";
import { statePhase4RecallRequests } from "./state/0019-phase4-recall-requests.js";
import { statePhase4HistoryGaps } from "./state/0017-phase4-history-gaps.js";
import { statePhase4CompletionReservations } from "./state/0016-phase4-completion-reservations.js";
import { statePhase4ResourceInvalidations } from "./state/0015-phase4-resource-invalidations.js";
import { statePhase4LocalInputPolicy } from "./state/0014-phase4-local-input-policy.js";
import { statePhase4Forget } from "./state/0013-phase4-forget.js";
import { stateInitial } from "./state/0001-initial.js";
import { statePhase2ScenePlan } from "./state/0002-phase2-scene-plan.js";
import { statePhase2ActiveScenes } from "./state/0003-phase2-active-scenes.js";
import { statePhase3Decision } from "./state/0004-phase3-decision.js";
import { statePhase3SignalOrder } from "./state/0005-phase3-signal-order.js";
import { statePhase4Context } from "./state/0006-phase4-context.js";
import { statePhase4Effects } from "./state/0008-phase4-effects.js";
import { statePhase4Observe } from "./state/0007-phase4-observe.js";
import { statePhase4ProviderState } from "./state/0009-phase4-provider-state.js";
import { statePhase4MemoryPolicy } from "./state/0010-phase4-memory-policy.js";
import { statePhase4ToolCalls } from "./state/0011-phase4-tool-calls.js";
import { statePhase4PreparedTools } from "./state/0012-phase4-prepared-tools.js";
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
  statePhase3SignalOrder,
  statePhase4Context,
  statePhase4Observe,
  statePhase4Effects,
  statePhase4ProviderState,
  statePhase4MemoryPolicy,
  statePhase4ToolCalls,
  statePhase4PreparedTools,
  statePhase4Forget,
  statePhase4LocalInputPolicy,
  statePhase4ResourceInvalidations,
  statePhase4CompletionReservations,
  statePhase4HistoryGaps,
  statePhase4HistoryInventory,
  statePhase4RecallRequests,
  statePhase4HistoryVerification,
];
export const TELEMETRY_MIGRATIONS: readonly MigrationDefinition[] = [telemetryInitial];

export function prepareRegistry(
  migrations: readonly MigrationDefinition[],
): readonly MigrationDefinition[] {
  validateMigrationRegistry(migrations);
  return migrations;
}
