import { randomUUID } from "node:crypto";
import {
  assertValid,
  type CommandContext,
  type Deadline,
  type P0ClockMapping,
  type P0EndpointConfig,
  type P0EndpointLease,
  type P0EndpointRevokeInput,
  type P0EndpointSnapshot,
  type P0ExecuteInput,
  type P0FaultSelection,
  payloadDigest,
  schemaDigest,
} from "../../packages/contract-sdk/src/index.ts";
import { checkDeadline, type MonotonicClock } from "../../packages/runtime/src/clock.ts";
import { reject } from "../../packages/runtime/src/errors.ts";

type Work = { input: P0ExecuteInput; context: CommandContext; expires: number; next: number };

/** The only effects are this instance's queue and counters. No persistence success is synthesized. */
export class EndpointModel {
  readonly config: P0EndpointConfig;
  readonly clock: MonotonicClock;
  readonly absoluteDeadline: number;
  authorityEpoch = 0;
  finalDeadline: number | null = null;
  #fact: P0EndpointSnapshot;
  #lease: P0EndpointLease | null = null;
  #revoked = new Set<string>();
  #grants = new Map<string, string>();
  #leases = new Map<string, string>();
  #grantLimits = new Map<string, number>();
  #operations = new Map<string, { digest: string; work: Work }>();
  #reserved = 0;
  #cost = 0;
  #lastSupervisor: number;
  #handshake = false;
  #fault: P0FaultSelection = { target: "endpoint", fault: "none", duration_ms: 0 };
  #faultUntil = 0;
  onChange: ((snapshot: P0EndpointSnapshot) => void) | undefined;

  constructor(config: P0EndpointConfig, clock: MonotonicClock) {
    assertValid("P0EndpointConfig", config);
    this.config = structuredClone(config);
    this.clock = clock;
    this.absoluteDeadline =
      clock.now() + config.limits.max_session_ms + config.limits.cleanup_timeout_ms;
    this.#lastSupervisor = clock.now();
    this.#fact = {
      endpoint_instance_id: config.endpoint_instance_id,
      session_id: config.session_id,
      supervisor_instance_id: config.supervisor_identity.instance_id,
      supervision_epoch: 0,
      source_revision: 0,
      observed_at: clock.point(),
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
      host_connection_deadline: null,
    };
  }

  snapshot(): P0EndpointSnapshot {
    this.tick(false);
    const fact = structuredClone(this.#fact);
    assertValid("P0EndpointSnapshot", fact);
    return fact;
  }
  #changed(): void {
    this.#fact.source_revision++;
    this.#fact.observed_at = this.clock.point();
    this.onChange?.(structuredClone(this.#fact));
  }
  handshake(mapping: P0ClockMapping): void {
    if (this.#handshake || this.finalDeadline !== null) reject("CONTROLLER_NOT_READY");
    const now = this.clock.now();
    if (
      mapping.source_instance_id !== this.config.host_identity.instance_id ||
      mapping.target_valid_until_ms <= now
    )
      reject("CLOCK_MAPPING_INVALID");
    this.#handshake = true;
    this.#fact.host_connection_deadline = {
      clock_domain: this.clock.domain,
      issued_at_ms: now,
      expires_at_ms: Math.min(
        mapping.target_valid_until_ms,
        this.absoluteDeadline - this.config.limits.cleanup_timeout_ms,
      ),
    };
    this.#changed();
  }
  supervisorSeen(): void {
    this.#lastSupervisor = this.clock.now();
  }

  /** Terminal connection loss differs from revoking a grant on a healthy connection. */
  disconnect(): void {
    if (this.finalDeadline !== null) return;
    this.finalDeadline = Math.min(
      this.absoluteDeadline,
      this.clock.now() + this.config.limits.cleanup_timeout_ms,
    );
    this.#fact.host_connection_deadline = null;
    this.fence();
  }
  fence(): void {
    if (this.#lease) this.#revoked.add(this.#lease.grant.grant_id);
    for (const id of this.#fact.queued_operation_ids) {
      const fact = this.#fact.effect_facts.find((item) => item.operation_id === id);
      if (!fact) throw new Error("QUEUE_FACT_MISSING");
      fact.outcome = "stopped";
      fact.occurred_at = this.clock.point();
      const operation = this.#operations.get(id);
      if (!operation) throw new Error("QUEUE_OPERATION_MISSING");
      fact.deadline_missed = operation.work.expires <= this.clock.now();
      if (!fact.completed_units) this.#fact.not_executed_operation_ids.push(id);
    }
    this.#fact.queued_operation_ids = [];
    this.#lease = null;
    this.#fact.active_grant_ref = null;
    this.#fact.lease_deadline = null;
    this.#fact.fence_applied = true;
    this.#fact.stopped = true;
    this.#fact.cleanup_ref = randomUUID();
    this.#changed();
  }
  #scope(context: CommandContext): void {
    if (context.object_ref.kind !== "Session" || context.object_ref.id !== this.config.session_id)
      reject("ROLE_SCOPE_DENIED");
    checkDeadline(context.deadline, this.clock);
  }
  #targetDeadline(value: Deadline, upper: number): void {
    checkDeadline(value, this.clock);
    if (value.expires_at_ms > upper) reject("CLOCK_MAPPING_INVALID");
  }
  /** Called only after the protocol's fixed-supervisor authentication and signed mapping checks.
   * An existing idempotency conflict is invalid; capacity and later admission failures cannot
   * swallow a trusted authority update after the complete identity/clock/idempotency checks.
   * Module callers still have to satisfy all fixed bindings and target-clock bounds here.
   */
  observeAuthorityUpdate(
    input: P0EndpointLease | P0EndpointRevokeInput,
    context: CommandContext,
  ): void {
    if ("grant" in input) assertValid("P0EndpointLease", input);
    else assertValid("P0EndpointRevokeInput", input);
    assertValid("CommandContext", context);
    this.#scope(context);
    if (context.caller_instance_id !== this.config.supervisor_identity.instance_id)
      reject("AUTHENTICATION_REQUIRED");
    if ("grant" in input) {
      const g = input.grant;
      if (
        g.session_id !== this.config.session_id ||
        g.endpoint_instance_id !== this.config.endpoint_instance_id ||
        g.supervisor_instance_id !== this.config.supervisor_identity.instance_id ||
        g.host_instance_id !== this.config.host_identity.instance_id
      )
        reject("ROLE_SCOPE_DENIED");
    } else if (
      input.session_id !== this.config.session_id ||
      input.endpoint_instance_id !== this.config.endpoint_instance_id ||
      input.supervisor_instance_id !== this.config.supervisor_identity.instance_id ||
      input.fence.scope_type !== "session" ||
      input.fence.scope_id !== this.config.session_id
    )
      reject("ROLE_SCOPE_DENIED");
    if (!("grant" in input) && input.fence.cancel_epoch !== context.authority_epoch)
      reject("SCOPED_EPOCH_CONFLICT");
    const m = input.mapping;
    if (
      m.source_instance_id !== this.config.supervisor_identity.instance_id ||
      m.target_instance_id !== this.config.endpoint_instance_id ||
      m.target_clock_domain !== this.clock.domain ||
      m.source_clock_domain === m.target_clock_domain ||
      m.source_sent_at_ms > m.source_received_at_ms ||
      m.target_received_at_ms > m.target_sent_at_ms ||
      m.offset_lower_ms !== m.target_sent_at_ms - m.source_received_at_ms - 1 ||
      m.offset_upper_ms !== m.target_received_at_ms - m.source_sent_at_ms + 1 ||
      m.offset_lower_ms > m.offset_upper_ms ||
      m.max_error_ms !== m.offset_upper_ms - m.offset_lower_ms ||
      m.max_error_ms > this.config.limits.max_clock_error_ms ||
      m.source_valid_until_ms <= m.source_received_at_ms ||
      m.source_valid_until_ms > m.source_received_at_ms + this.config.limits.clock_mapping_ttl_ms ||
      m.target_valid_until_ms > m.source_valid_until_ms + m.offset_lower_ms ||
      m.target_valid_until_ms > m.target_sent_at_ms + this.config.limits.clock_mapping_ttl_ms ||
      m.target_valid_until_ms <= this.clock.now() ||
      context.deadline.expires_at_ms > m.target_valid_until_ms
    )
      reject("CLOCK_MAPPING_INVALID");
    if ("grant" in input) {
      const previous = this.#leases.get(input.lease_id);
      if (previous && previous !== payloadDigest(input)) reject("OPERATION_PAYLOAD_CONFLICT");
    }
    if (context.authority_epoch < this.authorityEpoch) reject("SCOPED_EPOCH_CONFLICT");
    if (context.authority_epoch > this.authorityEpoch) {
      // One synchronous reduction: observers only see the new epoch with the old grant already fenced.
      this.authorityEpoch = context.authority_epoch;
      this.fence();
    }
  }
  install(input: P0EndpointLease, context: CommandContext): void {
    assertValid("P0EndpointLease", input);
    this.tick(false);
    this.observeAuthorityUpdate(input, context);
    const { grant: g, admission: a, mapping: m, receipt } = input;
    const leaseDigest = payloadDigest(input);
    const oldLease = this.#leases.get(input.lease_id);
    if (oldLease && oldLease !== leaseDigest) reject("OPERATION_PAYLOAD_CONFLICT");
    if (
      context.caller_instance_id !== this.config.supervisor_identity.instance_id ||
      context.authority_epoch < this.authorityEpoch ||
      g.supervision_epoch < this.#fact.supervision_epoch
    )
      reject("SCOPED_EPOCH_CONFLICT");
    if (this.#revoked.has(g.grant_id)) reject("EXECUTION_GRANT_REVOKED");
    if (oldLease) return;
    if (this.#leases.size >= 128) reject("QUEUE_LIMIT_EXCEEDED");
    if (this.finalDeadline !== null || !this.#fact.host_connection_deadline)
      reject("CONTROLLER_NOT_READY");
    if (g.state !== "ACTIVE" || this.#revoked.has(g.grant_id)) reject("EXECUTION_GRANT_REVOKED");
    if (
      g.mode !== "simulation" ||
      g.public_broadcast_allowed ||
      g.allowed_capabilities.length !== 1 ||
      g.allowed_capabilities[0] !== "simulation.execute" ||
      !g.target_refs.length ||
      g.target_refs.some((target) => target.kind !== "SimulationCounter") ||
      g.effect_limit > this.config.limits.max_effects ||
      g.queue_limit > this.config.limits.max_queue_items
    )
      reject("SIMULATION_SCOPE_DENIED");
    if (
      g.session_id !== this.config.session_id ||
      g.endpoint_instance_id !== this.config.endpoint_instance_id ||
      g.host_instance_id !== this.config.host_identity.instance_id ||
      g.supervisor_instance_id !== this.config.supervisor_identity.instance_id ||
      a.admission_id !== g.admission_ref ||
      a.session_id !== g.session_id ||
      a.operator_id !== g.operator_id ||
      a.host_instance_id !== g.host_instance_id ||
      a.endpoint_instance_id !== g.endpoint_instance_id ||
      a.supervisor_instance_id !== g.supervisor_instance_id ||
      a.installation_id !== this.config.installation_id ||
      a.manifest_digest !== payloadDigest(this.config.manifest) ||
      a.schema_digest !== schemaDigest ||
      a.record_status !== "durable"
    )
      reject("INSTALLATION_IDENTITY_DENIED");
    if (
      !receipt.grant_digests.includes(payloadDigest(g)) ||
      !receipt.admission_digests.includes(payloadDigest(a))
    )
      reject("PERSISTENCE_NOT_READY");
    if (
      g.deadline.clock_domain !== m.source_clock_domain ||
      m.source_instance_id !== g.supervisor_instance_id ||
      m.target_instance_id !== this.config.endpoint_instance_id ||
      m.target_clock_domain !== this.clock.domain
    )
      reject("CLOCK_MAPPING_INVALID");
    const upper = Math.min(
      m.target_valid_until_ms,
      this.#fact.host_connection_deadline.expires_at_ms,
      g.deadline.expires_at_ms + m.offset_lower_ms,
      this.#grantLimits.get(g.grant_id) ?? Number.MAX_SAFE_INTEGER,
    );
    this.#targetDeadline(input.deadline, upper);
    this.#targetDeadline(
      input.human_lease_deadline,
      Math.min(upper, this.clock.now() + this.config.limits.max_human_lease_ms),
    );
    this.#targetDeadline(
      input.local_lease_deadline,
      Math.min(upper, this.clock.now() + this.config.limits.endpoint_lease_ms),
    );
    const digest = payloadDigest({ grant: g, admission: a, writer: receipt.writer_instance_id });
    const previous = this.#grants.get(g.grant_id);
    if (previous && previous !== digest) reject("OPERATION_PAYLOAD_CONFLICT");
    if (!previous && this.#grants.size >= 128) reject("QUEUE_LIMIT_EXCEEDED");
    if (this.#lease && this.#lease.grant.grant_id !== g.grant_id) this.fence();
    if (!previous) {
      this.#reserved = 0;
      this.#cost = 0;
    }
    this.#grants.set(g.grant_id, digest);
    this.#leases.set(input.lease_id, leaseDigest);
    if (!this.#grantLimits.has(g.grant_id))
      this.#grantLimits.set(g.grant_id, input.deadline.expires_at_ms);
    this.#fact.supervision_epoch = g.supervision_epoch;
    this.#lease = structuredClone(input);
    this.#fact.active_grant_ref = g.grant_id;
    this.#fact.fence_applied = false;
    this.#fact.lease_deadline = {
      ...input.local_lease_deadline,
      expires_at_ms: Math.min(
        input.deadline.expires_at_ms,
        input.human_lease_deadline.expires_at_ms,
        input.local_lease_deadline.expires_at_ms,
      ),
    };
    this.supervisorSeen();
    this.#changed();
  }
  revoke(input: P0EndpointRevokeInput, context: CommandContext): void {
    assertValid("P0EndpointRevokeInput", input);
    this.observeAuthorityUpdate(input, context);
    if (
      context.caller_instance_id !== this.config.supervisor_identity.instance_id ||
      input.session_id !== this.config.session_id ||
      input.endpoint_instance_id !== this.config.endpoint_instance_id ||
      input.supervisor_instance_id !== this.config.supervisor_identity.instance_id ||
      input.fence.scope_type !== "session" ||
      input.fence.scope_id !== this.config.session_id
    )
      reject("ROLE_SCOPE_DENIED");
    if (
      context.authority_epoch < this.authorityEpoch ||
      input.supervision_epoch < this.#fact.supervision_epoch ||
      input.fence.cancel_epoch !== context.authority_epoch
    )
      reject("SCOPED_EPOCH_CONFLICT");
    if (input.grant_id && !this.#grants.has(input.grant_id) && this.#revoked.size >= 128) {
      this.disconnect();
      reject("QUEUE_LIMIT_EXCEEDED");
    }
    if (input.grant_id) this.#revoked.add(input.grant_id);
    this.#fact.supervision_epoch = input.supervision_epoch;
    this.fence();
  }
  #live(): P0EndpointLease {
    if (!this.#lease || this.#fact.fence_applied || this.finalDeadline !== null)
      reject("EXECUTION_GRANT_REVOKED");
    if (
      !this.#fact.host_connection_deadline ||
      !this.#fact.lease_deadline ||
      Math.min(
        this.#fact.host_connection_deadline.expires_at_ms,
        this.#fact.lease_deadline.expires_at_ms,
      ) <= this.clock.now()
    )
      reject("INPUT_LEASE_EXPIRED");
    return this.#lease;
  }
  execute(input: P0ExecuteInput, context: CommandContext): void {
    assertValid("P0ExecuteInput", input);
    this.tick(false);
    this.#scope(context);
    const { registration: r, action, mapping, receipt } = input;
    if (context.caller_instance_id !== this.config.host_identity.instance_id)
      reject("AUTHENTICATION_REQUIRED");
    if (context.authority_epoch !== this.authorityEpoch) reject("SCOPED_EPOCH_CONFLICT");
    const key = context.operation_id;
    const digest = payloadDigest({ input, context: { ...context, payload_digest: null } });
    const previous = this.#operations.get(key);
    if (previous) {
      if (previous.digest !== digest) reject("OPERATION_PAYLOAD_CONFLICT");
      return;
    }
    const lease = this.#live();
    const g = lease.grant;
    if (
      r.operation_id !== key ||
      r.grant_id !== g.grant_id ||
      context.grant_ref !== g.grant_id ||
      r.session_id !== g.session_id ||
      r.endpoint_instance_id !== this.config.endpoint_instance_id ||
      r.units !== action.units ||
      r.cost_units !== action.cost_units ||
      r.capability !== action.capability ||
      payloadDigest(r.target_ref) !== payloadDigest(action.target_ref) ||
      !g.target_refs.some((target) => payloadDigest(target) === payloadDigest(action.target_ref)) ||
      !g.allowed_capabilities.includes(action.capability)
    )
      reject("SIMULATION_SCOPE_DENIED");
    if (
      r.payload_digest !==
      payloadDigest({
        session_id: r.session_id,
        grant_id: r.grant_id,
        endpoint_instance_id: r.endpoint_instance_id,
        action,
      })
    )
      reject("OPERATION_PAYLOAD_CONFLICT");
    if (
      receipt.writer_instance_id !== lease.receipt.writer_instance_id ||
      !receipt.effect_digests.includes(payloadDigest(r))
    )
      reject("PERSISTENCE_NOT_READY");
    if (
      r.deadline.clock_domain !== mapping.source_clock_domain ||
      mapping.source_instance_id !== this.config.host_identity.instance_id ||
      mapping.target_instance_id !== this.config.endpoint_instance_id ||
      mapping.target_clock_domain !== this.clock.domain
    )
      reject("CLOCK_MAPPING_INVALID");
    const expires = Math.min(
      r.deadline.expires_at_ms + mapping.offset_lower_ms,
      mapping.target_valid_until_ms,
      context.deadline.expires_at_ms,
    );
    if (expires <= this.clock.now()) reject("COMMAND_DEADLINE_MISSED");
    if (
      this.fault() === "budget_exhausted" ||
      this.#reserved + action.units > g.effect_limit ||
      this.#cost + action.cost_units > g.cost_limit_units
    )
      reject("COST_BUDGET_EXCEEDED");
    if (
      this.fault() === "queue_full" ||
      this.#fact.queued_operation_ids.length >= g.queue_limit ||
      this.#operations.size >= 1024
    )
      reject("QUEUE_LIMIT_EXCEEDED");
    const fact = {
      operation_id: key,
      endpoint_instance_id: this.config.endpoint_instance_id,
      grant_id: g.grant_id,
      target_ref: structuredClone(action.target_ref),
      payload_digest: r.payload_digest,
      accepted_seq: this.#fact.accepted_watermark + 1,
      requested_units: action.units,
      completed_units: 0,
      outcome: "accepted" as const,
      occurred_at: this.clock.point(),
      deadline_missed: false,
    };
    // Each fact reserves 160 bytes for all integer/clock growth (safe integers), outcome and boolean changes.
    // Both worst-case ID arrays are included. 4096 covers fixed Session/instance IDs, event/RPC wrappers,
    // lease/cleanup fields and observation counters. These are wire bounds, not timing measurements.
    const prospective = {
      ...this.#fact,
      effect_facts: [...this.#fact.effect_facts, fact],
      queued_operation_ids: [...this.#fact.queued_operation_ids, key],
      not_executed_operation_ids: [...this.#operations.keys(), key],
      unknown_operation_ids: [...this.#operations.keys(), key],
    };
    if (
      Buffer.byteLength(JSON.stringify(prospective)) +
        4096 +
        prospective.effect_facts.length * 160 >
      this.config.limits.max_message_bytes
    )
      reject("QUEUE_LIMIT_EXCEEDED");
    this.#reserved += action.units;
    this.#cost += action.cost_units;
    this.#operations.set(key, {
      digest,
      work: {
        input: structuredClone(input),
        context: structuredClone(context),
        expires,
        next: this.clock.now() + action.interval_ms,
      },
    });
    this.#fact.accepted_watermark++;
    this.#fact.effect_facts.push(fact);
    this.#fact.queued_operation_ids.push(key);
    this.#fact.stopped = false;
    this.#fact.cleanup_ref = null;
    this.#changed();
  }
  fault(): P0FaultSelection["fault"] {
    return this.clock.now() < this.#faultUntil ? this.#fault.fault : "none";
  }
  setFault(selection: P0FaultSelection): void {
    assertValid("P0FaultSelection", selection);
    if (selection.target !== "endpoint") reject("ROLE_SCOPE_DENIED");
    this.#fault = structuredClone(selection);
    this.#faultUntil = this.clock.now() + selection.duration_ms;
  }
  tick(effects = true): void {
    const now = this.clock.now();
    if (
      this.finalDeadline === null &&
      (now >= this.absoluteDeadline - this.config.limits.cleanup_timeout_ms ||
        (this.#fact.host_connection_deadline &&
          now >= this.#fact.host_connection_deadline.expires_at_ms) ||
        now - this.#lastSupervisor >= this.config.limits.peer_health_timeout_ms)
    )
      this.disconnect();
    if (this.#lease && this.#fact.lease_deadline && now >= this.#fact.lease_deadline.expires_at_ms)
      this.fence();
    if (!effects || !this.#fact.queued_operation_ids.length) return;
    const id = this.#fact.queued_operation_ids[0];
    const operation = id ? this.#operations.get(id) : undefined;
    if (!id || !operation) throw new Error("QUEUE_OPERATION_MISSING");
    const work = operation.work;
    if (now >= work.expires) {
      this.fence();
      return;
    }
    this.#live();
    if (
      work.context.authority_epoch !== this.authorityEpoch ||
      work.input.registration.grant_id !== this.#lease?.grant.grant_id
    ) {
      this.fence();
      return;
    }
    if (now < work.next) return;
    const fact = this.#fact.effect_facts.find((item) => item.operation_id === id);
    if (!fact) throw new Error("QUEUE_FACT_MISSING");
    fact.completed_units++;
    fact.occurred_at = this.clock.point();
    this.#fact.completed_effect_count++;
    work.next = now + work.input.action.interval_ms;
    if (fact.completed_units === fact.requested_units) {
      fact.outcome = "completed";
      this.#fact.queued_operation_ids.shift();
      this.#fact.stopped = this.#fact.queued_operation_ids.length === 0;
      if (this.#fact.stopped) this.#fact.cleanup_ref = randomUUID();
    }
    this.#changed();
  }
}
