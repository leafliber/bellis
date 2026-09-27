import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  assertValid,
  bindVerifiedP0Installation,
  type CommandContext,
  type ExecutionGrant,
  type P0DurableBatch,
  type P0EndpointSnapshot,
  type P0IsolationRecord,
  type P0OperatorCredential,
  type P0RuntimeConfig,
  type P0StoreCommitInput,
  payloadDigest,
  type RuntimeProfile,
  schemaDigest,
} from "../packages/contract-sdk/src/index.ts";
import { clockMapping, MonotonicClock, mappedDeadline } from "../packages/runtime/src/clock.ts";
import {
  announce,
  announcementEvent,
  ConnectionAuthentication,
  completeRequest,
  generateIdentity,
  operatorRequest,
  peerRequest,
} from "../packages/runtime/src/identity.ts";
import { ObservationWriter } from "../packages/runtime/src/observation.ts";
import { P0Reducer } from "../packages/runtime/src/p0-reducer.ts";
import { limits, syntheticManifest } from "./p0-identity.helpers.ts";

/** Controlled same-module evidence only: no Worker, transport, SUT or timing claim. */
export class ModuleClock extends MonotonicClock {
  time = 1000;
  override now(): number {
    return this.time;
  }
}
export const moduleReductions: import("../packages/contract-sdk/src/index.ts").P0ReductionObservation[] =
  [];
export function reducerFixture(isolation: P0IsolationRecord[] = [], targets = 1) {
  const clock = new ModuleClock("module-supervisor-clock");
  const host = generateIdentity("host"),
    supervisor = generateIdentity("supervisor"),
    endpoint = generateIdentity("endpoint");
  const endpointClock = new ModuleClock("module-endpoint-clock");
  const manifest = { ...syntheticManifest(), plugin_id: "bellis-p0-fake-device" };
  const profile = JSON.parse(
    readFileSync(new URL("../contracts/fixtures/runtime-profile.json", import.meta.url), "utf8"),
  ) as RuntimeProfile;
  profile.mode = "simulation";
  profile.enabled_phases = ["P0"];
  profile.enabled_capabilities = [{ name: "simulation.execute", version: "0.8.0" }];
  const target = { kind: "SimulationTarget", id: "counter" };
  const config: P0RuntimeConfig = {
    profile: { ...profile, mode: "simulation", enabled_phases: ["P0"] },
    public_broadcast_allowed: false,
    supervision_mode: "stopped",
    installation: {
      installation_id: "module-install",
      plugin_id: manifest.plugin_id,
      plugin_version: "0.8.0",
      entry: { path: "/module/endpoint.mjs", sha256: "a".repeat(64) },
      artifacts: [{ path: "/module/endpoint.mjs", sha256: "a".repeat(64) }],
      manifest_digest: payloadDigest(manifest),
      protocol_version: "0.8.0",
      schema_digest: schemaDigest,
      allowed_capabilities: profile.enabled_capabilities,
      allowed_targets: Array.from({ length: targets }, (_, n) =>
        n === 0 ? target : { ...target, id: `counter-${n}` },
      ),
      execution_mode: "simulation",
      external_effects_allowed: false,
    },
    operator_credentials_path: "/module/operator.json",
    service_identity_key_path: "/module/supervisor.pem",
    management_socket_path: "/module/supervisor.sock",
    safety_socket_path: "/module/safety.sock",
    database_path: "/module/db.sqlite",
    limits: { ...limits, max_message_bytes: 65536, max_clock_error_ms: 10 },
    fault_injection_enabled: false,
  };
  const lines: unknown[] = [];
  const writer = new ObservationWriter(
    "supervisor",
    supervisor.public.instance_id,
    clock,
    config.limits,
    {
      write: (bytes, done) => {
        const value = JSON.parse(bytes.toString());
        lines.push(value);
        if (value.record_type === "p0-reduction-observation") moduleReductions.push(value);
        done();
      },
    },
  );
  const core = new P0Reducer({
    session: "module-session",
    host: host.public,
    supervisor: supervisor.public,
    endpoint: endpoint.public,
    worker: "module-worker",
    config,
    installation: { manifest, context: bindVerifiedP0Installation(config.installation) },
    clock,
    observation: writer,
    isolation,
  });
  const credential: P0OperatorCredential = {
    credential_id: "module-credential",
    operator_id: "module-operator",
    role: "operator",
    authentication_key_sha256: "c".repeat(64),
  };
  let snapshot: P0EndpointSnapshot = {
    endpoint_instance_id: endpoint.public.instance_id,
    session_id: "module-session",
    supervisor_instance_id: supervisor.public.instance_id,
    supervision_epoch: 0,
    source_revision: 0,
    observed_at: endpointClock.point(),
    active_grant_ref: null,
    lease_deadline: null,
    fence_applied: true,
    stopped: true,
    accepted_watermark: 0,
    completed_effect_count: 0,
    queued_operation_ids: [],
    effect_facts: [],
    not_executed_operation_ids: [],
    unknown_operation_ids: [],
    cleanup_ref: null,
    host_connection_deadline: {
      clock_domain: endpointClock.domain,
      issued_at_ms: 1000,
      expires_at_ms: 4900,
    },
  };
  function command(
    method: string,
    input: object,
    operation: string = randomUUID(),
    deadline?: CommandContext["deadline"],
  ) {
    const client = new ModuleClock(`operator-${randomUUID()}`);
    client.time = clock.time;
    const instance = randomUUID();
    const a = announce(
      supervisor,
      "module-session",
      clock,
      4000,
      supervisor.public,
      core.authorityEpoch,
    );
    const mapping = clockMapping(a, client, instance, client.now(), client.now(), config.limits);
    const context: CommandContext = {
      operation_id: operation,
      payload_digest: "0".repeat(64),
      caller_instance_id: instance,
      authority_epoch: core.authorityEpoch,
      object_ref: { kind: "Session", id: "module-session" },
      deadline: deadline ?? mappedDeadline(mapping, client.now(), 1500),
      grant_ref: "grant_id" in input ? String(input.grant_id) : null,
    };
    const request = operatorRequest(method, { ...input, mapping }, context, a, credential);
    const authenticated = new ConnectionAuthentication(a).operator(
      request,
      credential,
      clock.now(),
    );
    const trigger = writer.requestReceived(a.connection_id, request);
    if (!trigger) throw new Error("MISSING_MODULE_TRIGGER");
    const identity = {
      credential_id: authenticated.credential_id,
      operator_id: authenticated.operator_id,
      role: authenticated.role,
      connection_id: a.connection_id,
      authenticated_at: clock.point(),
    };
    return {
      token: core.command(request, identity, a, trigger),
      request,
      identity,
      announcement: a,
      trigger,
    };
  }
  function health() {
    const client = new ModuleClock("module-host-clock");
    client.time = clock.time;
    const a = announce(
      supervisor,
      "module-session",
      clock,
      4000,
      supervisor.public,
      core.authorityEpoch,
    );
    const mapping = clockMapping(
      a,
      client,
      host.public.instance_id,
      client.now(),
      client.now(),
      config.limits,
    );
    const context: CommandContext = {
      operation_id: randomUUID(),
      payload_digest: "0".repeat(64),
      caller_instance_id: host.public.instance_id,
      authority_epoch: core.authorityEpoch,
      object_ref: { kind: "Session", id: "module-session" },
      deadline: mappedDeadline(mapping, client.now(), 1000),
      grant_ref: null,
    };
    const auth = new ConnectionAuthentication(a);
    const peer = auth.peer(peerRequest({ mapping }, context, a, host), [host.public], clock.now());
    const request = completeRequest(
      "supervisor.health",
      {
        session_id: "module-session",
        peer_instance_id: host.public.instance_id,
        peer_role: "host",
        mapping,
      },
      context,
    );
    const trigger = writer.requestReceived(a.connection_id, request);
    if (!trigger) throw new Error("MISSING_MODULE_TRIGGER");
    return core.health(request, peer, a, trigger);
  }
  function endpointSource(change: Partial<P0EndpointSnapshot> = {}) {
    endpointClock.time = clock.time;
    snapshot = {
      ...snapshot,
      source_revision: snapshot.source_revision + 1,
      observed_at: endpointClock.point(),
      ...structuredClone(change),
    };
    const a = announce(
      endpoint,
      "module-session",
      endpointClock,
      4000,
      supervisor.public,
      core.authorityEpoch,
    );
    const mapping = clockMapping(
      a,
      clock,
      supervisor.public.instance_id,
      clock.now(),
      clock.now(),
      config.limits,
    );
    const context: CommandContext = {
      operation_id: randomUUID(),
      payload_digest: "0".repeat(64),
      caller_instance_id: supervisor.public.instance_id,
      authority_epoch: core.authorityEpoch,
      object_ref: { kind: "Session", id: "module-session" },
      deadline: mappedDeadline(mapping, clock.now(), 1000),
      grant_ref: null,
    };
    new ConnectionAuthentication(a).peer(
      peerRequest({ mapping }, context, a, supervisor),
      [supervisor.public],
      endpointClock.now(),
    );
    const request = completeRequest(
      "simulation.query",
      { session_id: "module-session", endpoint_instance_id: endpoint.public.instance_id, mapping },
      context,
    );
    return {
      announcement: announcementEvent(a),
      mapping,
      delivery: {
        kind: "query" as const,
        request,
        response: { jsonrpc: "2.0", id: request.id, result: structuredClone(snapshot) },
      },
    };
  }
  const fact = (change: Partial<P0EndpointSnapshot> = {}) =>
    core.endpointFact(endpointSource(change));
  function authorize(overrides: object = {}, operation?: string) {
    const input = {
      session_id: "module-session",
      endpoint_instance_id: endpoint.public.instance_id,
      mode: "simulation",
      supervision_mode: "supervised",
      target_refs: [target],
      allowed_capabilities: profile.enabled_capabilities,
      effect_limit: 8,
      queue_limit: 4,
      cost_limit_units: 8,
      human_lease_deadline: {
        clock_domain: clock.domain,
        issued_at_ms: clock.now(),
        expires_at_ms: clock.now() + 1000,
      },
      grant_deadline: {
        clock_domain: clock.domain,
        issued_at_ms: clock.now(),
        expires_at_ms: clock.now() + 1200,
      },
      public_broadcast_allowed: false,
      ...overrides,
    };
    const cmd = command("session.authorize", input, operation);
    return { ...cmd, ...core.requestGrant(cmd.token) };
  }
  function receipt(grant: ExecutionGrant) {
    const admission = core.admission(grant.grant_id);
    if (!admission) throw new Error("NO_ADMISSION");
    const batch: P0DurableBatch = {
      supervision: null,
      grants: [grant],
      admissions: [{ ...admission, record_status: "durable" }],
      effects: [],
      stops: [],
      cleanup: [],
      isolation: [],
      outbox: [],
    };
    const input: P0StoreCommitInput = {
      request_id: randomUUID(),
      writer_instance_id: "module-worker",
      batch,
    };
    const receipt = {
      receipt_id: randomUUID(),
      writer_instance_id: "module-worker",
      transaction_id: input.request_id,
      request_digest: payloadDigest(input),
      committed_at: clock.point(),
      database_version: 1,
      grant_digests: batch.grants.map(payloadDigest),
      admission_digests: batch.admissions.map(payloadDigest),
      effect_digests: [],
    };
    assertValid("P0PersistenceReceipt", receipt);
    return { input, receipt, token: core.workerReceipt(input, receipt) };
  }
  function active(overrides: object = {}) {
    health();
    fact();
    const requested = authorize(overrides);
    if (!requested.grant) throw new Error("MODULE_AUTHORIZE_REJECTED");
    const decision = core.reduceGrant(
      requested.grant.grant_id,
      "approve",
      receipt(requested.grant).token,
    );
    if (decision.disposition !== "accepted") throw new Error("MODULE_APPROVE_REJECTED");
    const grant = core.grant(requested.grant.grant_id);
    if (!grant) throw new Error("NO_GRANT");
    core.bindActiveCommit(grant.grant_id, receipt(grant).token);
    fact({
      active_grant_ref: grant.grant_id,
      supervision_epoch: grant.supervision_epoch,
      fence_applied: false,
      lease_deadline: {
        clock_domain: endpointClock.domain,
        issued_at_ms: clock.now(),
        expires_at_ms: clock.now() + 500,
      },
    });
    return grant;
  }
  const stop = () =>
    command("session.stop", {
      session_id: "module-session",
      target_ref: target,
      reason: "operator_request",
    });
  const completed = (grant: ExecutionGrant, units = 2) => {
    const action = {
      target_ref: target,
      capability: "simulation.execute" as const,
      units,
      interval_ms: 10,
      cost_units: 1,
    };
    const registration = {
      operation_id: randomUUID(),
      session_id: "module-session",
      grant_id: grant.grant_id,
      endpoint_instance_id: endpoint.public.instance_id,
      target_ref: target,
      capability: "simulation.execute" as const,
      payload_digest: payloadDigest({
        session_id: "module-session",
        grant_id: grant.grant_id,
        endpoint_instance_id: endpoint.public.instance_id,
        action,
      }),
      units,
      cost_units: 1,
      deadline: {
        clock_domain: "module-host-clock",
        issued_at_ms: clock.now(),
        expires_at_ms: clock.now() + 400,
      },
      registered_at: clock.point(),
    };
    core.trackEffect({ registration, action });
    const effect = {
      operation_id: registration.operation_id,
      endpoint_instance_id: endpoint.public.instance_id,
      grant_id: grant.grant_id,
      target_ref: target,
      payload_digest: registration.payload_digest,
      accepted_seq: 1,
      requested_units: units,
      completed_units: units,
      outcome: "completed" as const,
      occurred_at: endpointClock.point(),
      deadline_missed: false,
    };
    return { registration, action, effect };
  };
  return {
    core,
    clock,
    endpointClock,
    host,
    supervisor,
    endpoint,
    config,
    target,
    writer,
    lines,
    command,
    health,
    endpointSource,
    fact,
    authorize,
    receipt,
    active,
    stop,
    completed,
    currentFact: () => structuredClone(snapshot),
  };
}
export type Fixture = ReturnType<typeof reducerFixture>;
export function reductions(f: Fixture) {
  return f.lines.filter(
    (line): line is import("../packages/contract-sdk/src/index.ts").P0ReductionObservation =>
      !!line &&
      typeof line === "object" &&
      "record_type" in line &&
      line.record_type === "p0-reduction-observation",
  );
}
