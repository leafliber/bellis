import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, open, readFile, writeFile } from "node:fs/promises";
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
  AsyncFdSink,
  type AsyncWrite,
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
}, async (t) => {
  const rawBase = join(repository, "reports/p0/w5o/raw");
  await mkdir(rawBase, { recursive: true });
  const runDirectory = await mkdtemp(join(rawBase, "host-query-run-"));
  t.diagnostic(`independent projections raw=${runDirectory}`);
  const fixture = await createProductionFixture();
  const supervisor = capture(
    [join(repository, "apps/host/supervisor.ts"), "--config", fixture.configPath],
    "supervisor-host-query",
    safeChildEnvironment(),
    runDirectory,
  );
  try {
    await waitFor(`${fixture.config.management_socket_path}.host.identity.json`, supervisor.child);
    const cli = async (action: string, name: string, path = fixture.configPath) => {
      const run = capture(
        [join(repository, "apps/host/operator.ts"), "--config", path, "--command", action],
        name,
        safeChildEnvironment(),
        runDirectory,
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
    // Host handshake and the independent Supervisor safety poll have different
    // readiness boundaries. Every attempt is the real authenticated CLI query;
    // a Host fact cannot stand in for receipt by the Supervisor.
    let sup: Awaited<ReturnType<typeof cli>> | undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      sup = await cli("query", `supervisor-query-ready-${attempt}`);
      assert.equal(sup.code, 0);
      assert.equal(sup.response.result.session_id, again.fact?.session_id);
      assert.equal(sup.response.result.endpoint.source_instance_id, again.source_instance_id);
      if (
        sup.response.result.endpoint.quality === "fresh" &&
        sup.response.result.endpoint.fact?.host_connection_deadline
      )
        break;
    }
    assert.ok(sup?.response.result.endpoint.fact?.host_connection_deadline);
    assert.equal(sup.response.result.endpoint.quality, "fresh");
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

test("p0.observation.fd module: partial writes and EAGAIN/EINTR/zero progress preserve FIFO and offset", async () => {
  const offsets: number[] = [],
    seen: string[] = [];
  let active = 0,
    maxActive = 0,
    calls = 0;
  const write: AsyncWrite = (_fd, bytes, offset, length, _position, callback) => {
    offsets.push(offset);
    calls++;
    active++;
    maxActive = Math.max(maxActive, active);
    const current = calls;
    queueMicrotask(() => {
      active--;
      if (current === 2 || current === 3)
        callback(
          Object.assign(new Error("controlled retry"), {
            code: current === 2 ? "EAGAIN" : "EINTR",
          }),
          0,
        );
      else if (current === 4) callback(null, 0);
      else {
        const n = Math.min(2, length);
        seen.push(bytes.subarray(offset, offset + n).toString());
        callback(null, n);
      }
    });
  };
  const sink = new AsyncFdSink(2, 2, 16, 100, write);
  const done = (text: string) =>
    new Promise<void>((resolve, reject) =>
      sink.write(Buffer.from(text), (error) => (error ? reject(error) : resolve())),
    );
  await Promise.all([done("abcd"), done("efgh")]);
  assert.equal(maxActive, 1);
  assert.deepEqual(offsets, [0, 2, 2, 2, 2, 0, 2]);
  assert.equal(seen.join(""), "abcdefgh");
  assert.equal(sink.backpressureObserved, true);
  assert.equal(sink.inFlight, false);
});

test("p0.observation.fd module: absolute retry deadline, EPIPE and late callbacks remain incomplete", async () => {
  let retries = 0;
  const retry: AsyncWrite = (_fd, _bytes, _offset, _length, _position, callback) => {
    retries++;
    setTimeout(
      () => callback(Object.assign(new Error("controlled EAGAIN"), { code: "EAGAIN" }), 0),
      1,
    );
  };
  const retrySink = new AsyncFdSink(2, 2, 16, 20, retry);
  const started = performance.now();
  const error = await new Promise<Error | null | undefined>((resolve) =>
    retrySink.write(Buffer.from("abc"), resolve),
  );
  assert.equal((error as NodeJS.ErrnoException)?.code, "ETIMEDOUT");
  assert.ok(retries > 1);
  assert.ok(performance.now() - started < 500, "retry cannot renew the original 20ms deadline");
  const finishedCalls = retries;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(retries, finishedCalls);
  let late: Parameters<AsyncWrite>[5] | undefined,
    calls = 0;
  const hanging: AsyncWrite = (_fd, _bytes, _offset, _length, _position, callback) => {
    calls++;
    late = callback;
  };
  const sink = new AsyncFdSink(2, 2, 65536, 20, hanging);
  const out = new ObservationWriter(
    "host",
    "controlled-late-writer",
    new MonotonicClock(),
    limits,
    sink,
  );
  out.process(failure);
  out.process(failure);
  const result = await out.finish(5);
  assert.equal(result.complete, false);
  assert.equal(result.os_write_in_flight, true);
  assert.equal(result.pending_records, 0);
  assert.ok(late);
  late(null, 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 1, "late partial callback cannot resume a timed-out record or add a tail");
  let pipeCalls = 0;
  const pipe = new AsyncFdSink(
    2,
    2,
    16,
    100,
    (_fd, _bytes, _offset, _length, _position, callback) => {
      pipeCalls++;
      queueMicrotask(() =>
        callback(Object.assign(new Error("controlled EPIPE"), { code: "EPIPE" }), 0),
      );
    },
  );
  const errors = await Promise.all(
    ["first", "queued"].map(
      (text) =>
        new Promise<Error | null | undefined>((resolve) => pipe.write(Buffer.from(text), resolve)),
    ),
  );
  assert.deepEqual(
    errors.map((e) => (e as NodeJS.ErrnoException).code),
    ["EPIPE", "EPIPE"],
  );
  assert.equal(pipeCalls, 1);
});

test("p0.observation.fd: real default FILE output has complete records and actual startup failure tail", {
  timeout: 10000,
}, async () => {
  const directory = join(repository, "reports/p0/w5of/raw");
  await mkdir(directory, { recursive: true });
  for (const [name, args, code] of [
    ["default-file", [join(repository, "tests/p0-observation.fd-helper.ts"), "file"], 0],
    ["supervisor-file-failure", [join(repository, "apps/host/supervisor.ts")], 1],
  ] as const) {
    const file = await open(join(directory, `${name}.stderr.ndjson`), "w", 0o600);
    const child = spawn(process.execPath, [...args], {
      env: safeChildEnvironment(),
      stdio: ["ignore", "pipe", file.fd],
    });
    const stdout: Buffer[] = [];
    child.stdout?.on("data", (bytes: Buffer) => stdout.push(bytes));
    const force = setTimeout(() => child.kill("SIGKILL"), 2000);
    try {
      const [actual, signal] = await once(child, "close");
      assert.equal(actual, code);
      assert.equal(signal, null);
    } finally {
      clearTimeout(force);
      await file.close();
    }
    await writeFile(join(directory, `${name}.stdout`), Buffer.concat(stdout));
    completeStreams(await readFile(join(directory, `${name}.stderr.ndjson`), "utf8"));
    if (name === "default-file")
      assert.equal(
        JSON.parse(Buffer.concat(stdout).toString().trim().split("\n")[1] ?? "{}").finish.complete,
        true,
      );
  }
});

test("p0.observation.fd: unread real PIPE fills while timer progresses and process exits with incomplete raw stream", {
  timeout: 10000,
}, async () => {
  const directory = join(repository, "reports/p0/w5of/raw");
  await mkdir(directory, { recursive: true });
  const child = spawn(
    process.execPath,
    [join(repository, "tests/p0-observation.fd-helper.ts"), "pipe"],
    { env: safeChildEnvironment(), stdio: ["ignore", "pipe", "pipe"] },
  );
  const output: Buffer[] = [],
    raw: Buffer[] = [];
  child.stdout.on("data", (bytes: Buffer) => output.push(bytes));
  // No stderr data/readable handler or read/resume until actual child exit.
  let watchdogFired = false;
  const force = setTimeout(() => {
    watchdogFired = true;
    child.kill("SIGKILL");
  }, 2000);
  const closed = once(child, "close");
  const [code, signal] = await once(child, "exit");
  child.stderr.on("data", (bytes: Buffer) => raw.push(bytes));
  child.stderr.resume();
  await closed;
  clearTimeout(force);
  const bytes = Buffer.concat(raw),
    stdout = Buffer.concat(output).toString("utf8");
  await writeFile(join(directory, "default-pipe.stderr.raw"), bytes);
  await writeFile(join(directory, "default-pipe.stdout"), stdout);
  const [progress, summary, exit] = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(progress.timer_progress, true);
  assert.equal(progress.attempted, 1024);
  assert.equal(summary.finish.complete, false);
  assert.ok(
    summary.finish.os_write_in_flight || summary.finish.os_backpressure_observed,
    "default fs.write must have an actual pending OS write or observed EAGAIN/zero progress",
  );
  assert.ok(bytes.length > 0);
  assert.ok(bytes.length < 1024 * 1000, "only the filled pipe prefix can be present");
  assert.equal(bytes.includes(Buffer.from("p0-observation-stream-end")), false);
  // Preserve and describe any partial line; do not filter it into a complete evidence stream.
  const text = bytes.toString("utf8"),
    lines = text.split("\n");
  let malformed = 0;
  for (const line of lines.slice(0, -1)) {
    try {
      JSON.parse(line);
    } catch {
      malformed++;
    }
  }
  await writeFile(
    join(directory, "default-pipe.capture.json"),
    JSON.stringify(
      {
        capture_eof: true,
        raw_bytes: bytes.length,
        complete_lines: lines.length - 1,
        malformed_complete_lines: malformed,
        trailing_partial_bytes: Buffer.byteLength(lines.at(-1) ?? ""),
        application_stream_complete: false,
        child_exit_code: code,
        child_signal: signal,
        parent_watchdog_fired: watchdogFired,
        exit_strategy: exit.exit_strategy,
        finish: summary.finish,
      },
      null,
      2,
    ),
  );
  assert.equal(code, null);
  assert.equal(signal, "SIGKILL");
  assert.equal(watchdogFired, false);
  assert.equal(exit.exit_strategy, "self_sigkill");
  assert.equal(
    malformed,
    0,
    "unexpected interleaved or malformed complete lines remain a test failure",
  );
});
