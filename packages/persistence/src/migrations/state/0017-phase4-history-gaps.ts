import type { MigrationDefinition } from "../definition.js";

export const statePhase4HistoryGaps: MigrationDefinition = {
  version: 17,
  name: "phase4-history-gaps",
  sql: `CREATE TABLE phase4_history_gaps (
    scope_key TEXT NOT NULL REFERENCES phase4_memory_policy(scope_key),
    provider_id TEXT NOT NULL,
    gap_id TEXT NOT NULL,
    gap_digest TEXT NOT NULL,
    gap_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY(scope_key, provider_id)
  ) STRICT;`,
};
