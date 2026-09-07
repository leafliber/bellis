import type { MigrationDefinition } from "../definition.js";

export const statePhase4PreparedTools: MigrationDefinition = {
  version: 12,
  name: "phase4-prepared-tools",
  sql: `
CREATE TABLE phase4_prepared_tools (
  session_id TEXT NOT NULL,
  tool_run_id TEXT NOT NULL,
  prepared_json TEXT NOT NULL,
  prepared_digest TEXT NOT NULL,
  prepared_bytes INTEGER NOT NULL,
  PRIMARY KEY(session_id, tool_run_id),
  FOREIGN KEY(session_id, tool_run_id) REFERENCES phase4_tool_calls(session_id, tool_run_id)
) STRICT;
`,
};
