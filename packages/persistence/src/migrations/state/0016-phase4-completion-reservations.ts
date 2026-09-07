import type { MigrationDefinition } from "../definition.js";
export const statePhase4CompletionReservations: MigrationDefinition = {
  version: 16,
  name: "phase4-completion-reservations",
  sql: `
CREATE TABLE phase4_completion_reservations (
 scene_id TEXT PRIMARY KEY REFERENCES phase4_effect_preparations(scene_id),
 bindings_remaining INTEGER NOT NULL CHECK(bindings_remaining BETWEEN 0 AND 32),
 confirmations_remaining INTEGER NOT NULL CHECK(confirmations_remaining BETWEEN 0 AND 32)
) STRICT;
`,
};
