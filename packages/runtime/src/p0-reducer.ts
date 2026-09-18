import { randomUUID } from "node:crypto";
import { stateMachines } from "../../../contracts/generated/registries.ts";
import {
  assertValid,
  type ClockPoint,
  type ExecutionGrant,
  type ObjectRef,
  type P0AdmissionRecord,
  type P0CleanupRecord,
  type P0ClockMapping,
  type P0ConnectionAnnouncement,
  type P0EndpointSnapshot,
  type P0IsolationRecord,
  type P0OperatorIdentity,
  type P0PeerIdentity,
  type P0PersistenceReceipt,
  type P0ProcessObservation,
  type P0ProtocolObservation,
  type P0ReductionObservation,
  type P0RuntimeConfig,
  type P0SessionSnapshot,
  type P0StoreCommitInput,
  payloadDigest,
  type RpcEvent,
  type RpcRequest,
  type StopOperationRecord,
  type SupervisionRecord,
  schemaDigest,
  validateManifest,
  validateProfile,
  validateRpcResponse,
} from "../../contract-sdk/src/index.ts";
import { checkDeadline, type MonotonicClock, validateMapping } from "./clock.ts";
import type { VerifiedInstallation } from "./config.ts";
import { reject } from "./errors.ts";
import { authenticationDigest, verifyAnnouncement } from "./identity.ts";
import { type CommandTrigger, type ObservationWriter, observationTrigger } from "./observation.ts";
import {
  committed,
  type EffectEntry,
  type EndpointFact,
  endpointConnectionUpper,
  endpointDeadlinesValid,
  executionGrant,
  type GuardState,
  humanRenewal,
  localEffectStopped,
  type OperatorFact,
  outputsSafe,
  resourceKey,
  same,
  supervisedEntry,
  type TrackedEffect,
  type WorkerFact,
} from "./p0-guards.ts";

type Machine = P0ReductionObservation["machine"];
type Binding = Pick<
  P0ReductionObservation,
  "trigger_kind" | "trigger_id" | "trigger_digest" | "timer_deadline"
>;
/** Opaque per-reducer token; callers cannot supply guard values, timers or trigger digests. */
export type P0Input = Readonly<{ kind: Binding["trigger_kind"] }>;
type Input = {
  binding: Binding;
  operator: OperatorFact | null;
  worker: WorkerFact | null;
  endpoint: EndpointFact | null;
  safety: "operator" | "peer" | "failure" | "timer" | "fact" | "worker";
  healthLost?: "host" | "endpoint";
};
export type Reduction = {
  machine: Machine;
  object_ref: ObjectRef;
  from: string;
  event: string;
  to: string;
  guard: string | null;
  guard_result: boolean | null;
  disposition: P0ReductionObservation["disposition"];
};
export type SafetyAction =
  | { kind: "endpoint_revoke"; authority_epoch: number; stop: StopOperationRecord }
  | { kind: "query_cleanup"; cleanup_id: string; endpoint_instance_id: string }
  | { kind: "persist"; object_ref: ObjectRef };
export type ReducerOptions = {
  session: string;
  host: P0PeerIdentity;
  supervisor: P0PeerIdentity;
  endpoint: P0PeerIdentity;
  worker: string | null;
  config: P0RuntimeConfig;
  installation: VerifiedInstallation;
  clock: MonotonicClock;
  observation?: ObservationWriter;
  /** Historical isolation is never cleared by a new instance's zero counters. */
  isolation?: readonly P0IsolationRecord[];
};
export type P0Timer = Readonly<{
  owner_instance_id: string;
  object_ref: ObjectRef;
  machine: Machine;
  event: string;
  deadline: ClockPoint;
  basis: "object" | "human" | "host_health" | "endpoint_health" | "endpoint_connection";
  basis_digest: string;
}>;
type GrantEntry = {
  grant: ExecutionGrant;
  admission: P0AdmissionRecord;
  operator: OperatorFact;
  authorityEpoch: number;
  activeReceipt: WorkerFact | null;
};

/** Dedicated P0 synchronous owner. No I/O, auto recovery, execution dispatch or persistence stub.
 * All channel authentication remains in the actual service/connection; methods below accept
 * only its internal validated facts, and recheck their concrete bindings. Seven grants plus
 * one initial target set reserve at most 128 stops/cleanup/isolation (16 targets per set).
 * Effects are bounded by the endpoint's 1024-history limit. Safety uses reserved slots and
 * never waits on a business queue, budget or Worker. Returned records are defensive copies.
 */
export class P0Reducer {
  readonly #o: ReducerOptions;
  readonly #createdAt: number;
  #authorityEpoch = 0;
  #cancelEpoch = 0;
  #supervision: SupervisionRecord;
  #supervisionDigest = "";
  #grants = new Map<string, GrantEntry>();
  #stops = new Map<string, StopOperationRecord>();
  #cleanup = new Map<string, P0CleanupRecord>();
  #isolation = new Map<string, P0IsolationRecord>();
  #reserved = new Map<
    string,
    { stop: string; cleanup: string; isolation: string; target: ObjectRef }
  >();
  #effects = new Map<string, TrackedEffect>();
  #localFenced = false;
  #endpoint: EndpointFact | null = null;
  #health: GuardState["hostHealth"] = null;
  #inputs = new WeakMap<P0Input, Input>();
  #timers = new WeakSet<P0Timer>();
  #actions = new Map<string, SafetyAction>();
  #operations = new Map<string, { digest: string; grant: string | null; decision: Reduction }>();
  #supervisionStopDeadline: ClockPoint | null = null;
  #persistence: P0SessionSnapshot["persistence"] = "blocked";

  constructor(options: ReducerOptions) {
    assertValid("P0RuntimeConfig", options.config);
    for (const p of [options.host, options.supervisor, options.endpoint])
      assertValid("P0PeerIdentity", p);
    if (
      options.host.role !== "host" ||
      options.supervisor.role !== "supervisor" ||
      options.endpoint.role !== "endpoint" ||
      new Set([
        options.host.instance_id,
        options.supervisor.instance_id,
        options.endpoint.instance_id,
      ]).size !== 3
    )
      reject("ROLE_SCOPE_DENIED");
    validateProfile(options.config.profile, options.installation.context);
    validateManifest(options.installation.manifest, undefined, options.installation.context);
    if (
      !same(options.config.installation, options.installation.context.installation) ||
      payloadDigest(options.installation.manifest) !== options.config.installation.manifest_digest
    )
      reject("INSTALLATION_IDENTITY_DENIED");
    this.#o = {
      ...options,
      config: structuredClone(options.config),
      host: structuredClone(options.host),
      supervisor: structuredClone(options.supervisor),
      endpoint: structuredClone(options.endpoint),
    };
    this.#createdAt = options.clock.now();
    this.#supervision = {
      session_id: options.session,
      supervision_epoch: 0,
      operator_id: null,
      human_lease_deadline: null,
      connection_healthy: false,
      grace_deadline: null,
      blocked_scopes: [],
      active_grant_refs: [],
      incident_ref: null,
      state: "stopped",
      supervisor_instance_id: options.supervisor.instance_id,
      host_instance_id: options.host.instance_id,
      source_revision: 0,
      record_status: "pending",
    };
    if ((options.isolation?.length ?? 0) > 16) throw new Error("P0_ISOLATION_CAPACITY");
    for (const record of options.isolation ?? []) {
      assertValid("P0IsolationRecord", record);
      if (this.#isolation.has(record.isolation_id)) throw new Error("P0_ISOLATION_CONFLICT");
      this.#isolation.set(record.isolation_id, structuredClone(record));
    }
    this.#reserve("initial", options.config.installation.allowed_targets);
    this.#refresh();
  }
  get authorityEpoch(): number {
    return this.#authorityEpoch;
  }
  get supervision(): SupervisionRecord {
    return structuredClone(this.#supervision);
  }
  grant(id: string): ExecutionGrant | undefined {
    return structuredClone(this.#grants.get(id)?.grant);
  }
  admission(id: string): P0AdmissionRecord | undefined {
    return structuredClone(this.#grants.get(id)?.admission);
  }
  /** Each persist action names one current record. W6 freezes its durable target and
   * the corresponding actual-fact Outbox entries in the same transaction. No batch,
   * Outbox success or durable state is fabricated by this synchronous owner. */
  persistenceRecord(
    ref: ObjectRef,
  ):
    | SupervisionRecord
    | ExecutionGrant
    | P0AdmissionRecord
    | StopOperationRecord
    | P0CleanupRecord
    | P0IsolationRecord {
    const record =
      ref.kind === "Session" && ref.id === this.#o.session
        ? this.#supervision
        : ref.kind === "ExecutionGrant"
          ? this.#grants.get(ref.id)?.grant
          : ref.kind === "P0AdmissionRecord"
            ? [...this.#grants.values()].find((g) => g.admission.admission_id === ref.id)?.admission
            : ref.kind === "StopOperation"
              ? this.#stops.get(ref.id)
              : ref.kind === "P0CleanupRecord"
                ? this.#cleanup.get(ref.id)
                : ref.kind === "P0IsolationRecord"
                  ? this.#isolation.get(ref.id)
                  : undefined;
    if (!record) throw new Error("P0_UNKNOWN_PERSISTENCE_RECORD");
    return structuredClone(record);
  }
  takeActions(): SafetyAction[] {
    const actions = [...this.#actions.values()];
    this.#actions.clear();
    return actions;
  }
  #action(...actions: SafetyAction[]): void {
    for (const action of actions) {
      const id =
        action.kind === "persist"
          ? payloadDigest(action.object_ref)
          : action.kind === "endpoint_revoke"
            ? action.stop.stop_operation_id
            : action.cleanup_id;
      this.#actions.set(`${action.kind}:${id}`, action);
    }
  }
  snapshot(): P0SessionSnapshot {
    const snapshot: P0SessionSnapshot = {
      session_id: this.#o.session,
      supervision: this.supervision,
      grants: [...this.#grants.values()].map((g) => structuredClone(g.grant)),
      admissions: [...this.#grants.values()].map((g) => structuredClone(g.admission)),
      stops: structuredClone([...this.#stops.values()]),
      cleanup: structuredClone([...this.#cleanup.values()]),
      isolation: structuredClone([...this.#isolation.values()]),
      endpoint: {
        source_instance_id: this.#o.endpoint.instance_id,
        received_at: {
          clock_domain: this.#o.clock.domain,
          monotonic_ms: this.#endpoint?.receivedAt ?? this.#createdAt,
        },
        quality: this.#endpoint
          ? this.#o.clock.now() - this.#endpoint.receivedAt <
            this.#o.config.limits.peer_health_timeout_ms
            ? "fresh"
            : "stale"
          : "unknown",
        fact: structuredClone(this.#endpoint?.snapshot ?? null),
      },
      persistence: this.#persistence,
      outbox_pending: 0,
    };
    assertValid("P0SessionSnapshot", snapshot);
    return snapshot;
  }
  #state(): GuardState {
    return {
      config: this.#o.config,
      session: this.#o.session,
      host: this.#o.host,
      supervisor: this.#o.supervisor,
      endpoint: this.#o.endpoint,
      worker: this.#o.worker,
      clockDomain: this.#o.clock.domain,
      now: this.#o.clock.now(),
      authorityEpoch: this.#authorityEpoch,
      supervision: this.#supervision,
      hostHealth: this.#health,
      endpointFact: this.#endpoint,
      isolation: [...this.#isolation.values()],
      grants: [...this.#grants.values()].map((g) => g.grant),
      effects: [...this.#effects.values()],
    };
  }
  #token(input: Input): P0Input {
    const token = Object.freeze({ kind: input.binding.trigger_kind });
    this.#inputs.set(token, structuredClone(input));
    return token;
  }
  #input(token: P0Input): Input {
    const input = this.#inputs.get(token);
    if (!input) throw new Error("P0_UNBOUND_INPUT");
    return input;
  }
  #request(request: RpcRequest, a: P0ConnectionAnnouncement, trigger: CommandTrigger): void {
    assertValid("RpcRequest", request);
    assertValid("P0ConnectionAnnouncement", a);
    const c = request.params.context;
    if (
      a.service_instance_id !== this.#o.supervisor.instance_id ||
      a.session_id !== this.#o.session ||
      a.authority_instance_id !== this.#o.supervisor.instance_id ||
      a.authority_epoch !== this.#authorityEpoch ||
      c.authority_epoch !== this.#authorityEpoch ||
      c.object_ref.kind !== "Session" ||
      c.object_ref.id !== this.#o.session
    )
      reject("SCOPED_EPOCH_CONFLICT");
    if (c.payload_digest !== payloadDigest({ method: request.method, input: request.params.input }))
      reject("OPERATION_PAYLOAD_CONFLICT");
    if (!("mapping" in request.params.input)) reject("CLOCK_MAPPING_INVALID");
    validateMapping(
      request.params.input.mapping,
      a,
      c.caller_instance_id,
      this.#o.config.limits,
      this.#o.clock.now(),
    );
    checkDeadline(c.deadline, this.#o.clock);
    if (c.deadline.expires_at_ms > request.params.input.mapping.target_valid_until_ms)
      reject("CLOCK_MAPPING_INVALID");
    if (
      !Number.isSafeInteger(trigger.receive_seq) ||
      trigger.receive_seq < 0 ||
      trigger.trigger_kind !== "command" ||
      trigger.trigger_digest !== authenticationDigest(request.method, c, request.params.input) ||
      trigger.trigger_id !==
        payloadDigest({
          connection_id: a.connection_id,
          receiver_instance_id: this.#o.supervisor.instance_id,
          request_id: request.id,
          receive_seq: trigger.receive_seq,
        })
    )
      throw new Error("P0_COMMAND_TRIGGER_MISMATCH");
  }
  /** identity is the service's actual authenticated result, never request.operator_id. */
  command(
    request: RpcRequest,
    identity: P0OperatorIdentity,
    announcement: P0ConnectionAnnouncement,
    trigger: CommandTrigger,
  ): P0Input {
    this.#request(request, announcement, trigger);
    assertValid("P0OperatorIdentity", identity);
    const i = request.params.input;
    if (
      !("proof" in i) ||
      !("credential_id" in i.proof) ||
      identity.credential_id !== i.proof.credential_id ||
      identity.connection_id !== announcement.connection_id ||
      identity.authenticated_at.clock_domain !== this.#o.clock.domain ||
      identity.authenticated_at.monotonic_ms > this.#o.clock.now() ||
      i.proof.client_instance_id !== request.params.context.caller_instance_id ||
      i.proof.connection_id !== announcement.connection_id ||
      i.proof.request_digest !== trigger.trigger_digest ||
      i.proof.service_instance_id !== this.#o.supervisor.instance_id ||
      ("session_id" in i && i.session_id !== this.#o.session)
    )
      reject("AUTHENTICATION_REQUIRED");
    return this.#token({
      binding: {
        trigger_kind: "command",
        trigger_id: trigger.trigger_id,
        trigger_digest: trigger.trigger_digest,
        timer_deadline: null,
      },
      operator: { request, identity },
      worker: null,
      endpoint: null,
      safety: "operator",
    });
  }
  health(
    request: RpcRequest,
    peer: P0PeerIdentity,
    announcement: P0ConnectionAnnouncement,
    trigger: CommandTrigger,
  ): P0Input {
    this.#request(request, announcement, trigger);
    if (
      !same(peer, this.#o.host) ||
      request.method !== "supervisor.health" ||
      request.params.context.caller_instance_id !== peer.instance_id ||
      request.params.input.peer_instance_id !== peer.instance_id ||
      request.params.input.peer_role !== "host" ||
      request.params.input.session_id !== this.#o.session
    )
      reject("ROLE_SCOPE_DENIED");
    this.#health = { instance: peer.instance_id, receivedAt: this.#o.clock.now() };
    this.#supervision.connection_healthy = true;
    this.#refresh();
    return this.#token({
      binding: {
        trigger_kind: "command",
        trigger_id: trigger.trigger_id,
        trigger_digest: trigger.trigger_digest,
        timer_deadline: null,
      },
      operator: null,
      worker: null,
      endpoint: null,
      safety: "peer",
    });
  }
  /** Actual parent exit/channel failure callback, not a parsed stderr record. */
  failure(record: P0ProcessObservation | P0ProtocolObservation, peer: P0PeerIdentity): P0Input {
    assertValid(
      record.record_type === "p0-process-observation"
        ? "P0ProcessObservation"
        : "P0ProtocolObservation",
      record,
    );
    if (
      (!same(peer, this.#o.host) && !same(peer, this.#o.endpoint)) ||
      record.source_instance_id !== this.#o.supervisor.instance_id ||
      record.observed_at.clock_domain !== this.#o.clock.domain ||
      record.observed_at.monotonic_ms > this.#o.clock.now()
    )
      throw new Error("P0_FAILURE_SOURCE");
    if (record.record_type === "p0-process-observation") {
      if (
        record.detail.kind !== "exited" ||
        record.detail.expected_instance_id !== peer.instance_id ||
        record.detail.child_role !== peer.role
      )
        throw new Error("P0_NOT_EXIT_FACT");
    } else if (
      record.detail.kind !== "local_failure" ||
      record.connection_id === null ||
      !["connect", "close", "read", "write"].includes(record.detail.stage)
    )
      throw new Error("P0_NOT_CHANNEL_FAILURE");
    return this.#token({
      binding: { ...observationTrigger(record), timer_deadline: null },
      operator: null,
      worker: null,
      endpoint: null,
      safety: "failure",
      healthLost: peer.role === "host" ? "host" : "endpoint",
    });
  }
  #reserve(owner: string, targets: readonly ObjectRef[]): void {
    for (const target of targets)
      this.#reserved.set(`${owner}:${resourceKey(target)}`, {
        stop: randomUUID(),
        cleanup: randomUUID(),
        isolation: randomUUID(),
        target: structuredClone(target),
      });
  }
  requestGrant(token: P0Input): {
    decision: Reduction;
    grant: ExecutionGrant | null;
    duplicate: boolean;
  } {
    const input = this.#input(token);
    const op = input.operator;
    this.#external(input);
    if (op?.request.method !== "session.authorize") throw new Error("P0_AUTHORIZE_INPUT_REQUIRED");
    const request = op.request;
    const i = request.params.input;
    const key = `${op.identity.operator_id}:${request.params.context.operation_id}`;
    const { proof: _proof, mapping: _mapping, ...business } = i;
    const c = request.params.context;
    const digest = payloadDigest({
      method: request.method,
      input: business,
      scope: c.object_ref,
      grant: c.grant_ref,
      epoch: c.authority_epoch,
      deadline: c.deadline,
    });
    const prior = this.#operations.get(key);
    if (prior) {
      if (prior.digest !== digest) reject("OPERATION_PAYLOAD_CONFLICT");
      // No new transition/allocation. This is the existing operation's current projection.
      return {
        decision: structuredClone(prior.decision),
        grant: prior.grant ? (this.grant(prior.grant) ?? null) : null,
        duplicate: true,
      };
    }
    // Reserve initial 16 plus per-target safety records, including imported isolation.
    if (
      this.#grants.size >= 7 ||
      this.#reserved.size + i.target_refs.length + (this.#o.isolation?.length ?? 0) > 128 ||
      this.#operations.size >= 128
    )
      reject("QUEUE_LIMIT_EXCEEDED");
    const decision = this.supervise(
      i.supervision_mode === "unattended_approved" ? "approve_unattended" : "operator_supervise",
      token,
    );
    this.#operations.set(key, { digest, grant: null, decision });
    if (decision.disposition !== "accepted") return { decision, grant: null, duplicate: false };
    const admission: P0AdmissionRecord = {
      admission_id: randomUUID(),
      session_id: this.#o.session,
      host_instance_id: this.#o.host.instance_id,
      supervisor_instance_id: this.#o.supervisor.instance_id,
      endpoint_instance_id: this.#o.endpoint.instance_id,
      operator_id: op.identity.operator_id,
      installation_id: this.#o.config.installation.installation_id,
      installation_digest: payloadDigest(this.#o.config.installation),
      manifest_digest: this.#o.config.installation.manifest_digest,
      profile_digest: payloadDigest(this.#o.config.profile),
      schema_digest: schemaDigest,
      mode: "simulation",
      enabled_phases: ["P0"],
      public_broadcast_allowed: false,
      accepted_at: this.#o.clock.point(),
      record_status: "pending",
    };
    const grant: ExecutionGrant = {
      grant_id: randomUUID(),
      state: "REQUESTED",
      mode: "simulation",
      session_id: this.#o.session,
      supervision_epoch: this.#supervision.supervision_epoch,
      profile_ref: "p0-runtime-configuration@1",
      target_refs: structuredClone(i.target_refs),
      allowed_capabilities: i.allowed_capabilities.map((c) => c.name),
      effect_limit: i.effect_limit,
      cost_limit_units: i.cost_limit_units,
      deadline: structuredClone(i.grant_deadline),
      operator_id: op.identity.operator_id,
      gate_evidence_refs: [],
      public_broadcast_allowed: false,
      host_instance_id: this.#o.host.instance_id,
      supervisor_instance_id: this.#o.supervisor.instance_id,
      endpoint_instance_id: this.#o.endpoint.instance_id,
      queue_limit: i.queue_limit,
      admission_ref: admission.admission_id,
    };
    assertValid("ExecutionGrant", grant);
    assertValid("P0AdmissionRecord", admission);
    this.#grants.set(grant.grant_id, {
      grant,
      admission,
      operator: structuredClone(op),
      authorityEpoch: this.#authorityEpoch,
      activeReceipt: null,
    });
    this.#operations.set(key, { digest, grant: grant.grant_id, decision });
    this.#reserve(grant.grant_id, grant.target_refs);
    this.#action({ kind: "persist", object_ref: { kind: "ExecutionGrant", id: grant.grant_id } });
    this.#action({
      kind: "persist",
      object_ref: { kind: "P0AdmissionRecord", id: admission.admission_id },
    });
    return { decision, grant: structuredClone(grant), duplicate: false };
  }
  /** Only an actual private Worker completion may enter here. No ready/durable boolean. */
  workerReceipt(input: P0StoreCommitInput, receipt: P0PersistenceReceipt): P0Input {
    assertValid("P0StoreCommitInput", input);
    assertValid("P0PersistenceReceipt", receipt);
    if (!committed(this.#state(), { input, receipt })) reject("PERSISTENCE_NOT_READY");
    return this.#token({
      binding: {
        trigger_kind: "worker_receipt",
        trigger_id: receipt.receipt_id,
        trigger_digest: payloadDigest(receipt),
        timer_deadline: null,
      },
      operator: null,
      worker: { input, receipt },
      endpoint: null,
      safety: "worker",
    });
  }
  /** ACTIVE is still not executable until this separate exact ACTIVE commit is observed. */
  bindActiveCommit(grantId: string, token: P0Input): void {
    const entry = this.#grants.get(grantId);
    const fact = this.#input(token).worker;
    if (
      entry?.grant.state !== "ACTIVE" ||
      entry.authorityEpoch !== this.#authorityEpoch ||
      !committed(this.#state(), fact) ||
      !fact?.receipt.grant_digests.includes(payloadDigest(entry.grant)) ||
      !fact.receipt.admission_digests.includes(
        payloadDigest({ ...entry.admission, record_status: "durable" }),
      ) ||
      entry.grant.deadline.expires_at_ms <= this.#o.clock.now() ||
      this.#supervision.state !== "supervised"
    )
      reject("PERSISTENCE_NOT_READY");
    entry.activeReceipt = structuredClone(fact);
    entry.admission.record_status = "durable";
    this.#persistence = "ready";
  }
  canExecute(grantId: string): boolean {
    const entry = this.#grants.get(grantId);
    const f = this.#endpoint;
    return !!(
      !this.#localFenced &&
      this.#persistence === "ready" &&
      entry &&
      entry.grant.state === "ACTIVE" &&
      entry.activeReceipt &&
      committed(this.#state(), entry.activeReceipt) &&
      entry.authorityEpoch === this.#authorityEpoch &&
      this.#supervision.state === "supervised" &&
      entry.grant.supervision_epoch === this.#supervision.supervision_epoch &&
      entry.grant.deadline.expires_at_ms > this.#o.clock.now() &&
      this.#supervision.human_lease_deadline &&
      this.#supervision.human_lease_deadline.monotonic_ms > this.#o.clock.now() &&
      this.#health?.instance === this.#o.host.instance_id &&
      this.#o.clock.now() - this.#health.receivedAt <
        this.#o.config.limits.peer_health_timeout_ms &&
      endpointConnectionUpper(this.#state()) !== null &&
      f &&
      f.authorityEpoch === this.#authorityEpoch &&
      f.snapshot.supervision_epoch === entry.grant.supervision_epoch &&
      f.snapshot.active_grant_ref === grantId &&
      !f.snapshot.fence_applied &&
      f.snapshot.lease_deadline &&
      f.snapshot.lease_deadline.expires_at_ms - f.mapping.offset_upper_ms > this.#o.clock.now() &&
      !this.#state().isolation.some(
        (i) =>
          i.status === "blocked" && entry.grant.target_refs.some((t) => same(t, i.resource_ref)),
      )
    );
  }
  #decision(
    machine: Machine,
    ref: ObjectRef,
    state: string,
    event: string,
    token: P0Input,
    guard: (id: string, input: Input) => boolean,
  ): Reduction {
    const input = this.#input(token);
    const table = stateMachines.machines.find((m) => m.id === machine);
    if (!table) throw new Error("P0_MACHINE_MISSING");
    const row = table.transitions.find(
      (r) => (r.source as readonly string[]).includes(state) && r.event === event,
    );
    const result: Reduction = {
      machine,
      object_ref: ref,
      from: state,
      event,
      to: state,
      guard: null,
      guard_result: null,
      disposition: "table_rejected",
    };
    if ((table.terminal as readonly string[]).includes(state))
      result.disposition = "terminal_rejected";
    else if (row) {
      if (row.phase !== "P0") result.disposition = "disabled_rejected";
      else {
        result.guard = row.guard;
        result.guard_result = row.guard === "always" ? true : guard(row.guard, input);
        result.disposition = result.guard_result ? "accepted" : "guard_rejected";
        if (result.guard_result) result.to = row.target;
      }
    }
    this.#o.observation?.reduction({ ...result, ...input.binding } as Omit<
      P0ReductionObservation,
      "record_type" | "source_instance_id" | "source_seq" | "dropped_observations" | "observed_at"
    >);
    return result;
  }
  #external(input: Input): void {
    if (input.operator) {
      checkDeadline(input.operator.request.params.context.deadline, this.#o.clock);
      if (input.operator.request.params.context.authority_epoch !== this.#authorityEpoch)
        reject("SCOPED_EPOCH_CONFLICT");
    }
  }
  #authorized(input: Input, grantId?: string): boolean {
    if (input.safety === "failure" || input.safety === "timer") return true;
    const request = input.operator?.request;
    if (request?.method === "session.stop") {
      const target = request.params.input.target_ref;
      return (
        request.params.context.grant_ref === null &&
        this.#o.config.installation.allowed_targets.some((allowed) => same(allowed, target)) &&
        (!grantId ||
          !!this.#grants.get(grantId)?.grant.target_refs.some((allowed) => same(allowed, target)))
      );
    }
    if (request?.method === "session.revoke") {
      const id = request.params.input.grant_id;
      return (
        this.#grants.has(id) &&
        request.params.context.grant_ref === id &&
        (!grantId || grantId === id)
      );
    }
    return false;
  }
  supervise(event: string, token: P0Input): Reduction {
    const input = this.#input(token);
    this.#external(input);
    if (
      ["grace_deadline", "stop_timeout"].includes(event) &&
      input.binding.trigger_kind !== "timer"
    )
      throw new Error("P0_TIMER_INPUT_REQUIRED");
    if (event === "supervision_lost" && !["timer", "failure"].includes(input.safety))
      throw new Error("P0_SAFETY_INPUT_REQUIRED");
    if (event === "heartbeat" && input.safety !== "peer")
      throw new Error("P0_HEALTH_INPUT_REQUIRED");
    const result = this.#decision(
      "SupervisionMode",
      { kind: "Session", id: this.#o.session },
      this.#supervision.state,
      event,
      token,
      (guard) => {
        if (guard === "supervised_entry_valid")
          return supervisedEntry(this.#state(), input.operator);
        if (guard === "unattended_entry_valid") return false;
        if (guard === "human_renewal_valid") return humanRenewal(this.#state(), input.operator);
        if (guard === "authorized_stop") return this.#authorized(input);
        if (guard === "supervision_outputs_safe") return outputsSafe(this.#state());
        throw new Error(`P0_UNKNOWN_GUARD:${guard}`);
      },
    );
    if (result.disposition !== "accepted") return result;
    const prior = this.#supervision.state;
    this.#supervision.state = result.to as SupervisionRecord["state"];
    if (prior !== result.to) this.#supervision.supervision_epoch++;
    if (event === "operator_supervise" && input.operator?.request.method === "session.authorize") {
      this.#localFenced = false;
      this.#supervision.operator_id = input.operator.identity.operator_id;
      this.#supervision.human_lease_deadline = {
        clock_domain: this.#o.clock.domain,
        monotonic_ms: input.operator.request.params.input.human_lease_deadline.expires_at_ms,
      };
      this.#supervision.grace_deadline = null;
    } else if (event === "human_renewal" && input.operator?.request.method === "session.renew") {
      this.#supervision.human_lease_deadline = {
        clock_domain: this.#o.clock.domain,
        monotonic_ms: input.operator.request.params.input.human_lease_deadline.expires_at_ms,
      };
    } else if (
      ["supervision_lost", "safe_stop", "grace_deadline", "stop_timeout"].includes(event)
    ) {
      if (event === "supervision_lost") {
        // Expired human approval is independent of an otherwise healthy Host link.
        if (input.healthLost === "host") this.#supervision.connection_healthy = false;
        this.#supervision.grace_deadline = {
          clock_domain: this.#o.clock.domain,
          monotonic_ms: this.#o.clock.now() + this.#o.config.limits.stop_timeout_ms,
        };
      }
      this.#fence(token);
      if (result.to === "safe_stopping")
        this.#supervisionStopDeadline = {
          clock_domain: this.#o.clock.domain,
          monotonic_ms: this.#o.clock.now() + this.#o.config.limits.stop_timeout_ms,
        };
    }
    this.#refresh();
    return result;
  }
  reduceGrant(id: string, event: string, token: P0Input): Reduction {
    this.#external(this.#input(token));
    if (event === "deadline" && this.#input(token).binding.trigger_kind !== "timer")
      throw new Error("P0_TIMER_INPUT_REQUIRED");
    const entry = this.#grants.get(id);
    if (!entry) throw new Error("P0_UNKNOWN_GRANT");
    const result = this.#decision(
      "ExecutionGrant",
      { kind: "ExecutionGrant", id },
      entry.grant.state,
      event,
      token,
      (guard, input) => {
        if (guard === "authorized_stop") return this.#authorized(input, id);
        if (guard === "execution_grant_valid")
          return (
            entry.authorityEpoch === this.#authorityEpoch &&
            executionGrant(
              this.#state(),
              entry.grant,
              entry.admission,
              entry.operator,
              input.worker,
            )
          );
        throw new Error(`P0_UNKNOWN_GUARD:${guard}`);
      },
    );
    if (result.disposition !== "accepted") return result;
    entry.grant.state = result.to as ExecutionGrant["state"];
    if (event === "revoke" || event === "deadline") this.#fence(token);
    this.#refresh();
    this.#action({ kind: "persist", object_ref: { kind: "ExecutionGrant", id } });
    return result;
  }
  #fence(token: P0Input): void {
    if (!this.#localFenced) {
      this.#authorityEpoch++;
      this.#cancelEpoch++;
    }
    this.#localFenced = true;
    // One endpoint has one execution lease. Closing its authority closes every outstanding grant.
    for (const [id, entry] of this.#grants) {
      entry.activeReceipt = null;
      if (entry.grant.state === "ACTIVE" || entry.grant.state === "REQUESTED") {
        const result = this.#decision(
          "ExecutionGrant",
          { kind: "ExecutionGrant", id },
          entry.grant.state,
          "revoke",
          token,
          (guard) => guard === "authorized_stop" && this.#authorized(this.#input(token)),
        );
        if (result.disposition === "accepted") {
          entry.grant.state = "REVOKED";
          this.#action({ kind: "persist", object_ref: { kind: "ExecutionGrant", id } });
        }
      }
    }
    for (const reserved of this.#reserved.values()) {
      if (this.#stops.has(reserved.stop)) continue;
      const now = this.#o.clock.point();
      const incident = randomUUID();
      const stop: StopOperationRecord = {
        stop_operation_id: reserved.stop,
        target: reserved.target,
        fence: {
          scope_type: "session",
          scope_id: this.#o.session,
          cancel_epoch: this.#cancelEpoch,
        },
        requested_at: now,
        deadline: {
          clock_domain: now.clock_domain,
          monotonic_ms: now.monotonic_ms + this.#o.config.limits.stop_timeout_ms,
        },
        local_fence_applied: true,
        endpoint_ack: null,
        record_status: "pending",
        incident_ref: incident,
        recovery_owner_ref: this.#o.supervisor.instance_id,
        state: "REQUESTED",
        supervisor_instance_id: this.#o.supervisor.instance_id,
        endpoint_instance_id: this.#o.endpoint.instance_id,
        endpoint_fact: null,
        cleanup_ref: reserved.cleanup,
      };
      this.#stops.set(stop.stop_operation_id, stop);
      this.#cleanup.set(reserved.cleanup, {
        cleanup_id: reserved.cleanup,
        stop_operation_id: stop.stop_operation_id,
        recovery_owner_ref: this.#o.supervisor.instance_id,
        endpoint_instance_id: this.#o.endpoint.instance_id,
        target_ref: reserved.target,
        status: "pending",
        endpoint_fact: null,
        unknown_scope_refs: [reserved.target],
        record_status: "pending",
        updated_at: now,
      });
      this.#isolation.set(reserved.isolation, {
        isolation_id: reserved.isolation,
        resource_ref: reserved.target,
        endpoint_instance_id: this.#o.endpoint.instance_id,
        incident_ref: incident,
        recovery_owner_ref: this.#o.supervisor.instance_id,
        status: "blocked",
        evidence_refs: [],
        record_status: "pending",
      });
      this.#supervision.incident_ref = incident;
      this.#action(
        {
          kind: "endpoint_revoke",
          authority_epoch: this.#authorityEpoch,
          stop: structuredClone(stop),
        },
        {
          kind: "query_cleanup",
          cleanup_id: reserved.cleanup,
          endpoint_instance_id: this.#o.endpoint.instance_id,
        },
        { kind: "persist", object_ref: { kind: "StopOperation", id: reserved.stop } },
        { kind: "persist", object_ref: { kind: "P0CleanupRecord", id: reserved.cleanup } },
        { kind: "persist", object_ref: { kind: "P0IsolationRecord", id: reserved.isolation } },
      );
    }
    this.#refresh();
  }
  #refresh(): void {
    this.#supervision.active_grant_refs = [...this.#grants.values()]
      .filter((g) => g.grant.state === "ACTIVE")
      .map((g) => g.grant.grant_id);
    this.#supervision.blocked_scopes = [
      ...new Map(
        [...this.#isolation.values()]
          .filter((i) => i.status === "blocked")
          .map((i) => [resourceKey(i.resource_ref), i.resource_ref]),
      ).values(),
    ];
    const { source_revision: _revision, record_status: _status, ...body } = this.#supervision;
    const digest = payloadDigest(body);
    if (this.#supervisionDigest && this.#supervisionDigest !== digest) {
      this.#supervision.source_revision++;
      this.#supervision.record_status = "pending";
      this.#action({ kind: "persist", object_ref: { kind: "Session", id: this.#o.session } });
    }
    this.#supervisionDigest = digest;
  }
  reduceStop(id: string, event: string, token: P0Input): Reduction {
    this.#external(this.#input(token));
    if (event === "deadline" && this.#input(token).binding.trigger_kind !== "timer")
      throw new Error("P0_TIMER_INPUT_REQUIRED");
    const stop = this.#stops.get(id);
    if (!stop) throw new Error("P0_UNKNOWN_STOP");
    const input = this.#input(token);
    if (
      event === "local_ack" &&
      stop.state === "REQUESTED" &&
      input.endpoint &&
      input.endpoint.receivedAt >= stop.deadline.monotonic_ms
    ) {
      // A delayed timer dispatch cannot turn late proof into an on-time stop.
      // Use the stored timer binding; the caller still applies this fact to cleanup.
      const expired = this.fire(this.timer("StopOperation", id, "deadline"));
      if (!expired.decision) throw new Error("P0_STOP_DEADLINE_NOT_DUE");
      return expired.decision;
    }
    const result = this.#decision(
      "StopOperation",
      { kind: "StopOperation", id },
      stop.state,
      event,
      token,
      (guard) =>
        guard === "local_effect_stopped" &&
        stop.local_fence_applied &&
        localEffectStopped(this.#state(), input.endpoint),
    );
    if (result.disposition === "accepted") {
      stop.state = result.to as StopOperationRecord["state"];
      stop.record_status = "pending";
      if (result.to === "CONFIRMED")
        stop.endpoint_fact = structuredClone(input.endpoint?.snapshot ?? null);
      const cleanup = stop.cleanup_ref ? this.#cleanup.get(stop.cleanup_ref) : undefined;
      if (cleanup && result.to === "UNKNOWN") {
        cleanup.status = "unknown";
        cleanup.updated_at = this.#o.clock.point();
        cleanup.record_status = "pending";
        this.#action({
          kind: "persist",
          object_ref: { kind: "P0CleanupRecord", id: cleanup.cleanup_id },
        });
      }
      this.#action({ kind: "persist", object_ref: { kind: "StopOperation", id } });
    }
    return result;
  }
  timer(
    machine: Machine,
    id: string,
    event: string,
    basis: P0Timer["basis"] = event === "supervision_lost" ? "human" : "object",
  ): P0Timer {
    const deadline = this.#deadline(machine, id, event, basis);
    if (!deadline) throw new Error("P0_TIMER_NOT_BOUND");
    const timer = Object.freeze({
      owner_instance_id: this.#o.supervisor.instance_id,
      object_ref: Object.freeze({ kind: machine === "SupervisionMode" ? "Session" : machine, id }),
      machine,
      event,
      deadline: Object.freeze(structuredClone(deadline)),
      basis,
      basis_digest: this.#timerBasis(basis),
    });
    this.#timers.add(timer);
    return timer;
  }
  #timerBasis(basis: P0Timer["basis"]): string {
    return payloadDigest(
      basis === "host_health"
        ? { instance: this.#o.host.instance_id, health: this.#health }
        : basis === "endpoint_health" || basis === "endpoint_connection"
          ? {
              instance: this.#o.endpoint.instance_id,
              received: this.#endpoint?.receivedAt ?? null,
              revision: this.#endpoint?.snapshot.source_revision ?? null,
              connection: this.#endpoint?.snapshot.host_connection_deadline ?? null,
            }
          : { instance: this.#o.supervisor.instance_id, basis },
    );
  }
  #deadline(
    machine: Machine,
    id: string,
    event: string,
    basis: P0Timer["basis"],
  ): ClockPoint | null {
    if (event !== "supervision_lost" && basis !== "object") return null;
    if (machine === "ExecutionGrant" && event === "deadline") {
      const d = this.#grants.get(id)?.grant.deadline;
      return d ? { clock_domain: d.clock_domain, monotonic_ms: d.expires_at_ms } : null;
    }
    if (machine === "StopOperation" && event === "deadline")
      return this.#stops.get(id)?.deadline ?? null;
    if (machine !== "SupervisionMode" || id !== this.#o.session) return null;
    if (event === "supervision_lost") {
      if (basis === "human") return this.#supervision.human_lease_deadline;
      if (basis === "host_health" && this.#health)
        return {
          clock_domain: this.#o.clock.domain,
          monotonic_ms: this.#health.receivedAt + this.#o.config.limits.peer_health_timeout_ms,
        };
      if (basis === "endpoint_health" && this.#endpoint)
        return {
          clock_domain: this.#o.clock.domain,
          monotonic_ms: this.#endpoint.receivedAt + this.#o.config.limits.peer_health_timeout_ms,
        };
      if (basis === "endpoint_connection" && this.#endpoint?.snapshot.host_connection_deadline)
        return {
          clock_domain: this.#o.clock.domain,
          monotonic_ms: Math.min(
            this.#endpoint.snapshot.host_connection_deadline.expires_at_ms -
              this.#endpoint.mapping.offset_upper_ms,
            this.#endpoint.mapping.source_valid_until_ms,
            this.#endpoint.mapping.target_valid_until_ms - this.#endpoint.mapping.offset_upper_ms,
          ),
        };
      return null;
    }
    if (event === "grace_deadline") return this.#supervision.grace_deadline;
    if (event === "stop_timeout") return this.#supervisionStopDeadline;
    return null;
  }
  fire(timer: P0Timer): { reschedule: ClockPoint | null; decision: Reduction | null } {
    const expected = this.#deadline(timer.machine, timer.object_ref.id, timer.event, timer.basis);
    if (
      !this.#timers.has(timer) ||
      timer.owner_instance_id !== this.#o.supervisor.instance_id ||
      timer.deadline.clock_domain !== this.#o.clock.domain ||
      !same(timer.deadline, expected) ||
      timer.basis_digest !== this.#timerBasis(timer.basis)
    )
      throw new Error("P0_INVALID_TIMER_BINDING");
    if (this.#o.clock.now() < timer.deadline.monotonic_ms)
      return { reschedule: structuredClone(timer.deadline), decision: null };
    const token = this.#token({
      binding: {
        trigger_kind: "timer",
        trigger_id: payloadDigest(timer),
        trigger_digest: payloadDigest(timer),
        timer_deadline: timer.deadline,
      },
      operator: null,
      worker: null,
      endpoint: null,
      safety: "timer",
      ...(timer.basis === "host_health"
        ? { healthLost: "host" as const }
        : timer.basis === "endpoint_health" || timer.basis === "endpoint_connection"
          ? { healthLost: "endpoint" as const }
          : {}),
    });
    const decision =
      timer.machine === "SupervisionMode"
        ? this.supervise(timer.event, token)
        : timer.machine === "ExecutionGrant"
          ? this.reduceGrant(timer.object_ref.id, timer.event, token)
          : this.reduceStop(timer.object_ref.id, timer.event, token);
    return { reschedule: null, decision };
  }
  endpointFact(source: {
    announcement: RpcEvent;
    mapping: P0ClockMapping;
    delivery:
      | { kind: "query"; request: RpcRequest; response: unknown }
      | { kind: "event"; event: RpcEvent };
  }): P0Input {
    const a = verifyAnnouncement(source.announcement, this.#o.endpoint, this.#o.supervisor);
    validateMapping(source.mapping, a, this.#o.supervisor.instance_id, this.#o.config.limits);
    const now = this.#o.clock.now();
    if (
      source.mapping.source_clock_domain !== this.#o.clock.domain ||
      source.mapping.source_valid_until_ms <= now
    )
      reject("CLOCK_MAPPING_INVALID");
    let fact: P0EndpointSnapshot;
    let epoch: number;
    let id: string;
    let digest: string;
    if (source.delivery.kind === "query") {
      const { request, response } = source.delivery;
      assertValid("RpcRequest", request);
      if (
        request.method !== "simulation.query" ||
        request.params.context.caller_instance_id !== this.#o.supervisor.instance_id ||
        request.params.context.object_ref.kind !== "Session" ||
        request.params.context.object_ref.id !== this.#o.session ||
        request.params.input.session_id !== this.#o.session ||
        request.params.input.endpoint_instance_id !== this.#o.endpoint.instance_id ||
        !same(request.params.input.mapping, source.mapping)
      )
        reject("ROLE_SCOPE_DENIED");
      validateRpcResponse("simulation.query", response);
      const r = response as { id: string; result?: unknown };
      if (r.id !== request.id || !r.result) throw new Error("P0_ENDPOINT_QUERY_FAILED");
      assertValid("P0EndpointSnapshot", r.result);
      fact = r.result;
      const c = request.params.context;
      if (
        c.payload_digest !==
          payloadDigest({ method: request.method, input: request.params.input }) ||
        c.deadline.clock_domain !== source.mapping.target_clock_domain ||
        c.deadline.expires_at_ms <= now + source.mapping.offset_upper_ms ||
        c.deadline.expires_at_ms > source.mapping.target_valid_until_ms
      )
        reject("CLOCK_MAPPING_INVALID");
      epoch = request.params.context.authority_epoch;
      id = request.id;
      digest = payloadDigest({ request, response });
    } else {
      const event = source.delivery.event;
      assertValid("RpcEvent", event);
      if (
        event.params.event_name !== "simulation.progressed" &&
        event.params.event_name !== "simulation.stopped"
      )
        reject("ROLE_SCOPE_DENIED");
      if (
        event.params.authority_id !== "endpoint" ||
        event.params.source_instance !== this.#o.endpoint.instance_id ||
        event.params.session_id !== this.#o.session
      )
        reject("ROLE_SCOPE_DENIED");
      if (
        event.params.scope_ref.kind !== "Session" ||
        event.params.scope_ref.id !== this.#o.session
      )
        reject("ROLE_SCOPE_DENIED");
      assertValid("P0EndpointSnapshot", event.params.payload);
      fact = event.params.payload;
      epoch = event.params.authority_epoch;
      id = event.params.event_id;
      digest = payloadDigest(event);
    }
    if (
      epoch !== this.#authorityEpoch ||
      fact.endpoint_instance_id !== this.#o.endpoint.instance_id ||
      fact.session_id !== this.#o.session ||
      fact.supervisor_instance_id !== this.#o.supervisor.instance_id ||
      fact.supervision_epoch > this.#supervision.supervision_epoch ||
      (fact.active_grant_ref !== null &&
        this.#grants.get(fact.active_grant_ref)?.grant.supervision_epoch !==
          fact.supervision_epoch) ||
      fact.observed_at.clock_domain !== source.mapping.target_clock_domain ||
      fact.observed_at.monotonic_ms > now + source.mapping.offset_upper_ms
    )
      reject("SCOPED_EPOCH_CONFLICT");
    if (!endpointDeadlinesValid(fact, source.mapping)) reject("CLOCK_MAPPING_INVALID");
    const old = this.#endpoint?.snapshot;
    if (
      old &&
      (fact.source_revision < old.source_revision ||
        (fact.source_revision === old.source_revision && !same(fact, old)) ||
        fact.supervision_epoch < old.supervision_epoch ||
        fact.accepted_watermark < old.accepted_watermark ||
        fact.completed_effect_count < old.completed_effect_count ||
        old.effect_facts.some(
          (before) =>
            !fact.effect_facts.some(
              (after) =>
                after.operation_id === before.operation_id &&
                after.accepted_seq === before.accepted_seq &&
                after.grant_id === before.grant_id &&
                same(after.target_ref, before.target_ref) &&
                after.payload_digest === before.payload_digest &&
                after.requested_units === before.requested_units &&
                after.completed_units >= before.completed_units &&
                (before.outcome === "accepted" || same(before, after)),
            ),
        ))
    )
      reject("OPERATION_PAYLOAD_CONFLICT");
    const endpoint: EndpointFact = {
      snapshot: structuredClone(fact),
      authorityEpoch: epoch,
      mapping: structuredClone(source.mapping),
      announcement: a,
      receivedAt: now,
    };
    this.#endpoint = endpoint;
    const token = this.#token({
      binding: {
        trigger_kind: "endpoint_fact",
        trigger_id: id,
        trigger_digest: digest,
        timer_deadline: null,
      },
      operator: null,
      worker: null,
      endpoint,
      safety: "fact",
    });
    // Stop terminal states never change. Late proof belongs only to independent cleanup.
    for (const stop of this.#stops.values()) {
      if (stop.state === "REQUESTED") this.reduceStop(stop.stop_operation_id, "local_ack", token);
      if (!localEffectStopped(this.#state(), endpoint) || !stop.cleanup_ref) continue;
      const cleanup = this.#cleanup.get(stop.cleanup_ref);
      if (!cleanup || cleanup.endpoint_instance_id !== fact.endpoint_instance_id) continue;
      // The incident keeps its first complete proof. A later global revision/new grant
      // belongs to the endpoint projection or a new incident, not every old cleanup.
      if (cleanup.status === "confirmed") continue;
      cleanup.status = "confirmed";
      cleanup.endpoint_fact = structuredClone(fact);
      cleanup.unknown_scope_refs = [];
      cleanup.updated_at = this.#o.clock.point();
      cleanup.record_status = "pending";
      this.#action({
        kind: "persist",
        object_ref: { kind: "P0CleanupRecord", id: cleanup.cleanup_id },
      });
      for (const isolation of this.#isolation.values()) {
        if (
          isolation.incident_ref !== stop.incident_ref ||
          isolation.endpoint_instance_id !== fact.endpoint_instance_id ||
          !same(isolation.resource_ref, stop.target)
        )
          continue;
        if (
          isolation.status !== "proven_clean" ||
          !same(isolation.evidence_refs, [fact.cleanup_ref])
        ) {
          isolation.status = "proven_clean";
          isolation.evidence_refs = [fact.cleanup_ref as string];
          isolation.record_status = "pending";
          this.#action({
            kind: "persist",
            object_ref: { kind: "P0IsolationRecord", id: isolation.isolation_id },
          });
        }
      }
    }
    this.#refresh();
    return token;
  }
  /** Preserve every registered/in-flight item before dispatch; incomplete history stays UNKNOWN. */
  trackEffect(entry: EffectEntry): void {
    assertValid("P0EffectRegistration", entry.registration);
    assertValid("P0SimulationAction", entry.action);
    const r = entry.registration;
    const g = this.#grants.get(r.grant_id)?.grant;
    if (
      !g ||
      !this.canExecute(g.grant_id) ||
      r.session_id !== this.#o.session ||
      r.endpoint_instance_id !== this.#o.endpoint.instance_id ||
      !g.target_refs.some((t) => same(t, r.target_ref)) ||
      !same(r.target_ref, entry.action.target_ref) ||
      r.units !== entry.action.units ||
      r.cost_units !== entry.action.cost_units ||
      r.payload_digest !==
        payloadDigest({
          session_id: r.session_id,
          grant_id: r.grant_id,
          endpoint_instance_id: r.endpoint_instance_id,
          action: entry.action,
        })
    )
      reject("SIMULATION_SCOPE_DENIED");
    const prior = this.#effects.get(r.operation_id);
    if (prior) {
      if (!same(prior.registration, entry.registration) || !same(prior.action, entry.action))
        reject("OPERATION_PAYLOAD_CONFLICT");
      return;
    }
    if (this.#effects.size >= 1024) reject("QUEUE_LIMIT_EXCEEDED");
    this.#effects.set(r.operation_id, {
      ...structuredClone(entry),
      authorityEpoch: this.#authorityEpoch,
    });
  }
}
