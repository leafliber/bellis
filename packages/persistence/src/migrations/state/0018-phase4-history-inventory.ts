import type { MigrationDefinition } from "../definition.js";
export const statePhase4HistoryInventory: MigrationDefinition = {
  version: 18,
  name: "phase4-history-inventory",
  sql: `CREATE TABLE phase4_history_inventories (
    run_id TEXT PRIMARY KEY,
    scope_key TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    inventory_json TEXT NOT NULL,
    UNIQUE(scope_key, provider_id),
    FOREIGN KEY(scope_key, provider_id) REFERENCES phase4_history_gaps(scope_key, provider_id)
  ) STRICT;
  CREATE TABLE phase4_history_inventory_items (
    run_id TEXT NOT NULL REFERENCES phase4_history_inventories(run_id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    item_digest TEXT NOT NULL,
    PRIMARY KEY(run_id, ordinal),
    UNIQUE(run_id, kind, item_id)
  ) STRICT;`,
};
