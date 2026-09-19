import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ObjectStatePayload,
  P0ObservationStreamEnd,
  P0ProcessObservation,
  P0ProtocolObservation,
  P0ReductionObservation,
} from "../contracts/generated/validators.mjs";

const digest = "a".repeat(64);
const point = { clock_domain: "source-clock", monotonic_ms: 10 };
const safeError = { kind: "internal", code: "unexpected_error" };
const processRecord = (detail: object) => ({
  record_type: "p0-process-observation",
  source_role: "supervisor",
  source_instance_id: "supervisor-instance",
  source_pid: 200,
  source_seq: 0,
  dropped_observations: 0,
  observed_at: point,
  detail,
});
const child = {
  launch_id: "launch",
  child_role: "host",
  expected_instance_id: "host-instance",
};

test("p0.observation.schema: launch identity, actual command digest and startup stage are explicit", () => {
  const attempt = { kind: "spawn_attempt", ...child, actual_pid: null, command_digest: digest };
  assert.equal(P0ProcessObservation(processRecord(attempt)), true);
  for (const command_digest of [undefined, "not-a-digest"])
    assert.equal(P0ProcessObservation(processRecord({ ...attempt, command_digest })), false);
  for (const kind of ["spawn_attempt", "spawned", "spawn_error", "exited"]) {
    const detail = {
      kind,
      ...child,
      actual_pid: kind === "spawn_attempt" ? null : 201,
      ...(kind === "spawn_attempt" ? { command_digest: digest } : {}),
      ...(kind === "spawn_error" ? { error: safeError } : {}),
      ...(kind === "exited" ? { exit_code: 0, signal: null } : {}),
    };
    assert.equal(P0ProcessObservation(processRecord(detail)), true, kind);
    for (const child_role of ["host", "endpoint"])
      assert.equal(
        P0ProcessObservation(processRecord({ ...detail, child_role, expected_instance_id: null })),
        false,
        `${kind}/${child_role}`,
      );
    for (const child_role of ["supervisor", "operator"])
      assert.equal(
        P0ProcessObservation(processRecord({ ...detail, child_role, expected_instance_id: null })),
        true,
        `${kind}/${child_role}`,
      );
  }
  for (const stage of [
    "runtime",
    "arguments",
    "configuration",
    "installation",
    "bootstrap",
    "listen",
    "launch",
    "connect",
  ]) {
    const record = processRecord({ kind: "startup_rejected", stage, error: safeError });
    assert.equal(P0ProcessObservation(record), true);
    assert.equal(P0ProcessObservation({ ...record, source_instance_id: null }), true);
    assert.equal(
      P0ProcessObservation({ ...record, source_instance_id: null, source_seq: 1 }),
      false,
    );
  }
  assert.equal(
    P0ProcessObservation(processRecord({ kind: "startup_rejected", error: safeError })),
    false,
  );
  assert.equal(
    P0ProcessObservation(
      processRecord({ kind: "startup_rejected", stage: "arbitrary-text", error: safeError }),
    ),
    false,
  );
  assert.equal(
    P0ProcessObservation({ ...processRecord(attempt), source_instance_id: null }),
    false,
  );
  assert.equal(
    P0ProcessObservation(
      processRecord({
        kind: "startup_rejected",
        stage: "listen",
        error: { ...safeError, message: "secret" },
      }),
    ),
    false,
  );
});

test("p0.observation.schema: exits preserve either the actual code or signal, not an invented successful exit", () => {
  const exited = { kind: "exited", ...child, actual_pid: 201, exit_code: 0, signal: null };
  assert.equal(P0ProcessObservation(processRecord(exited)), true);
  assert.equal(
    P0ProcessObservation(processRecord({ ...exited, exit_code: null, signal: "SIGKILL" })),
    true,
  );
  for (const changes of [
    { exit_code: null, signal: null },
    { exit_code: 0, signal: "SIGTERM" },
    { actual_pid: null },
    { actual_pid: 0 },
    { exit_code: null, signal: "successful-kill" },
  ])
    assert.equal(P0ProcessObservation(processRecord({ ...exited, ...changes })), false);
});

const payload = {
  object_ref: { kind: "ExecutionGrant", id: "grant" },
  source_revision: 1,
  state: "DENIED",
  outcome: null,
  reason_code: "PERSISTENCE_NOT_READY",
  evidence_refs: [],
  settlement_ref: null,
};
const envelope = {
  schema_version: "0.8.0",
  event_name: "grant.denied",
  event_id: "event",
  authority_id: "supervisor",
  source_instance: "supervisor-instance",
  authority_epoch: 1,
  source_seq: 2,
  session_id: "session",
  scope_ref: { kind: "Session", id: "session" },
  correlation: { key: "operation", value: "operation" },
  occurred_at: point,
  trace_id: "trace",
  payload,
};
const protocolRecord = (detail: object) => ({
  record_type: "p0-protocol-observation",
  source_role: "host",
  source_instance_id: "host-instance",
  source_pid: 201,
  source_seq: 2,
  dropped_observations: 0,
  observed_at: point,
  connection_id: "connection",
  detail,
});
const failure = {
  kind: "local_failure",
  stage: "parse",
  request_id: null,
  operation_id: null,
  request_digest: null,
  error: safeError,
  frame_sha256: null,
  frame_bytes: null,
};

test("p0.observation.schema: unbound failures preserve only safe classification and complete-frame hash/length pairs", () => {
  assert.equal(P0ProtocolObservation(protocolRecord(failure)), true);
  assert.equal(P0ProtocolObservation({ ...protocolRecord(failure), connection_id: null }), true);
  assert.equal(
    P0ProtocolObservation(protocolRecord({ ...failure, frame_sha256: digest, frame_bytes: 12 })),
    true,
  );
  for (const changes of [
    { frame_sha256: digest, frame_bytes: null },
    { frame_sha256: null, frame_bytes: 12 },
    { frame_sha256: digest, frame_bytes: 16777217 },
    { frame_sha256: "bad", frame_bytes: 12 },
    { raw_payload: "unbounded-private-content" },
    { stage: "made-up-stage" },
    {
      error: {
        kind: "node",
        name: "Error",
        code: "EPIPE",
        errno: -32,
        syscall: "write",
        stack: "secret",
      },
    },
  ])
    assert.equal(P0ProtocolObservation(protocolRecord({ ...failure, ...changes })), false);
  assert.equal(
    P0ProtocolObservation({ ...protocolRecord(failure), source_instance_id: null }),
    false,
  );
});

test("p0.observation.schema: full original events are retained and announcement reception has one category", () => {
  const event = { jsonrpc: "2.0", method: "event.publish", params: envelope };
  for (const kind of ["event_queued", "event_received"]) {
    const record = protocolRecord({ kind, event });
    assert.equal(P0ProtocolObservation(record), true);
    assert.equal(P0ProtocolObservation({ ...record, connection_id: null }), false);
    assert.equal(
      P0ProtocolObservation(
        protocolRecord({
          kind,
          event: { ...event, params: { ...envelope, payload: { arbitrary: true } } },
        }),
      ),
      false,
    );
  }
  const announcement = {
    ...envelope,
    event_name: "connection.announced",
    payload: {
      connection_id: "connection",
      service_role: "supervisor",
      service_instance_id: "supervisor-instance",
      session_id: "session",
      protocol_version: "0.8.0",
      schema_digest: digest,
      clock_domain: "service-clock",
      received_at_ms: 1,
      sent_at_ms: 2,
      expires_at_ms: 100,
      challenge_id: "challenge",
      identity_key_id: "key",
      signature: "synthetic-signature",
      authority_id: "supervisor",
      authority_instance_id: "supervisor-instance",
      authority_epoch: 1,
    },
  };
  const identity = {
    role: "supervisor",
    instance_id: "supervisor-instance",
    identity_key_id: "key",
    public_key_spki: "synthetic-key",
  };
  assert.equal(
    P0ProtocolObservation(
      protocolRecord({
        kind: "announcement_received",
        announcement,
        fixed_peer: identity,
        fixed_authority: identity,
      }),
    ),
    true,
  );
  const announcedEvent = { ...event, params: announcement };
  assert.equal(
    P0ProtocolObservation(protocolRecord({ kind: "event_queued", event: announcedEvent })),
    true,
  );
  assert.equal(
    P0ProtocolObservation(protocolRecord({ kind: "event_received", event: announcedEvent })),
    false,
  );
});

test("p0.observation.schema: final counters and command/process trigger identities reject ambiguous shapes", () => {
  const end = {
    record_type: "p0-observation-stream-end",
    stream: "process",
    source_role: "supervisor",
    source_instance_id: "instance",
    source_pid: 200,
    next_seq: 1,
    dropped_observations: 0,
    observed_at: point,
  };
  assert.equal(P0ObservationStreamEnd(end), true);
  assert.equal(P0ObservationStreamEnd({ ...end, source_instance_id: null }), true);
  assert.equal(
    P0ObservationStreamEnd({ ...end, source_instance_id: null, stream: "protocol" }),
    false,
  );
  assert.equal(P0ObservationStreamEnd({ ...end, source_instance_id: null, next_seq: 0 }), false);
  assert.equal(P0ObservationStreamEnd({ ...end, dropped_observations: undefined }), false);
  assert.equal(P0ObservationStreamEnd({ ...end, next_seq: -1 }), false);
  const reduction = {
    record_type: "p0-reduction-observation",
    source_instance_id: "supervisor-instance",
    source_seq: 1,
    dropped_observations: 0,
    object_ref: { kind: "SupervisionMode", id: "session" },
    machine: "SupervisionMode",
    from: "stopped",
    event: "approve_supervised",
    to: "supervised",
    guard: null,
    guard_result: null,
    disposition: "guard_rejected",
    trigger_kind: "command",
    trigger_id: digest,
    trigger_digest: digest,
    observed_at: point,
    timer_deadline: null,
  };
  // Rejection retains its actual source state; semantic trace checks remain the runner's job.
  reduction.to = "stopped";
  for (const trigger_kind of ["command", "process_fact", "protocol_fact"]) {
    assert.equal(P0ReductionObservation({ ...reduction, trigger_kind }), true);
    assert.equal(
      P0ReductionObservation({ ...reduction, trigger_kind, trigger_id: "rpc-id" }),
      false,
    );
  }
  assert.equal(P0ReductionObservation({ ...reduction, dropped_observations: undefined }), false);
  assert.equal(
    P0ReductionObservation({
      ...reduction,
      trigger_kind: "timer",
      trigger_id: "timer",
      timer_deadline: null,
    }),
    false,
  );
  assert.equal(
    P0ReductionObservation({
      ...reduction,
      trigger_kind: "timer",
      trigger_id: "timer",
      timer_deadline: point,
    }),
    true,
  );
});

test("p0.observation.schema: ObjectStatePayload reasons use the registered vocabulary", () => {
  for (const reason_code of ["PERSISTENCE_NOT_READY", "P0_MODE_DENIED", null])
    assert.equal(ObjectStatePayload({ ...payload, reason_code }), true);
  assert.equal(ObjectStatePayload({ ...payload, reason_code: "UNREGISTERED_REASON" }), false);
});
