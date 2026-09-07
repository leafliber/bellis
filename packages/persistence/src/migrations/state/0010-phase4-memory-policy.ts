import type { MigrationDefinition } from "../definition.js";

export const statePhase4MemoryPolicy: MigrationDefinition = {
  version: 10,
  name: "phase4-memory-policy",
  sql: `
CREATE TABLE phase4_memory_policy (
  scope_key TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  privacy_revision TEXT NOT NULL,
  blocked INTEGER NOT NULL CHECK(blocked IN (0, 1))
) STRICT;
CREATE TABLE phase4_memory_tombstones (
  scope_key TEXT NOT NULL REFERENCES phase4_memory_policy(scope_key),
  provider_id TEXT NOT NULL,
  resource_ref TEXT NOT NULL,
  through_revision TEXT,
  PRIMARY KEY(scope_key, provider_id, resource_ref)
) STRICT;
CREATE TABLE phase4_memory_policy_changes (
  change_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL REFERENCES phase4_memory_policy(scope_key),
  change_digest TEXT NOT NULL,
  generation INTEGER NOT NULL,
  reason TEXT NOT NULL,
  changed_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE phase4_memory_suppressed (
  outbox_id TEXT PRIMARY KEY REFERENCES outbox(outbox_id),
  scope_key TEXT NOT NULL,
  generation INTEGER NOT NULL,
  was_in_flight INTEGER NOT NULL,
  suppressed_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE phase4_memory_session_scopes (
  session_id TEXT PRIMARY KEY REFERENCES sessions(session_id),
  scope_key TEXT NOT NULL REFERENCES phase4_memory_policy(scope_key)
) STRICT;
`,
};
