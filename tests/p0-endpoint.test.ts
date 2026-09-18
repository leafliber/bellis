import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createConnection } from "node:net";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  assertValid,
  type CommandContext,
  type P0ClockMapping,
  type P0EndpointLease,
  type P0EndpointRevokeInput,
  type P0ExecuteInput,
  type P0PersistenceReceipt,
  payloadDigest,
  schemaDigest,
} from "../packages/contract-sdk/src/index.ts";
import { RpcConnection } from "../packages/runtime/src/client.ts";
import { MonotonicClock } from "../packages/runtime/src/clock.ts";
import { launchEndpoint, queryEndpoint } from "../packages/runtime/src/endpoint-client.ts";
import {
  announce,
  announcementEvent,
  completeRequest,
  generateIdentity,
} from "../packages/runtime/src/identity.ts";
import { startSupervisor, terminateChild } from "../packages/runtime/src/processes.ts";
import { JsonChannel } from "../packages/runtime/src/transport.ts";
import { EndpointModel } from "../plugins/fake-device/model.ts";
import { EndpointProtocol } from "../plugins/fake-device/protocol.ts";
import { createProductionFixture, endpointMaterials } from "./p0-endpoint.helpers.ts";
import { runCli } from "./p0-identity.helpers.ts";

class ControlledClock extends MonotonicClock {
  time = 100;
  override now(): number {
    return this.time;
  }
}

test("p0.endpoint module: maximum-length retained facts reserve complete RPC/event/observation wire budget", async () => {
  const f = await modelFixture(true);
  try {
    f.model.install(f.lease, f.context());
    let accepted = 0;
    for (let index = 0; index < 16; index++) {
      const op = f.execute(1, `${String(index).padStart(8, "0")}${"x".repeat(152)}`);
      try {
        f.model.execute(op.input, op.context);
        accepted++;
      } catch (error) {
        assert.match(String(error), /QUEUE_LIMIT_EXCEEDED/);
        break;
      }
    }
    assert.ok(accepted > 0 && accepted < 8);
    f.model.fence();
    const fact = f.model.snapshot();
    assert.equal(fact.effect_facts.length, accepted);
    // Worst legal numeric/status forms remain finite. No production facts are rewritten by this module assertion.
    const worst = structuredClone(fact);
    worst.source_revision = Number.MAX_SAFE_INTEGER;
    worst.completed_effect_count = Number.MAX_SAFE_INTEGER;
    worst.accepted_watermark = Number.MAX_SAFE_INTEGER;
    worst.observed_at.monotonic_ms = Number.MAX_SAFE_INTEGER;
    worst.unknown_operation_ids = worst.effect_facts.map((item) => item.operation_id);
    for (const item of worst.effect_facts) {
      item.accepted_seq = Number.MAX_SAFE_INTEGER;
      item.requested_units = 100000;
      item.completed_units = 100000;
      item.outcome = "unknown";
      item.occurred_at.monotonic_ms = Number.MAX_SAFE_INTEGER;
    }
    assertValid("P0EndpointSnapshot", worst);
    const rpc = { jsonrpc: "2.0", id: "r".repeat(256), result: worst };
    const event = {
      jsonrpc: "2.0",
      method: "event.publish",
      params: {
        schema_version: "0.8.0",
        event_name: "simulation.stopped",
        event_id: "e".repeat(160),
        authority_id: "endpoint",
        source_instance: f.config.endpoint_instance_id,
        authority_epoch: Number.MAX_SAFE_INTEGER,
        source_seq: Number.MAX_SAFE_INTEGER,
        session_id: f.config.session_id,
        scope_ref: { kind: "Session", id: f.config.session_id },
        correlation: { key: "endpoint", value: f.config.endpoint_instance_id },
        occurred_at: worst.observed_at,
        trace_id: "t".repeat(160),
        payload: worst,
      },
    };
    const observation = {
      observation_seq: Number.MAX_SAFE_INTEGER,
      endpoint_fact: worst,
      dropped_observations: Number.MAX_SAFE_INTEGER,
    };
    assertValid("RpcEvent", event);
    assertValid("P0EndpointObservation", observation);
    for (const value of [rpc, event, observation])
      assert.ok(Buffer.byteLength(JSON.stringify(value)) <= f.config.limits.max_message_bytes);
  } finally {
    await f.fixture.cleanup();
  }
});

test("p0.endpoint production: ordinary capacity cannot block safety revoke/query; malformed and stale calls reject", {
  timeout: 15000,
}, async () => {
  const fixture = await createProductionFixture();
  const m = await endpointMaterials(fixture);
  const clock = new MonotonicClock();
  let launched: Awaited<ReturnType<typeof launchEndpoint>> | undefined;
  let safety: RpcConnection | undefined;
  try {
    launched = await launchEndpoint(m.config, m.host, clock, () => {});
    safety = await RpcConnection.connect(
      m.config.safety_socket_path,
      m.endpoint.public,
      m.config.limits,
      m.supervisor.public.instance_id,
      clock,
      m.supervisor.public,
    );
    safety.onEndpointFact(
      () => {},
      () => 0,
    );
    await safety.authenticatePeer(m.supervisor);
    for (let index = 0; index < 128; index++) {
      const context = safety.context();
      await safety.request(
        completeRequest(
          "fault.apply",
          {
            fault_id: randomUUID(),
            session_id: m.config.session_id,
            target_instance_id: m.config.endpoint_instance_id,
            selection: { target: "endpoint", fault: "none", duration_ms: 0 },
            mapping: safety.mapping,
            deadline: context.deadline,
          },
          context,
        ),
      );
    }
    const full = safety.context();
    await assert.rejects(
      safety.request(
        completeRequest(
          "fault.apply",
          {
            fault_id: randomUUID(),
            session_id: m.config.session_id,
            target_instance_id: m.config.endpoint_instance_id,
            selection: { target: "endpoint", fault: "none", duration_ms: 0 },
            mapping: safety.mapping,
            deadline: full.deadline,
          },
          full,
        ),
      ),
      /QUEUE_LIMIT_EXCEEDED/,
    );
    await safety.peerCall("endpoint.revoke", {
      session_id: m.config.session_id,
      grant_id: null,
      endpoint_instance_id: m.config.endpoint_instance_id,
      supervisor_instance_id: m.supervisor.public.instance_id,
      supervision_epoch: 0,
      fence: { scope_type: "session", scope_id: m.config.session_id, cancel_epoch: 0 },
      stop_operation_id: randomUUID(),
      reason: "operator_request",
    });
    const stopped = await queryEndpoint(safety, m.config);
    assert.equal(stopped.fence_applied, true);
    assert.equal(stopped.completed_effect_count, 0);
    await assert.rejects(
      safety.peerCall("simulation.query", {
        session_id: m.config.session_id,
        endpoint_instance_id: "old-endpoint",
      }),
      /ROLE_SCOPE_DENIED/,
    );
    const wrongClock = safety.context();
    wrongClock.deadline.clock_domain = "wrong-clock";
    await assert.rejects(
      safety.request(
        completeRequest(
          "simulation.query",
          {
            session_id: m.config.session_id,
            endpoint_instance_id: m.config.endpoint_instance_id,
            mapping: safety.mapping,
          },
          wrongClock,
        ),
      ),
      /COMMAND_CLOCK_MISMATCH/,
    );
    for (const raw of [
      '{"jsonrpc":"2.0","id":"bad","method":"not.registered","params":{}}\n',
      '{"id":"one","id":"two"}\n',
      "[]\n",
    ]) {
      const socket = createConnection(m.config.safety_socket_path);
      const channel = new JsonChannel(
        socket,
        socket,
        m.config.limits.max_message_bytes,
        m.config.limits.max_pending_requests,
      );
      try {
        await once(channel, "message");
        const response = once(channel, "message");
        socket.write(raw);
        const [value] = await response;
        assertValid("RpcFailure", value);
        assert.ok([-32601, -32700, -32600].includes(value.error.code));
      } finally {
        channel.close();
      }
    }
  } finally {
    safety?.close();
    launched?.connection.close();
    if (launched) await terminateChild(launched.child);
    await fixture.cleanup();
  }
});

test("p0.endpoint production: cancel reply can hang while independent query and local lease mechanisms keep running", {
  timeout: 15000,
}, async () => {
  const fixture = await createProductionFixture();
  const m = await endpointMaterials(fixture);
  const clock = new MonotonicClock();
  let launched: Awaited<ReturnType<typeof launchEndpoint>> | undefined;
  let safety: RpcConnection | undefined;
  try {
    launched = await launchEndpoint(m.config, m.host, clock, () => {});
    safety = await RpcConnection.connect(
      m.config.safety_socket_path,
      m.endpoint.public,
      m.config.limits,
      m.supervisor.public.instance_id,
      clock,
      m.supervisor.public,
    );
    safety.onEndpointFact(
      () => {},
      () => 0,
    );
    await safety.authenticatePeer(m.supervisor);
    const context = safety.context();
    await safety.request(
      completeRequest(
        "fault.apply",
        {
          fault_id: randomUUID(),
          session_id: m.config.session_id,
          target_instance_id: m.config.endpoint_instance_id,
          selection: { target: "endpoint", fault: "cancel_never_returns", duration_ms: 3000 },
          mapping: safety.mapping,
          deadline: context.deadline,
        },
        context,
      ),
    );
    const stop = launched.connection.context();
    let settled = false;
    const pending = launched.connection
      .request(
        completeRequest(
          "controller.stop",
          {
            object_ref: stop.object_ref,
            reason: "operator_request",
            cancel_fence: { scope_type: "session", scope_id: m.config.session_id, cancel_epoch: 0 },
            stop_deadline: {
              clock_domain: stop.deadline.clock_domain,
              monotonic_ms: stop.deadline.expires_at_ms,
            },
          },
          stop,
        ),
      )
      .then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(settled, false);
    const fact = await queryEndpoint(safety, m.config);
    assert.equal(fact.stopped, true);
    assert.ok(fact.cleanup_ref);
    assert.equal(fact.completed_effect_count, 0);
    launched.connection.close();
    await pending;
  } finally {
    safety?.close();
    launched?.connection.close();
    if (launched) await terminateChild(launched.child);
    await fixture.cleanup();
  }
});

test("p0.endpoint client module: event source/epoch and same-sequence/revision conflicts close the channel", async () => {
  const f = await modelFixture();
  try {
    for (const change of ["source", "epoch", "sequence", "revision"] as const) {
      const input = new PassThrough();
      const output = new PassThrough();
      output.resume();
      const channel = new JsonChannel(input, output, f.config.limits.max_message_bytes, 16);
      const targetClock = new MonotonicClock();
      const sourceClock = new MonotonicClock();
      const a = announce(
        f.endpoint,
        f.config.session_id,
        targetClock,
        4000,
        f.supervisor.public,
        0,
      );
      const ready = RpcConnection.fromChannel(
        channel,
        f.endpoint.public,
        f.config.limits,
        f.host.public.instance_id,
        sourceClock,
        sourceClock.now(),
        f.supervisor.public,
      );
      input.write(`${JSON.stringify(announcementEvent(a))}\n`);
      const connection = await ready;
      let received = 0;
      connection.onEndpointFact(
        () => {
          received++;
        },
        () => 0,
      );
      const fact = f.model.snapshot();
      fact.observed_at.clock_domain = targetClock.domain;
      const event = {
        jsonrpc: "2.0",
        method: "event.publish",
        params: {
          schema_version: "0.8.0",
          event_name: "simulation.stopped",
          event_id: randomUUID(),
          authority_id: "endpoint",
          source_instance: f.config.endpoint_instance_id,
          authority_epoch: 0,
          source_seq: 1,
          session_id: f.config.session_id,
          scope_ref: { kind: "Session", id: f.config.session_id },
          correlation: { key: "endpoint", value: f.config.endpoint_instance_id },
          occurred_at: fact.observed_at,
          trace_id: randomUUID(),
          payload: fact,
        },
      };
      input.write(`${JSON.stringify(event)}\n`);
      assert.equal(received, 1);
      const conflict = structuredClone(event);
      if (change === "source") conflict.params.authority_id = "supervisor";
      if (change === "epoch") conflict.params.authority_epoch = 1;
      if (change === "sequence") conflict.params.event_id = randomUUID();
      if (change === "revision") {
        conflict.params.source_seq = 2;
        conflict.params.payload.completed_effect_count = 1;
      }
      input.write(`${JSON.stringify(conflict)}\n`);
      assert.equal(channel.closed, true);
      assert.equal(received, 1);
      connection.close();
    }
  } finally {
    await f.fixture.cleanup();
  }
});

async function modelFixture(capacity = false) {
  const fixture = await createProductionFixture();
  const material = await endpointMaterials(fixture);
  if (capacity) material.config.limits.max_message_bytes = 8192;
  const clock = new ControlledClock("controlled-endpoint");
  const model = new EndpointModel(material.config, clock);
  const mapping = (source: string, domain: string): P0ClockMapping => ({
    mapping_id: randomUUID(),
    connection_id: randomUUID(),
    source_instance_id: source,
    target_instance_id: material.endpoint.public.instance_id,
    source_clock_domain: domain,
    target_clock_domain: clock.domain,
    source_sent_at_ms: 98,
    source_received_at_ms: 102,
    target_received_at_ms: 100,
    target_sent_at_ms: 100,
    offset_lower_ms: -3,
    offset_upper_ms: 3,
    max_error_ms: 6,
    source_valid_until_ms: 4000,
    target_valid_until_ms: 3997,
    announcement_digest: "a".repeat(64),
  });
  const hostMapping = mapping(material.host.public.instance_id, "controlled-host");
  const supervisorMapping = mapping(
    material.supervisor.public.instance_id,
    "controlled-supervisor",
  );
  model.handshake(hostMapping);
  const deadline = (expires = 1000) => ({
    clock_domain: clock.domain,
    issued_at_ms: clock.now(),
    expires_at_ms: expires,
  });
  const context = (caller = material.supervisor.public.instance_id): CommandContext => ({
    operation_id: randomUUID(),
    payload_digest: "b".repeat(64),
    caller_instance_id: caller,
    authority_epoch: 0,
    object_ref: { kind: "Session", id: material.config.session_id },
    deadline: deadline(),
    grant_ref: null,
  });
  // Explicit controlled module receipts; no Worker, host authorization or SUT claim.
  const receipt = (): P0PersistenceReceipt => ({
    receipt_id: randomUUID(),
    writer_instance_id: "controlled-worker",
    transaction_id: randomUUID(),
    request_digest: "c".repeat(64),
    committed_at: { clock_domain: "controlled-worker-clock", monotonic_ms: 99 },
    database_version: 1,
    grant_digests: [],
    admission_digests: [],
    effect_digests: [],
  });
  const grant: P0EndpointLease["grant"] = {
    grant_id: randomUUID(),
    mode: "simulation",
    state: "ACTIVE",
    session_id: material.config.session_id,
    supervision_epoch: 0,
    profile_ref: "p0-simulation-profile@1",
    target_refs: [
      { kind: "SimulationCounter", id: capacity ? "t".repeat(160) : "fixture-counter" },
    ],
    allowed_capabilities: ["simulation.execute"],
    effect_limit: 16,
    cost_limit_units: 8,
    deadline: {
      clock_domain: supervisorMapping.source_clock_domain,
      issued_at_ms: 90,
      expires_at_ms: 2000,
    },
    operator_id: "controlled-module-operator",
    gate_evidence_refs: [],
    public_broadcast_allowed: false,
    host_instance_id: material.host.public.instance_id,
    supervisor_instance_id: material.supervisor.public.instance_id,
    endpoint_instance_id: material.endpoint.public.instance_id,
    queue_limit: 8,
    admission_ref: randomUUID(),
  };
  const admission: P0EndpointLease["admission"] = {
    admission_id: grant.admission_ref as string,
    session_id: grant.session_id,
    host_instance_id: grant.host_instance_id,
    supervisor_instance_id: grant.supervisor_instance_id,
    endpoint_instance_id: grant.endpoint_instance_id,
    operator_id: grant.operator_id,
    installation_id: material.config.installation_id,
    installation_digest: payloadDigest(fixture.config.installation),
    manifest_digest: payloadDigest(material.config.manifest),
    profile_digest: payloadDigest(fixture.config.profile),
    schema_digest: schemaDigest,
    mode: "simulation",
    enabled_phases: ["P0"],
    public_broadcast_allowed: false,
    accepted_at: { clock_domain: "controlled-supervisor", monotonic_ms: 90 },
    record_status: "durable",
  };
  const lease: P0EndpointLease = {
    lease_id: randomUUID(),
    grant,
    admission,
    mapping: supervisorMapping,
    deadline: deadline(1900),
    human_lease_deadline: deadline(1500),
    local_lease_deadline: deadline(600),
    receipt: receipt(),
  };
  lease.receipt.grant_digests = [payloadDigest(grant)];
  lease.receipt.admission_digests = [payloadDigest(admission)];
  const execute = (units = 2, operation: string = randomUUID()) => {
    const action: P0ExecuteInput["action"] = {
      target_ref: grant.target_refs[0] as { kind: string; id: string },
      capability: "simulation.execute",
      units,
      interval_ms: 10,
      cost_units: 1,
    };
    const input: P0ExecuteInput = {
      action,
      mapping: hostMapping,
      receipt: receipt(),
      registration: {
        operation_id: operation,
        session_id: grant.session_id,
        grant_id: grant.grant_id,
        endpoint_instance_id: grant.endpoint_instance_id,
        target_ref: action.target_ref,
        capability: action.capability,
        payload_digest: payloadDigest({
          session_id: grant.session_id,
          grant_id: grant.grant_id,
          endpoint_instance_id: grant.endpoint_instance_id,
          action,
        }),
        units,
        cost_units: action.cost_units,
        deadline: {
          clock_domain: hostMapping.source_clock_domain,
          issued_at_ms: clock.now(),
          expires_at_ms: 500,
        },
        registered_at: { clock_domain: hostMapping.source_clock_domain, monotonic_ms: clock.now() },
      },
    };
    input.receipt.effect_digests = [payloadDigest(input.registration)];
    return {
      input,
      context: {
        ...context(material.host.public.instance_id),
        operation_id: operation,
        grant_ref: grant.grant_id,
      },
    };
  };
  return {
    ...material,
    fixture,
    clock,
    model,
    hostMapping,
    supervisorMapping,
    lease,
    context,
    execute,
  };
}

function freshGrant(lease: P0EndpointLease): P0EndpointLease {
  const next = structuredClone(lease);
  next.lease_id = randomUUID();
  next.grant.grant_id = randomUUID();
  next.grant.admission_ref = randomUUID();
  next.admission.admission_id = next.grant.admission_ref;
  next.receipt.grant_digests = [payloadDigest(next.grant)];
  next.receipt.admission_digests = [payloadDigest(next.admission)];
  return next;
}

test("p0.endpoint module: valid authority advance fences before old-grant admission or identical-lease retry", async () => {
  for (const replay of [false, true]) {
    const f = await modelFixture();
    try {
      f.model.install(f.lease, f.context());
      const queued = f.execute();
      f.model.execute(queued.input, queued.context);
      const next = structuredClone(f.lease);
      if (!replay) next.lease_id = randomUUID();
      const context = { ...f.context(), authority_epoch: 1 };
      assert.throws(() => f.model.install(next, context), /EXECUTION_GRANT_REVOKED/);
      assert.equal(f.model.authorityEpoch, 1);
      assert.equal(f.model.snapshot().supervision_epoch, 0);
      assert.equal(f.model.snapshot().fence_applied, true);
      assert.deepEqual(f.model.snapshot().queued_operation_ids, []);
      f.clock.time += 10;
      f.model.tick();
      assert.equal(f.model.snapshot().completed_effect_count, 0);
      assert.equal(f.model.snapshot().effect_facts[0]?.outcome, "stopped");
      assert.throws(
        () => f.model.install(f.lease, { ...f.context(), authority_epoch: 2 }),
        /EXECUTION_GRANT_REVOKED/,
      );
      assert.equal(f.model.authorityEpoch, 2);
      assert.throws(() => f.model.install(f.lease, context), /SCOPED_EPOCH_CONFLICT/);

      // A separate explicit grant may be admitted after real local cleanup, using controlled
      // module receipts only. This does not enable the Host's blocked persistence path.
      const fresh = freshGrant(f.lease);
      f.model.install(fresh, { ...f.context(), authority_epoch: 2 });
      assert.equal(f.model.snapshot().active_grant_ref, fresh.grant.grant_id);
      const work = f.execute(1);
      work.context.authority_epoch = 2;
      work.context.grant_ref = fresh.grant.grant_id;
      work.input.registration.grant_id = fresh.grant.grant_id;
      work.input.registration.payload_digest = payloadDigest({
        session_id: fresh.grant.session_id,
        grant_id: fresh.grant.grant_id,
        endpoint_instance_id: fresh.grant.endpoint_instance_id,
        action: work.input.action,
      });
      work.input.receipt.effect_digests = [payloadDigest(work.input.registration)];
      f.model.execute(work.input, work.context);
      f.clock.time += 10;
      f.model.tick();
      assert.equal(f.model.snapshot().completed_effect_count, 1);
      assert.equal(f.model.snapshot().effect_facts[0]?.completed_units, 0);
    } finally {
      await f.fixture.cleanup();
    }
  }
});

test("p0.endpoint module: full lease ledger cannot retain effects after valid authority advance", async () => {
  const f = await modelFixture();
  try {
    for (let index = 0; index < 128; index++)
      f.model.install({ ...f.lease, lease_id: randomUUID() }, f.context());
    const work = f.execute();
    f.model.execute(work.input, work.context);
    assert.throws(
      () => f.model.install(freshGrant(f.lease), { ...f.context(), authority_epoch: 1 }),
      /QUEUE_LIMIT_EXCEEDED/,
    );
    assert.equal(f.model.authorityEpoch, 1);
    assert.equal(f.model.snapshot().supervision_epoch, 0);
    assert.equal(f.model.snapshot().fence_applied, true);
    f.clock.time += 10;
    f.model.tick();
    assert.equal(f.model.snapshot().completed_effect_count, 0);
    assert.deepEqual(f.model.snapshot().queued_operation_ids, []);
  } finally {
    await f.fixture.cleanup();
  }
});

test("p0.endpoint module: invalid identity, mapping, fence or lease replay cannot advance authority", async () => {
  const f = await modelFixture();
  try {
    f.model.install(f.lease, f.context());
    const work = f.execute();
    f.model.execute(work.input, work.context);
    const before = f.model.snapshot();
    const cases: Array<(lease: P0EndpointLease, context: CommandContext) => void> = [
      (_lease, context) => {
        context.caller_instance_id = "impostor";
      },
      (_lease, context) => {
        context.object_ref.id = "other-session";
      },
      (lease) => {
        lease.grant.endpoint_instance_id = "old-endpoint";
      },
      (lease) => {
        lease.grant.supervisor_instance_id = "old-supervisor";
      },
      (lease) => {
        lease.grant.host_instance_id = "old-host";
      },
      (lease) => {
        lease.grant.session_id = "other-session";
      },
      (lease) => {
        lease.mapping.target_instance_id = "old-endpoint";
      },
      (lease) => {
        lease.mapping.source_instance_id = "old-supervisor";
      },
      (lease) => {
        lease.mapping.target_valid_until_ms = 99;
      },
      (lease) => {
        lease.mapping.offset_lower_ms++;
      },
      (_lease, context) => {
        context.deadline.expires_at_ms = 99;
        context.deadline.issued_at_ms = 90;
      },
      (_lease, context) => {
        context.deadline.clock_domain = "wrong-clock";
      },
      (lease) => {
        lease.local_lease_deadline.expires_at_ms--;
      }, // Same lease_id, changed complete input.
    ];
    for (const change of cases) {
      const lease = structuredClone(f.lease);
      const context = { ...f.context(), authority_epoch: 1 };
      change(lease, context);
      assert.throws(() => f.model.install(lease, context));
      assert.equal(f.model.authorityEpoch, 0);
      assert.deepEqual(f.model.snapshot(), before);
    }
    const revoke: P0EndpointRevokeInput = {
      session_id: f.config.session_id,
      grant_id: f.lease.grant.grant_id,
      endpoint_instance_id: f.config.endpoint_instance_id,
      supervisor_instance_id: f.supervisor.public.instance_id,
      supervision_epoch: 0,
      fence: { scope_type: "session", scope_id: f.config.session_id, cancel_epoch: 1 },
      stop_operation_id: randomUUID(),
      reason: "operator_request",
      mapping: f.supervisorMapping,
    };
    for (const change of [
      (value: P0EndpointRevokeInput) => {
        value.fence.scope_id = "other-session";
      },
      (value: P0EndpointRevokeInput) => {
        value.fence.scope_type = "activity";
      },
      (value: P0EndpointRevokeInput) => {
        value.fence.cancel_epoch = 0;
      },
      (value: P0EndpointRevokeInput) => {
        value.endpoint_instance_id = "old-endpoint";
      },
    ]) {
      const invalid = structuredClone(revoke);
      change(invalid);
      assert.throws(() => f.model.revoke(invalid, { ...f.context(), authority_epoch: 1 }));
      assert.equal(f.model.authorityEpoch, 0);
      assert.deepEqual(f.model.snapshot(), before);
    }
    f.model.revoke(revoke, { ...f.context(), authority_epoch: 1 });
    assert.equal(f.model.authorityEpoch, 1);
    assert.equal(f.model.snapshot().supervision_epoch, 0);
    f.clock.time += 10;
    f.model.tick();
    assert.equal(f.model.snapshot().completed_effect_count, 0);
  } finally {
    await f.fixture.cleanup();
  }
});

test("p0.endpoint protocol module: authentication and replay precede advance; both ordinary ledgers follow its fence", async () => {
  for (const reconnect of [false, true]) {
    const f = await modelFixture();
    const protocol = new EndpointProtocol(f.config, f.endpoint, f.clock);
    const connections: RpcConnection[] = [];
    const source = new ControlledClock("controlled-supervisor");
    const connect = async () => {
      const toEndpoint = new PassThrough();
      const toClient = new PassThrough();
      const server = new JsonChannel(toEndpoint, toClient, f.config.limits.max_message_bytes, 16);
      const client = new JsonChannel(toClient, toEndpoint, f.config.limits.max_message_bytes, 16);
      const ready = RpcConnection.fromChannel(
        client,
        f.endpoint.public,
        f.config.limits,
        f.supervisor.public.instance_id,
        source,
        source.now(),
        f.supervisor.public,
      );
      protocol.accept(server, "supervisor");
      const connection = await ready;
      connections.push(connection);
      // Only this controlled module fixture reads the model's authority directly.
      connection.onEndpointFact(
        () => {},
        () => protocol.model.authorityEpoch,
      );
      return connection;
    };
    try {
      protocol.model.handshake(f.hostMapping);
      const spoof = await connect();
      const impostor = generateIdentity("supervisor");
      impostor.public.instance_id = f.supervisor.public.instance_id;
      await assert.rejects(spoof.authenticatePeer(impostor), /AUTHENTICATION_REQUIRED/);
      assert.equal(protocol.model.authorityEpoch, 0);
      let safety = await connect();
      await safety.authenticatePeer(f.supervisor);
      const lease = structuredClone(f.lease);
      lease.mapping = safety.mapping;
      const initial = completeRequest("endpoint.lease", lease, safety.context());
      await safety.request(initial);
      const work = f.execute();
      protocol.model.execute(work.input, work.context);
      const before = protocol.model.snapshot();

      const conflict = completeRequest("endpoint.lease", lease, {
        ...initial.params.context,
        authority_epoch: 1,
      });
      await assert.rejects(safety.request(conflict), /OPERATION_PAYLOAD_CONFLICT/);
      assert.equal(protocol.model.authorityEpoch, 0);
      assert.deepEqual(protocol.model.snapshot(), before);
      const crossLedgerConflict = async () => {
        await assert.rejects(
          safety.request(
            completeRequest(
              "endpoint.revoke",
              {
                session_id: f.config.session_id,
                grant_id: lease.grant.grant_id,
                endpoint_instance_id: f.config.endpoint_instance_id,
                supervisor_instance_id: f.supervisor.public.instance_id,
                supervision_epoch: 0,
                fence: { scope_type: "session", scope_id: f.config.session_id, cancel_epoch: 1 },
                stop_operation_id: randomUUID(),
                reason: "operator_request",
                mapping: safety.mapping,
              },
              {
                ...safety.context(),
                operation_id: initial.params.context.operation_id,
                authority_epoch: 1,
              },
            ),
          ),
          /OPERATION_PAYLOAD_CONFLICT/,
        );
        assert.equal(protocol.model.authorityEpoch, 0);
        assert.deepEqual(protocol.model.snapshot(), before);
      };
      await crossLedgerConflict();
      for (const mutate of [
        (value: P0EndpointLease) => {
          value.grant.endpoint_instance_id = "old-instance";
        },
        (value: P0EndpointLease) => {
          value.mapping.announcement_digest = "f".repeat(64);
        },
        (value: P0EndpointLease) => {
          value.mapping.target_valid_until_ms = 99;
        },
      ]) {
        const invalid = freshGrant(lease);
        mutate(invalid);
        await assert.rejects(
          safety.request(
            completeRequest("endpoint.lease", invalid, { ...safety.context(), authority_epoch: 1 }),
          ),
        );
        assert.equal(protocol.model.authorityEpoch, 0);
        assert.deepEqual(protocol.model.snapshot(), before);
      }
      // The initial lease occupies one ordinary history/mutation slot.
      for (let index = 0; index < 127; index++) {
        // PassThrough delivers replies synchronously; allow its bounded write callbacks to drain
        // just as socket I/O does, so this case fills history rather than the transport write queue.
        await new Promise<void>((resolve) => setImmediate(resolve));
        const context = safety.context();
        await safety.request(
          completeRequest(
            "fault.apply",
            {
              fault_id: randomUUID(),
              session_id: f.config.session_id,
              target_instance_id: f.config.endpoint_instance_id,
              selection: { target: "endpoint", fault: "none", duration_ms: 0 },
              mapping: safety.mapping,
              deadline: context.deadline,
            },
            context,
          ),
        );
      }
      if (reconnect) {
        // A fresh authenticated connection removes per-connection history pressure only.
        safety.close();
        safety = await connect();
        await safety.authenticatePeer(f.supervisor);
        await crossLedgerConflict();
        const globalConflict = freshGrant(lease);
        globalConflict.mapping = safety.mapping;
        await assert.rejects(
          safety.request(
            completeRequest("endpoint.lease", globalConflict, {
              ...safety.context(),
              operation_id: initial.params.context.operation_id,
              authority_epoch: 1,
            }),
          ),
          /OPERATION_PAYLOAD_CONFLICT/,
        );
        assert.equal(protocol.model.authorityEpoch, 0);
      }
      const next = freshGrant(lease);
      next.mapping = safety.mapping;
      await assert.rejects(
        safety.request(
          completeRequest("endpoint.lease", next, { ...safety.context(), authority_epoch: 1 }),
        ),
        /QUEUE_LIMIT_EXCEEDED/,
      );
      assert.equal(protocol.model.authorityEpoch, 1);
      assert.equal(protocol.model.snapshot().supervision_epoch, 0);
      assert.equal(protocol.model.snapshot().fence_applied, true);
      f.clock.time += 10;
      protocol.model.tick();
      assert.equal(protocol.model.snapshot().completed_effect_count, 0);
      assert.deepEqual(protocol.model.snapshot().queued_operation_ids, []);
      const queried = await safety.request(
        completeRequest(
          "simulation.query",
          {
            session_id: f.config.session_id,
            endpoint_instance_id: f.config.endpoint_instance_id,
            mapping: safety.mapping,
          },
          { ...safety.context(), authority_epoch: 1 },
        ),
      );
      assert.deepEqual(queried, protocol.model.snapshot());
    } finally {
      for (const connection of connections) connection.close();
      await protocol.close();
      await f.fixture.cleanup();
    }
  }
});

test("p0.endpoint module: bounded actual units, duplicate/conflict, receipt/action binding and grant fencing", async () => {
  const f = await modelFixture();
  try {
    const op = f.execute();
    assert.throws(() => f.model.execute(op.input, op.context), /EXECUTION_GRANT_REVOKED/);
    f.model.install(f.lease, f.context());
    const changed = structuredClone(op);
    changed.input.action.interval_ms++;
    assert.throws(
      () => f.model.execute(changed.input, changed.context),
      /OPERATION_PAYLOAD_CONFLICT/,
    );
    const noReceipt = structuredClone(op);
    noReceipt.input.receipt.effect_digests = [];
    assert.throws(
      () => f.model.execute(noReceipt.input, noReceipt.context),
      /PERSISTENCE_NOT_READY/,
    );
    f.model.execute(op.input, op.context);
    f.clock.time += 10;
    f.model.tick();
    assert.equal(f.model.snapshot().completed_effect_count, 1);
    f.model.execute(op.input, op.context);
    assert.equal(f.model.snapshot().accepted_watermark, 1);
    f.clock.time += 10;
    f.model.tick();
    assert.equal(f.model.snapshot().completed_effect_count, 2);
    const second = f.execute();
    f.model.execute(second.input, second.context);
    const before = f.model.snapshot().host_connection_deadline;
    f.model.fence();
    f.clock.time += 50;
    f.model.tick();
    const fact = f.model.snapshot();
    assert.equal(fact.completed_effect_count, 2);
    assert.equal(fact.effect_facts[0]?.outcome, "completed");
    assert.equal(fact.effect_facts[1]?.outcome, "stopped");
    assert.deepEqual(fact.host_connection_deadline, before);
    assert.deepEqual(fact.not_executed_operation_ids, [second.context.operation_id]);
    assert.throws(
      () => f.model.install({ ...f.lease, lease_id: randomUUID() }, f.context()),
      /EXECUTION_GRANT_REVOKED/,
    );
    f.model.disconnect();
    assert.equal(f.model.snapshot().host_connection_deadline, null);
  } finally {
    await f.fixture.cleanup();
  }
});

test("p0.endpoint module: instance/epoch/scope/budget/lease and explicit renewal bounds", async () => {
  const f = await modelFixture();
  try {
    const wrong = structuredClone(f.lease);
    wrong.grant.endpoint_instance_id = "old-instance";
    assert.throws(() => f.model.install(wrong, f.context()), /ROLE_SCOPE_DENIED/);
    f.model.install(f.lease, f.context());
    const wrongEpoch = f.execute();
    wrongEpoch.context.authority_epoch = 1;
    assert.throws(
      () => f.model.execute(wrongEpoch.input, wrongEpoch.context),
      /SCOPED_EPOCH_CONFLICT/,
    );
    const overflow = f.execute(17);
    assert.throws(() => f.model.execute(overflow.input, overflow.context), /COST_BUDGET_EXCEEDED/);
    const wrongTarget = f.execute();
    wrongTarget.input.action.target_ref = { kind: "SimulationCounter", id: "other" };
    assert.throws(
      () => f.model.execute(wrongTarget.input, wrongTarget.context),
      /SIMULATION_SCOPE_DENIED/,
    );
    const renew = structuredClone(f.lease);
    renew.lease_id = randomUUID();
    renew.human_lease_deadline.expires_at_ms = 1800;
    f.model.install(renew, f.context());
    const changed = structuredClone(renew);
    changed.local_lease_deadline.expires_at_ms--;
    assert.throws(() => f.model.install(changed, f.context()), /OPERATION_PAYLOAD_CONFLICT/);
    const extendGrant = structuredClone(renew);
    extendGrant.lease_id = randomUUID();
    extendGrant.deadline.expires_at_ms = 1950;
    assert.throws(() => f.model.install(extendGrant, f.context()), /CLOCK_MAPPING_INVALID/);
    const op = f.execute();
    f.model.execute(op.input, op.context);
    f.clock.time = 601;
    f.model.tick();
    assert.equal(f.model.snapshot().completed_effect_count, 0);
    assert.ok(f.model.snapshot().host_connection_deadline);
    assert.equal(f.model.snapshot().fence_applied, true);
    const sameRevision = f.model.snapshot();
    f.clock.time++;
    assert.deepEqual(f.model.snapshot(), sameRevision);
  } finally {
    await f.fixture.cleanup();
  }
});

test("p0.endpoint production: fixed Host stdio plus independent Supervisor safety, zero authority and host EOF", {
  timeout: 15000,
}, async () => {
  const fixture = await createProductionFixture();
  const m = await endpointMaterials(fixture);
  const clock = new MonotonicClock();
  const facts: unknown[] = [];
  let child: Awaited<ReturnType<typeof launchEndpoint>> | undefined;
  let safety: RpcConnection | undefined;
  try {
    child = await launchEndpoint(m.config, m.host, clock, (fact) => facts.push(fact));
    safety = await RpcConnection.connect(
      m.config.safety_socket_path,
      m.endpoint.public,
      m.config.limits,
      m.supervisor.public.instance_id,
      clock,
      m.supervisor.public,
    );
    safety.onEndpointFact(
      (fact) => facts.push(fact),
      () => 0,
    );
    await safety.authenticatePeer(m.supervisor);
    const initial = await queryEndpoint(safety, m.config);
    assert.equal(initial.completed_effect_count, 0);
    assert.equal(initial.active_grant_ref, null);
    assert.ok(initial.host_connection_deadline);
    assert.equal(initial.accepted_watermark, 0);
    const noGrantContext = child.connection.context();
    noGrantContext.grant_ref = "never-issued";
    const action = {
      target_ref: { kind: "SimulationCounter", id: "fixture-counter" },
      capability: "simulation.execute",
      units: 1,
      interval_ms: 10,
      cost_units: 0,
    };
    const registration = {
      operation_id: noGrantContext.operation_id,
      session_id: m.config.session_id,
      grant_id: "never-issued",
      endpoint_instance_id: m.config.endpoint_instance_id,
      target_ref: action.target_ref,
      capability: action.capability,
      units: 1,
      cost_units: 0,
      payload_digest: payloadDigest({
        session_id: m.config.session_id,
        grant_id: "never-issued",
        endpoint_instance_id: m.config.endpoint_instance_id,
        action,
      }),
      deadline: {
        clock_domain: clock.domain,
        issued_at_ms: clock.now(),
        expires_at_ms: clock.now() + 500,
      },
      registered_at: clock.point(),
    };
    await assert.rejects(
      child.connection.request(
        completeRequest(
          "simulation.execute",
          {
            registration,
            action,
            mapping: child.connection.mapping,
            receipt: {
              receipt_id: "not-a-receipt",
              writer_instance_id: "not-a-writer",
              transaction_id: "not-a-transaction",
              request_digest: "0".repeat(64),
              committed_at: clock.point(),
              database_version: 1,
              grant_digests: [],
              admission_digests: [],
              effect_digests: [payloadDigest(registration)],
            },
          },
          noGrantContext,
        ),
      ),
      /EXECUTION_GRANT_REVOKED/,
    );
    assert.throws(() => child?.connection.peerCall("endpoint.lease", {}), /RpcRequest/);
    const bad = generateIdentity("host");
    const attacker = await RpcConnection.connect(
      m.config.safety_socket_path,
      m.endpoint.public,
      m.config.limits,
      bad.public.instance_id,
      clock,
      m.supervisor.public,
    );
    try {
      await assert.rejects(attacker.authenticatePeer(bad), /AUTHENTICATION_REQUIRED/);
    } finally {
      attacker.close();
    }
    const wrong = safety.context();
    wrong.authority_epoch = 2;
    await assert.rejects(
      safety.request(
        completeRequest(
          "simulation.query",
          {
            session_id: m.config.session_id,
            endpoint_instance_id: m.config.endpoint_instance_id,
            mapping: safety.mapping,
          },
          wrong,
        ),
      ),
      /SCOPED_EPOCH_CONFLICT/,
    );
    child.connection.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stopped = await queryEndpoint(safety, m.config);
    assert.equal(stopped.host_connection_deadline, null);
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.completed_effect_count, 0);
    await safety.peerCall("controller.dispose", { instance_id: m.config.endpoint_instance_id });
    assert.ok(facts.length > 0);
  } finally {
    safety?.close();
    child?.connection.close();
    if (child) await terminateChild(child.child);
    await fixture.cleanup();
  }
});

test("p0.endpoint production: actual Host SIGKILL leaves Supervisor safety queries and clean counter facts", {
  timeout: 15000,
}, async () => {
  const fixture = await createProductionFixture();
  let runtime: Awaited<ReturnType<typeof startSupervisor>> | undefined;
  try {
    runtime = await startSupervisor(fixture.configPath);
    const first = await runCli(fixture.configPath, "query");
    assert.equal(first.code, 0, first.stderr);
    const before = JSON.parse(first.stdout).result;
    assertValid("P0SessionSnapshot", before);
    assert.ok(before.endpoint.fact?.host_connection_deadline);
    runtime.host.kill("SIGKILL");
    await new Promise<void>((resolve) => runtime?.host.once("exit", () => resolve()));
    await new Promise((resolve) =>
      setTimeout(resolve, Math.floor(fixture.config.limits.peer_health_timeout_ms / 3) + 50),
    );
    const last = await runCli(fixture.configPath, "query");
    assert.equal(last.code, 0, last.stderr);
    const after = JSON.parse(last.stdout).result;
    assertValid("P0SessionSnapshot", after);
    assert.equal(after.endpoint.quality, "fresh");
    assert.equal(after.endpoint.fact?.host_connection_deadline, null);
    assert.equal(after.endpoint.fact?.completed_effect_count, 0);
    assert.equal(after.endpoint.fact?.stopped, true);
    assert.equal(after.persistence, "blocked");
    assert.deepEqual(after.grants, []);
  } finally {
    await runtime?.close();
    await fixture.cleanup();
  }
});
