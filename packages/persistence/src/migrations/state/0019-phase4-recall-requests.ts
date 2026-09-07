import type { MigrationDefinition } from "../definition.js";
export const statePhase4RecallRequests: MigrationDefinition = {
  version: 19,
  name: "phase4-recall-requests",
  sql: `CREATE TABLE phase4_recall_requests (
    attempt_id TEXT PRIMARY KEY,
    scope_key TEXT NOT NULL REFERENCES phase4_memory_policy(scope_key),
    provider_id TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES phase4_memory_session_scopes(session_id),
    request_json TEXT NOT NULL CHECK(json_valid(request_json)),
    request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
    request_bytes INTEGER NOT NULL CHECK(request_bytes>0 AND request_bytes<=65536),
    CHECK(json_extract(request_json, '$.request.attemptId')=attempt_id),
    CHECK(json_extract(request_json, '$.policy.scopeKey')=scope_key),
    CHECK(json_extract(request_json, '$.providerId')=provider_id),
    CHECK(json_extract(request_json, '$.sessionId')=session_id)
  ) STRICT;
  CREATE INDEX idx_phase4_recall_requests_scope ON phase4_recall_requests(scope_key, provider_id);`,
};
