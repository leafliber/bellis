import type { MigrationDefinition } from "../definition.js";

export const statePhase4ToolCalls: MigrationDefinition = {
  version: 11,
  name: "phase4-tool-calls",
  sql: `
CREATE TABLE phase4_tool_calls (
  session_id TEXT NOT NULL,
  tool_run_id TEXT NOT NULL,
  call_json TEXT NOT NULL,
  call_digest TEXT NOT NULL,
  call_bytes INTEGER NOT NULL,
  PRIMARY KEY(session_id, tool_run_id),
  FOREIGN KEY(session_id, tool_run_id) REFERENCES phase3_tool_runs(session_id, tool_run_id)
) STRICT;
`,
};
