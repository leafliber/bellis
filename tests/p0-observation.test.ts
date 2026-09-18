import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import {
  assertValid,
  type P0EndpointProjection,
  payloadDigest,
  type RpcRequest,
  SchemaValidationError,
} from "../packages/contract-sdk/src/index.ts";
import { RpcConnection } from "../packages/runtime/src/client.ts";
import { clockMapping, MonotonicClock } from "../packages/runtime/src/clock.ts";
import { businessFailure, RuntimeRejection } from "../packages/runtime/src/errors.ts";
import { readServiceIdentity } from "../packages/runtime/src/files.ts";
import {
  announce,
  announcementEvent,
  completeRequest,
  generateIdentity,
  operatorRequest,
} from "../packages/runtime/src/identity.ts";
import {
  ObservationWriter,
  observationError,
  observationTrigger,
  observedRequest,
  ProtocolObservation,
} from "../packages/runtime/src/observation.ts";
import { observedSpawn } from "../packages/runtime/src/process-observation.ts";
import { safeChildEnvironment } from "../packages/runtime/src/processes.ts";
import { P0Service } from "../packages/runtime/src/service.ts";
import { JsonChannel } from "../packages/runtime/src/transport.ts";
import { createProductionFixture } from "./p0-endpoint.helpers.ts";
import { limits, repository, stopProcess, waitFor } from "./p0-identity.helpers.ts";
import {
  capture,
  completeStreams,
  processRecords,
  protocolRecords,
  records,
} from "./p0-observation.helpers.ts";

class Sink extends EventEmitter {
  readonly chunks: Buffer[] = [];
  readonly callbacks: Array<(error?: Error | null) => void> = [];
  held = false;
  write(bytes: Buffer, callback: (error?: Error | null) => void): boolean {
    this.chunks.push(bytes);
    if (this.held) this.callbacks.push(callback);
    else callback();
    return !this.held;
  }
  release() {
    for (const callback of this.callbacks.splice(0)) callback();
  }
  text() {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}
const failure = {
  kind: "startup_rejected",
  stage: "configuration",
  error: { kind: "internal", code: "unexpected_error" },
} as const;
function writer(sink: Sink, maxPending = 16, maxBytes = 65536) {
  return new ObservationWriter(
    "host",
    "observed-host",
    new MonotonicClock(),
    { max_pending_requests: maxPending, max_message_bytes: maxBytes },
    sink,
  );
}
function requestFixture(): RpcRequest {
  const clock = new MonotonicClock(),
    sup = generateIdentity("supervisor");
  const a = announce(
    sup,
    "controlled-session",
    new MonotonicClock(),
    limits.clock_mapping_ttl_ms,
    sup.public,
    0,
  );
  const input = { mapping: clockMapping(a, clock, "client", clock.now(), clock.now(), limits) };
  return operatorRequest(
    "operator.authenticate",
    input,
    {
      caller_instance_id: "client",
      authority_epoch: 0,
      grant_ref: null,
      deadline: {
        clock_domain: a.clock_domain,
        issued_at_ms: a.sent_at_ms,
        expires_at_ms: a.sent_at_ms + 1000,
      },
      object_ref: { kind: "Session", id: a.session_id },
      operation_id: randomUUID(),
      payload_digest: "0".repeat(64),
    },
    a,
    {
      credential_id: "controlled-credential",
      operator_id: "controlled-operator",
      role: "test_operator",
      authentication_key_sha256: "a".repeat(64),
    },
  );
}

test("p0.observation: bounded sink distinguishes backpressure, actual drops, errors and incomplete drain", async () => {
  const sink = new Sink();
  sink.held = true;
  const out = writer(sink, 2);
  out.process(failure);
  out.process(failure);
  out.process(failure);
  assert.equal(
    sink.chunks.length,
    2,
    "write(false) was accepted, only the third attempt is dropped",
  );
  sink.held = false;
  sink.release();
  await out.finish();
  await out.finish();
  const data = records(sink.text());
  assert.deepEqual(
    data.map((r) => r.dropped_observations),
    [0, 0, 1],
  );
  const tail = data.at(-1);
  assert.ok(tail && "next_seq" in tail);
  assert.equal(tail.next_seq, 3);
  const broken = new Sink();
  broken.held = true;
  const failed = writer(broken);
  failed.process(failure);
  assert.doesNotThrow(() =>
    broken.emit("error", Object.assign(new Error("secret path"), { code: "EPIPE" })),
  );
  broken.emit("close");
  broken.release();
  await failed.finish();
  assert.equal(records(broken.text()).length, 1, "sink failure cannot manufacture a tail");
  const slow = new Sink();
  slow.held = true;
  const incomplete = writer(slow);
  incomplete.process(failure);
  await incomplete.finish(2);
  slow.release();
  assert.equal(records(slow.text()).length, 1, "expired drain cannot append a late complete tail");
  const pipe = new Writable({
    write(_bytes, _encoding, callback) {
      callback(Object.assign(new Error("private write path"), { code: "EPIPE" }));
    },
  });
  const actual = new ObservationWriter("host", "pipe-host", new MonotonicClock(), limits, pipe);
  const closed = new Promise<void>((resolve) => pipe.once("close", resolve));
  actual.process(failure);
  await closed;
  await actual.finish();
  assert.equal(
    pipe.destroyed,
    true,
    "actual Writable error/close must not escape to the safety loop",
  );
});

test("p0.observation: errors retain structured facts only; exact proof redaction fits a maximum accepted frame", async () => {
  let schemaError: unknown;
  try {
    assertValid("P0RuntimeConfig", { secret: "must-not-leak" });
  } catch (error) {
    schemaError = error;
  }
  assert.ok(schemaError instanceof SchemaValidationError);
  assert.deepEqual(observationError(schemaError), {
    kind: "schema",
    schema_name: "P0RuntimeConfig",
    keyword: "required",
  });
  assert.deepEqual(observationError(new SchemaValidationError("P0RuntimeConfig", null, "secret")), {
    kind: "internal",
    code: "unexpected_error",
  });
  assert.deepEqual(observationError(new Error("AUTHENTICATION_REQUIRED secret")), {
    kind: "internal",
    code: "unexpected_error",
  });
  assert.deepEqual(observationError(new RuntimeRejection("PERSISTENCE_NOT_READY")), {
    kind: "runtime",
    reason_code: "PERSISTENCE_NOT_READY",
  });
  const request = requestFixture();
  const safe = observedRequest(request);
  assert.ok("proof" in request.params.input && "proof_hmac" in request.params.input.proof);
  assert.ok("proof" in safe.params.input && "authenticator_sha256" in safe.params.input.proof);
  assert.equal(
    safe.params.input.proof.authenticator_sha256,
    createHash("sha256").update(request.params.input.proof.proof_hmac).digest("hex"),
  );
  assert.equal(JSON.stringify(safe).includes(request.params.input.proof.proof_hmac), false);
  const expected = structuredClone(request) as unknown as {
    params: { input: { proof: Record<string, unknown> } };
  };
  delete expected.params.input.proof.proof_hmac;
  const actual = structuredClone(safe) as unknown as typeof expected;
  delete actual.params.input.proof.authenticator_sha256;
  delete actual.params.input.proof.redaction;
  assert.deepEqual(actual, expected);
  const sink = new Sink(),
    out = writer(sink, 16, Buffer.byteLength(JSON.stringify(request)));
  const trigger = out.requestReceived("connection", request);
  assert.ok(trigger);
  const received = protocolRecords(sink.text())[0];
  assert.ok(received);
  assert.equal(trigger.receive_seq, received.source_seq);
  assert.equal(
    trigger.trigger_id,
    payloadDigest({
      connection_id: "connection",
      receiver_instance_id: out.instance,
      request_id: request.id,
      receive_seq: received.source_seq,
    }),
  );
  assert.deepEqual(observationTrigger(received), {
    trigger_kind: "protocol_fact",
    trigger_id: payloadDigest({
      record_type: received.record_type,
      source_instance_id: received.source_instance_id,
      source_pid: received.source_pid,
      source_seq: received.source_seq,
    }),
    trigger_digest: payloadDigest(received),
  });
  await out.finish();
  completeStreams(sink.text());
});

test("p0.observation: real channel separates parse and dispatch failures and keeps frame evidence without raw secrets", async () => {
  for (const mode of ["dispatch", "invalid", "truncated", "oversize"] as const) {
    const sink = new Sink(),
      out = writer(sink),
      input = new PassThrough(),
      output = new PassThrough();
    const channel = new JsonChannel(input, output, 512, 8);
    new ProtocolObservation(out, "connection").attach(channel);
    const invalid: string[] = [];
    channel.on("invalid", (reason: string) => invalid.push(reason));
    if (mode === "dispatch") {
      channel.on("message", () => {
        throw new Error("secret business error");
      });
      input.write("{}\n");
      assert.deepEqual(invalid, []);
    }
    if (mode === "invalid") {
      channel.on("invalid", () => channel.close());
      input.write('{"secret":"broken"\n');
    }
    if (mode === "truncated") input.end('{"secret":');
    if (mode === "oversize") input.write("x".repeat(513));
    await new Promise((resolve) => setImmediate(resolve));
    channel.close();
    await out.finish();
    const failures = protocolRecords(sink.text()).filter((r) => r.detail.kind === "local_failure");
    const detail = failures
      .map((r) => r.detail)
      .find(
        (r) =>
          r.kind === "local_failure" && r.stage === (mode === "dispatch" ? "dispatch" : "parse"),
      );
    assert.ok(detail && detail.kind === "local_failure");
    if (mode === "invalid") {
      assert.equal(detail.frame_bytes, Buffer.byteLength('{"secret":"broken"'));
      assert.equal(
        detail.frame_sha256,
        createHash("sha256").update('{"secret":"broken"').digest("hex"),
      );
    } else {
      assert.equal(detail.frame_sha256, null);
      assert.equal(detail.frame_bytes, null);
    }
    assert.equal(sink.text().includes("secret"), false);
    completeStreams(sink.text());
  }
});

test("p0.observation: multiple actual channels share a sequence and preserve received rejection before client throws", async () => {
  const sink = new Sink(),
    out = writer(sink),
    supervisor = generateIdentity("supervisor"),
    clock = new MonotonicClock();
  for (let n = 0; n < 2; n++) {
    const incoming = new PassThrough(),
      outgoing = new PassThrough();
    const client = new JsonChannel(incoming, outgoing, limits.max_message_bytes, 16);
    const server = new JsonChannel(outgoing, incoming, limits.max_message_bytes, 16);
    const connect = RpcConnection.fromChannel(
      client,
      supervisor.public,
      limits,
      randomUUID(),
      clock,
      clock.now(),
      supervisor.public,
      out,
    );
    server.send(
      announcementEvent(
        announce(
          supervisor,
          "controlled-session",
          new MonotonicClock(),
          limits.clock_mapping_ttl_ms,
          supervisor.public,
          0,
        ),
      ),
    );
    const connection = await connect;
    server.on("message", (request: RpcRequest) =>
      server.send(businessFailure(request.id, request.params.context, "PERSISTENCE_NOT_READY")),
    );
    const request = completeRequest(
      "clock.sample",
      { mapping: connection.mapping, source_sent_at: clock.point() },
      connection.context(),
    );
    await assert.rejects(connection.request(request), /PERSISTENCE_NOT_READY/);
    const observed = protocolRecords(sink.text()).findLast(
      (r) => r.detail.kind === "response_received",
    );
    assert.ok(observed?.detail.kind === "response_received");
    assert.deepEqual(
      observed.detail.rpc.response,
      businessFailure(request.id, request.params.context, "PERSISTENCE_NOT_READY"),
    );
    connection.close();
    server.close();
  }
  await out.finish();
  completeStreams(sink.text());
  const observed = protocolRecords(sink.text());
  assert.equal(new Set(observed.map((r) => r.connection_id)).size, 2);
  assert.equal(observed.filter((r) => r.detail.kind === "announcement_received").length, 2);
  assert.equal(observed.filter((r) => r.detail.kind === "event_received").length, 0);
});

test("p0.observation: parent records actual spawn, exit and ENOENT without inventing an exit", async () => {
  const sink = new Sink(),
    out = writer(sink),
    args = ["-e", "process.exit(7)"];
  const child = observedSpawn(
    process.execPath,
    args,
    { env: safeChildEnvironment(), stdio: "ignore" },
    out,
    "operator",
    null,
  );
  await once(child, "exit");
  const missing = observedSpawn(
    "/does-not-exist/bellis-observation",
    [],
    { stdio: "ignore" },
    out,
    "endpoint",
    "expected-endpoint",
  );
  await new Promise<void>((resolve) => missing.once("error", () => resolve()));
  await out.finish();
  completeStreams(sink.text());
  const data = processRecords(sink.text());
  assert.deepEqual(
    data.map((r) => r.detail.kind),
    ["spawn_attempt", "spawned", "exited", "spawn_attempt", "spawn_error"],
  );
  const attempt = data[0]?.detail;
  assert.ok(attempt?.kind === "spawn_attempt");
  assert.equal(attempt.command_digest, payloadDigest({ exec_path: process.execPath, args }));
  const exit = data[2]?.detail;
  assert.ok(exit?.kind === "exited");
  assert.equal(exit.actual_pid, child.pid);
  assert.equal(exit.exit_code, 7);
  assert.equal(exit.signal, null);
  const error = data[4]?.detail;
  assert.ok(error?.kind === "spawn_error");
  assert.equal(error.actual_pid, null);
  assert.equal(error.error.kind, "node");
});

test("p0.observation: actual startup rejection preserves stage and safe schema details", {
  timeout: 15000,
}, async () => {
  const fixture = await createProductionFixture();
  try {
    await writeFile(fixture.configPath, JSON.stringify({ secret: "must-not-leak" }));
    for (const [name, args, stage] of [
      ["bad-arguments", [join(repository, "apps/host/supervisor.ts")], "arguments"],
      [
        "bad-config",
        [join(repository, "apps/host/supervisor.ts"), "--config", fixture.configPath],
        "configuration",
      ],
    ] as const) {
      const process = capture([...args], name);
      const [code] = await process.closed;
      await process.save();
      assert.equal(code, 1);
      completeStreams(process.output().stderr);
      const detail = processRecords(process.output().stderr)[0]?.detail;
      assert.ok(detail?.kind === "startup_rejected");
      assert.equal(detail.stage, stage);
      if (stage === "configuration")
        assert.deepEqual(detail.error, {
          kind: "schema",
          schema_name: "P0RuntimeConfig",
          keyword: "required",
        });
      assert.equal(process.output().stderr.includes("must-not-leak"), false);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("p0.observation: real CLI host-query pins Host and Supervisor and preserves independent cached projections", {
  timeout: 20000,
}, async () => {
  const fixture = await createProductionFixture();
  const supervisor = capture(
    [join(repository, "apps/host/supervisor.ts"), "--config", fixture.configPath],
    "supervisor-host-query",
  );
  try {
    await waitFor(`${fixture.config.management_socket_path}.host.identity.json`, supervisor.child);
    const cli = async (action: string, name: string, path = fixture.configPath) => {
      const run = capture(
        [join(repository, "apps/host/operator.ts"), "--config", path, "--command", action],
        name,
      );
      const [code] = await run.closed;
      await run.save();
      completeStreams(run.output().stderr);
      return { code, response: JSON.parse(run.output().stdout), stderr: run.output().stderr };
    };
    let first: Awaited<ReturnType<typeof cli>> | undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      first = await cli("host-query", `host-query-ready-${attempt}`);
      assert.equal(first.code, 0);
      if (first.response.result.fact?.host_connection_deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(first?.response.result.fact?.host_connection_deadline);
    const second = await cli("host-query", "host-query-again");
    assert.equal(second.code, 0);
    const projection = first.response.result as P0EndpointProjection;
    const again = second.response.result as P0EndpointProjection;
    assert.deepEqual(
      again.received_at,
      projection.received_at,
      "query must not refresh Host cache arrival time",
    );
    assert.equal(again.fact?.completed_effect_count, 0);
    const sup = await cli("query", "supervisor-query");
    assert.equal(sup.code, 0);
    assert.notEqual(
      sup.response.result.endpoint.received_at.clock_domain,
      again.received_at?.clock_domain,
    );
    assert.equal(sup.response.result.endpoint.source_instance_id, again.source_instance_id);
    assert.deepEqual(sup.response.result.endpoint.fact, again.fact);
    const observations = protocolRecords(second.stderr);
    const announced = observations.find((r) => r.detail.kind === "announcement_received");
    assert.ok(announced?.detail.kind === "announcement_received");
    assert.equal(announced.detail.fixed_peer.role, "host");
    assert.equal(announced.detail.fixed_authority.role, "supervisor");
    assert.notEqual(
      announced.detail.fixed_peer.instance_id,
      announced.detail.fixed_authority.instance_id,
    );
    const identity = await readServiceIdentity(`${fixture.config.management_socket_path}.host`);
    await assert.rejects(
      RpcConnection.connect(
        `${fixture.config.management_socket_path}.host`,
        identity,
        fixture.config.limits,
      ),
      /AUTHENTICATION_REQUIRED/,
    );
    const wrongCredential = join(fixture.directory, "wrong-credential.json");
    await writeFile(
      wrongCredential,
      JSON.stringify({ ...fixture.credential, authentication_key_sha256: "b".repeat(64) }),
      { mode: 0o600 },
    );
    const wrongConfig = join(fixture.directory, "wrong-config.json");
    await writeFile(
      wrongConfig,
      JSON.stringify({ ...fixture.config, operator_credentials_path: wrongCredential }),
      { mode: 0o600 },
    );
    const denied = await cli("host-query", "host-query-denied", wrongConfig);
    assert.equal(denied.code, 1);
    assert.equal(denied.response.error.data.reason_code, "AUTHENTICATION_REQUIRED");
    assert.ok(
      protocolRecords(denied.stderr).some(
        (r) => r.detail.kind === "response_received" && "error" in r.detail.rpc.response,
      ),
    );
    for (const secret of [fixture.credential.authentication_key_sha256, "b".repeat(64)])
      assert.equal(denied.stderr.includes(secret), false);
    const raw = createConnection(`${fixture.config.management_socket_path}.host`);
    await once(raw, "data");
    const closed = once(raw, "close");
    raw.write('{"private-invalid-observation":"broken"\n');
    await closed;
    await new Promise((resolve) => setTimeout(resolve, limits.peer_health_timeout_ms));
    const stale = await cli("host-query", "host-query-stale");
    assert.equal(stale.code, 0);
    assert.equal(stale.response.result.quality, "stale");
    assert.deepEqual(stale.response.result.received_at, again.received_at);
  } finally {
    await stopProcess(supervisor.child);
    await supervisor.closed;
    await supervisor.save();
    await fixture.cleanup();
  }
  completeStreams(supervisor.output().stderr);
  assert.equal(supervisor.output().stderr.includes("private-invalid-observation"), false);
  assert.ok(
    protocolRecords(supervisor.output().stderr).some(
      (r) =>
        r.source_role === "host" &&
        r.detail.kind === "local_failure" &&
        r.detail.stage === "parse" &&
        r.detail.frame_sha256 ===
          createHash("sha256").update('{"private-invalid-observation":"broken"').digest("hex"),
    ),
  );
  const process = processRecords(supervisor.output().stderr);
  assert.ok(
    process.some(
      (r) =>
        r.source_role === "supervisor" &&
        r.detail.kind === "exited" &&
        r.detail.child_role === "host",
    ),
  );
  assert.ok(
    process.some(
      (r) =>
        r.source_role === "host" &&
        r.detail.kind === "spawned" &&
        r.detail.child_role === "endpoint",
    ),
  );
});

test("p0.observation: a schema-valid foreign event is observed before the trusted client rejects it", async () => {
  const sink = new Sink(),
    out = writer(sink),
    supervisor = generateIdentity("supervisor"),
    endpoint = generateIdentity("endpoint"),
    clock = new MonotonicClock();
  const incoming = new PassThrough(),
    outgoing = new PassThrough();
  const client = new JsonChannel(incoming, outgoing, limits.max_message_bytes, 16);
  const server = new JsonChannel(outgoing, incoming, limits.max_message_bytes, 16);
  const connect = RpcConnection.fromChannel(
    client,
    endpoint.public,
    limits,
    randomUUID(),
    clock,
    clock.now(),
    supervisor.public,
    out,
  );
  server.send(
    announcementEvent(
      announce(
        endpoint,
        "controlled-session",
        new MonotonicClock(),
        limits.clock_mapping_ttl_ms,
        supervisor.public,
        0,
      ),
    ),
  );
  const connection = await connect;
  let accepted = 0;
  connection.onEndpointFact(
    () => {
      accepted++;
    },
    () => 0,
  );
  const event = {
    jsonrpc: "2.0",
    method: "event.publish",
    params: {
      schema_version: "0.8.0",
      event_name: "grant.denied",
      event_id: "event",
      authority_id: "supervisor",
      source_instance: supervisor.public.instance_id,
      authority_epoch: 0,
      source_seq: 0,
      session_id: "controlled-session",
      scope_ref: { kind: "Session", id: "controlled-session" },
      correlation: { key: "operation", value: "operation" },
      occurred_at: clock.point(),
      trace_id: "trace",
      payload: {
        object_ref: { kind: "ExecutionGrant", id: "grant" },
        source_revision: 1,
        state: "DENIED",
        outcome: null,
        reason_code: "PERSISTENCE_NOT_READY",
        evidence_refs: [],
        settlement_ref: null,
      },
    },
  };
  assertValid("RpcEvent", event);
  server.send(event);
  assert.equal(client.closed, true);
  assert.equal(accepted, 0);
  server.close();
  await out.finish();
  completeStreams(sink.text());
  const data = protocolRecords(sink.text());
  const received = data.find((r) => r.detail.kind === "event_received");
  assert.ok(received?.detail.kind === "event_received");
  assert.deepEqual(received.detail.event, event);
  assert.ok(
    data.some(
      (r) =>
        r.source_seq > received.source_seq &&
        r.detail.kind === "local_failure" &&
        r.detail.stage === "dispatch",
    ),
  );
});

test("p0.observation: authenticated Host query does not call supervisor snapshot and rejects wrong session/source", {
  timeout: 10000,
}, async () => {
  const fixture = await createProductionFixture(),
    host = generateIdentity("host"),
    supervisor = generateIdentity("supervisor"),
    clock = new MonotonicClock();
  const projection: P0EndpointProjection = {
    source_instance_id: "expected-endpoint",
    received_at: clock.point(),
    quality: "unknown",
    fact: null,
  };
  const service = new P0Service({
    identity: host,
    authority: supervisor.public,
    currentAuthorityEpoch: () => 0,
    sessionId: "controlled-session",
    clock,
    limits,
    credential: fixture.credential,
    peers: [],
    faultInjectionEnabled: false,
    snapshot: () => {
      assert.fail("host.query cannot proxy supervisor snapshot");
    },
    hostEndpoint: {
      instanceId: "expected-endpoint",
      projection: () => structuredClone(projection),
    },
  });
  const socket = join(fixture.directory, "projection.sock");
  try {
    await service.listen(socket);
    const query = async (session = "controlled-session") => {
      const connection = await RpcConnection.connect(
        socket,
        host.public,
        limits,
        randomUUID(),
        new MonotonicClock(),
        supervisor.public,
      );
      try {
        return await connection.operatorCall(
          "host.query",
          { session_id: session },
          fixture.credential,
        );
      } finally {
        connection.close();
      }
    };
    assert.deepEqual(await query(), projection);
    assert.deepEqual(await query(), projection);
    await assert.rejects(query("wrong-session"), /ROLE_SCOPE_DENIED/);
    projection.source_instance_id = "wrong-endpoint";
    await assert.rejects(query(), /ROLE_SCOPE_DENIED/);
  } finally {
    await service.close();
    await fixture.cleanup();
  }
});
