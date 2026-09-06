import type { MigrationDefinition } from "../definition.js";

/** Forward-only correction: preserve historical rows and IDs, scope dedupe by source. */
export const statePhase3SignalOrder: MigrationDefinition = {
  version: 5,
  name: "phase3-signal-order",
  sql: `
DROP INDEX idx_phase3_signals_dedupe;
CREATE UNIQUE INDEX idx_phase3_signals_dedupe
  ON phase3_signals (session_id, json_extract(signal_json, '$.source'), signal_id);
CREATE INDEX idx_phase3_signals_numeric_order
  ON phase3_signals (session_id, length(sequence), sequence);
`,
};
