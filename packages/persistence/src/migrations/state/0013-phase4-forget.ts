import type { MigrationDefinition } from "../definition.js";

export const statePhase4Forget: MigrationDefinition = {
  version: 13,
  name: "phase4-forget",
  sql: `
CREATE TABLE phase4_memory_forget (
  session_id TEXT NOT NULL,
  tool_run_id TEXT NOT NULL,
  operation_json TEXT NOT NULL,
  operation_digest TEXT NOT NULL,
  PRIMARY KEY(session_id, tool_run_id),
  FOREIGN KEY(session_id, tool_run_id) REFERENCES phase4_prepared_tools(session_id, tool_run_id)
) STRICT;
`,
};
