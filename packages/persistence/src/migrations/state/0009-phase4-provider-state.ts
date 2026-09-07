import type { MigrationDefinition } from "../definition.js";

export const statePhase4ProviderState: MigrationDefinition = {
  version: 9,
  name: "phase4-provider-state",
  sql: `
CREATE TABLE phase4_provider_state (
  scope_key TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  state_json TEXT NOT NULL,
  state_digest TEXT NOT NULL,
  state_bytes INTEGER NOT NULL CHECK (state_bytes >= 0),
  PRIMARY KEY(scope_key, provider_id)
) STRICT;
`,
};
