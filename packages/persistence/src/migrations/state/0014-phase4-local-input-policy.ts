import type { MigrationDefinition } from "../definition.js";

export const statePhase4LocalInputPolicy: MigrationDefinition = {
  version: 14,
  name: "phase4-local-input-policy",
  sql: `
CREATE TABLE phase4_signal_policy (
  session_id TEXT NOT NULL,
  sequence TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 0),
  PRIMARY KEY(session_id, sequence),
  FOREIGN KEY(session_id, sequence) REFERENCES phase3_signals(session_id, sequence),
  FOREIGN KEY(scope_key) REFERENCES phase4_memory_policy(scope_key)
) STRICT;
`,
};
