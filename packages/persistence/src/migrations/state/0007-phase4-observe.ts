import type { MigrationDefinition } from "../definition.js";

export const statePhase4Observe: MigrationDefinition = {
  version: 7,
  name: "phase4-observe",
  sql: `
CREATE TABLE phase4_observe_streams (
  provider_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  source_stream TEXT NOT NULL,
  allocated_cursor TEXT NOT NULL,
  PRIMARY KEY (provider_id, agent_id, source_stream)
);
CREATE TABLE phase4_observations (
  event_id TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL UNIQUE REFERENCES outbox(outbox_id),
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  provider_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  source_stream TEXT NOT NULL,
  source_cursor TEXT NOT NULL,
  fact_key TEXT NOT NULL,
  event_json TEXT NOT NULL,
  event_digest TEXT NOT NULL,
  ack_at_ms INTEGER,
  UNIQUE (session_id, provider_id, fact_key),
  UNIQUE (provider_id, agent_id, source_stream, source_cursor)
);
CREATE INDEX phase4_observe_pending ON phase4_observations(ack_at_ms);
CREATE INDEX outbox_observe_order ON outbox(topic, partition_key, status);
`,
};
