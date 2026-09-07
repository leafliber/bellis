import type { MigrationDefinition } from "../definition.js";

export const statePhase4Effects: MigrationDefinition = {
  version: 8,
  name: "phase4-effects",
  sql: `
CREATE TABLE phase4_effect_preparations (
  scene_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  cycle_id TEXT NOT NULL,
  connection_generation TEXT NOT NULL,
  preparation_json TEXT NOT NULL,
  preparation_digest TEXT NOT NULL,
  reserved_events INTEGER NOT NULL CHECK (reserved_events >= 0),
  reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes >= 0),
  closed INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE phase4_effect_bindings (
  scene_id TEXT NOT NULL REFERENCES phase4_effect_preparations(scene_id),
  segment_id TEXT NOT NULL,
  binding_json TEXT NOT NULL,
  binding_digest TEXT NOT NULL,
  PRIMARY KEY(scene_id, segment_id)
);
CREATE TABLE phase4_effect_receipts (
  receipt_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  scene_id TEXT NOT NULL REFERENCES phase4_effect_preparations(scene_id),
  segment_id TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  receipt_digest TEXT NOT NULL,
  confirmed_text TEXT NOT NULL,
  confirmed_at_ms INTEGER NOT NULL,
  UNIQUE(scene_id, segment_id)
);
CREATE INDEX phase4_effect_conversation ON phase4_effect_receipts(session_id, confirmed_at_ms);
`,
};
