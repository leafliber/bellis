import type { MigrationDefinition } from "../definition.js";
export const statePhase4ResourceInvalidations: MigrationDefinition = {
  version: 15,
  name: "phase4-resource-invalidations",
  sql: `
CREATE TABLE phase4_resource_invalidations (
 scope_key TEXT NOT NULL, provider_id TEXT NOT NULL, event_id TEXT NOT NULL,
 event_digest TEXT NOT NULL, cursor TEXT NOT NULL,
 PRIMARY KEY(scope_key, provider_id, event_id),
 FOREIGN KEY(scope_key) REFERENCES phase4_memory_policy(scope_key)
) STRICT;
`,
};
