import type { MigrationDefinition } from "../definition.js";

export const statePhase4Context: MigrationDefinition = {
  version: 6,
  name: "phase4-context",
  sql: `
CREATE TABLE phase4_context_manifests (
  manifest_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  cycle_id TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  adopted_at_ms INTEGER NOT NULL,
  UNIQUE (session_id, cycle_id)
);
`,
};
