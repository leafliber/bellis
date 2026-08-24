import type { MigrationDefinition } from "../definition.js";

/**
 * telemetry.db 0001：最小底座（docs/protocols/persistence-and-recovery.md，原任务要求“只建立最小 Migration/索引底座”）。
 * schema_migrations 由 Runner bootstrap 独占创建。遥测写入不参与
 * state.db 事务，也不影响 Ready 判定的核心恢复事实。
 */

export const telemetryInitial: MigrationDefinition = {
  version: 1,
  name: "initial",
  sql: `
CREATE TABLE telemetry_events (
  event_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  payload_json TEXT NOT NULL
) STRICT;
CREATE INDEX idx_telemetry_events_kind ON telemetry_events(kind, occurred_at_ms);
`,
};
