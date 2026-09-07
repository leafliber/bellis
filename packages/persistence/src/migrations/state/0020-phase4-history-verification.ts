import type { MigrationDefinition } from "../definition.js";

export const statePhase4HistoryVerification: MigrationDefinition = {
  version: 20,
  name: "phase4-history-verification",
  sql: `CREATE TABLE phase4_history_verification_batches (
    batch_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES phase4_history_inventories(run_id) ON DELETE CASCADE,
    batch_json TEXT NOT NULL CHECK(json_valid(batch_json)),
    batch_digest TEXT NOT NULL CHECK(length(batch_digest) = 64),
    CHECK(length(CAST(batch_json AS BLOB)) <= 16384),
    CHECK(json_extract(batch_json, '$.batchId') = batch_id),
    CHECK(json_extract(batch_json, '$.runId') = run_id),
    UNIQUE(run_id, batch_id)
  ) STRICT;
  CREATE TABLE phase4_history_verification_items (
    run_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    batch_id TEXT NOT NULL,
    PRIMARY KEY(run_id, ordinal),
    FOREIGN KEY(run_id, ordinal) REFERENCES phase4_history_inventory_items(run_id, ordinal) ON DELETE CASCADE,
    FOREIGN KEY(run_id, batch_id) REFERENCES phase4_history_verification_batches(run_id, batch_id) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX phase4_history_verification_batch_items
    ON phase4_history_verification_items(batch_id);`,
};
