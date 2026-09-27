import {
  type ExecutionGrant,
  type ObjectRef,
  type P0AdmissionRecord,
  type P0AuthorizeInput,
  type P0ClockMapping,
  type P0ConnectionAnnouncement,
  type P0EffectRegistration,
  type P0EndpointSnapshot,
  type P0IsolationRecord,
  type P0OperatorIdentity,
  type P0PeerIdentity,
  type P0PersistenceReceipt,
  type P0RuntimeConfig,
  type P0SimulationAction,
  type P0StoreCommitInput,
  payloadDigest,
  type RpcRequest,
  type SupervisionRecord,
  schemaDigest,
} from "../../contract-sdk/src/index.ts";

/** Internal evidence, never a wire input or an externally supplied guard result.
 * The coordinator supplies these only after actual channel authentication. The reducer
 * checks the fixed identity, schema, clock and original request bindings again.
 */
export type OperatorFact = {
  request: RpcRequest;
  identity: P0OperatorIdentity;
};
export type EndpointFact = {
  snapshot: P0EndpointSnapshot;
  authorityEpoch: number;
  mapping: P0ClockMapping;
  announcement: P0ConnectionAnnouncement;
  receivedAt: number;
};
export type WorkerFact = {
  input: P0StoreCommitInput;
  receipt: P0PersistenceReceipt;
};
export type EffectEntry = { registration: P0EffectRegistration; action: P0SimulationAction };
export type TrackedEffect = EffectEntry & { authorityEpoch: number };
export type GuardState = {
  config: P0RuntimeConfig;
  session: string;
  host: P0PeerIdentity;
  supervisor: P0PeerIdentity;
  endpoint: P0PeerIdentity;
  worker: string | null;
  clockDomain: string;
  now: number;
  authorityEpoch: number;
  supervision: SupervisionRecord;
  hostHealth: { instance: string; receivedAt: number } | null;
  endpointFact: EndpointFact | null;
  isolation: readonly P0IsolationRecord[];
  grants: readonly ExecutionGrant[];
  effects: readonly TrackedEffect[];
};
export const same = (a: unknown, b: unknown): boolean => payloadDigest(a) === payloadDigest(b);
export const resourceKey = (ref: ObjectRef): string => payloadDigest(ref);

function finiteDeadline(
  deadline: P0AuthorizeInput["grant_deadline"],
  s: GuardState,
  upper: number,
): boolean {
  return (
    deadline.clock_domain === s.clockDomain &&
    deadline.issued_at_ms <= s.now &&
    deadline.expires_at_ms > s.now &&
    deadline.expires_at_ms > deadline.issued_at_ms &&
    deadline.expires_at_ms <= upper
  );
}

/** Historical deadlines may have expired, but must remain in the proven endpoint domain. */
export function endpointDeadlinesValid(fact: P0EndpointSnapshot, mapping: P0ClockMapping): boolean {
  return (
    fact.observed_at.clock_domain === mapping.target_clock_domain &&
    [fact.lease_deadline, fact.host_connection_deadline].every(
      (deadline) =>
        deadline === null ||
        (deadline.clock_domain === mapping.target_clock_domain &&
          deadline.expires_at_ms > deadline.issued_at_ms &&
          deadline.issued_at_ms <= fact.observed_at.monotonic_ms),
    )
  );
}

export function endpointConnectionUpper(s: GuardState): number | null {
  const e = s.endpointFact;
  const deadline = e?.snapshot.host_connection_deadline;
  if (
    !e ||
    !deadline ||
    e.authorityEpoch !== s.authorityEpoch ||
    e.mapping.source_valid_until_ms <= s.now ||
    e.receivedAt > s.now ||
    s.now - e.receivedAt >= s.config.limits.peer_health_timeout_ms ||
    !endpointDeadlinesValid(e.snapshot, e.mapping)
  )
    return null;
  const upper = Math.min(
    deadline.expires_at_ms - e.mapping.offset_upper_ms,
    e.mapping.target_valid_until_ms - e.mapping.offset_upper_ms,
    e.mapping.source_valid_until_ms,
  );
  return upper > s.now ? upper : null;
}

function targetsAllowed(input: P0AuthorizeInput, s: GuardState): boolean {
  const targets = input.target_refs.map(resourceKey);
  return (
    targets.length > 0 &&
    new Set(targets).size === targets.length &&
    input.target_refs.every((target) =>
      s.config.installation.allowed_targets.some((allowed) => same(allowed, target)),
    ) &&
    !s.isolation.some(
      (i) => i.status === "blocked" && targets.includes(resourceKey(i.resource_ref)),
    ) &&
    same(input.allowed_capabilities, s.config.installation.allowed_capabilities) &&
    same(input.allowed_capabilities, s.config.profile.enabled_capabilities)
  );
}

/** A ready finite mechanism/channel is enough; no pre-existing ACTIVE lease is required. */
export function supervisedEntry(s: GuardState, op: OperatorFact | null): boolean {
  if (op?.request.method !== "session.authorize") return false;
  const input = op.request.params.input;
  const upper = endpointConnectionUpper(s);
  return (
    finiteDeadline(op.request.params.context.deadline, s, Number.MAX_SAFE_INTEGER) &&
    op.request.params.context.grant_ref === null &&
    input.mode === "simulation" &&
    input.supervision_mode === "supervised" &&
    !input.public_broadcast_allowed &&
    s.config.profile.mode === "simulation" &&
    same(s.config.profile.enabled_phases, ["P0"]) &&
    s.config.installation.plugin_id === "bellis-p0-fake-device" &&
    s.config.installation.schema_digest === schemaDigest &&
    input.session_id === s.session &&
    input.endpoint_instance_id === s.endpoint.instance_id &&
    s.hostHealth?.instance === s.host.instance_id &&
    s.hostHealth.receivedAt <= s.now &&
    s.now - s.hostHealth.receivedAt < s.config.limits.peer_health_timeout_ms &&
    upper !== null &&
    finiteDeadline(
      input.human_lease_deadline,
      s,
      Math.min(upper, s.now + s.config.limits.max_human_lease_ms),
    ) &&
    finiteDeadline(
      input.grant_deadline,
      s,
      Math.min(upper, s.now + s.config.limits.max_session_ms),
    ) &&
    input.effect_limit <= s.config.limits.max_effects &&
    input.queue_limit <= s.config.limits.max_queue_items &&
    targetsAllowed(input, s)
  );
}

export function humanRenewal(s: GuardState, op: OperatorFact | null): boolean {
  if (op?.request.method !== "session.renew") return false;
  const input = op.request.params.input;
  const old = s.supervision.human_lease_deadline;
  const upper = endpointConnectionUpper(s);
  return (
    op.request.params.context.grant_ref === null &&
    s.supervision.state === "supervised" &&
    input.session_id === s.session &&
    input.supervision_epoch === s.supervision.supervision_epoch &&
    op.identity.operator_id === s.supervision.operator_id &&
    old !== null &&
    old.clock_domain === s.clockDomain &&
    old.monotonic_ms > s.now &&
    upper !== null &&
    input.human_lease_deadline.expires_at_ms > old.monotonic_ms &&
    finiteDeadline(
      input.human_lease_deadline,
      s,
      Math.min(upper, s.now + s.config.limits.max_human_lease_ms),
    )
  );
}

/** Exact committed input/record bindings; a status string or a nonempty receipt is insufficient. */
export function committed(s: GuardState, fact: WorkerFact | null): boolean {
  if (!fact || !s.worker) return false;
  const { input, receipt: r } = fact;
  return (
    input.writer_instance_id === s.worker &&
    r.writer_instance_id === s.worker &&
    (input.batch.supervision === null || input.batch.supervision.record_status === "durable") &&
    [
      ...input.batch.admissions,
      ...input.batch.stops,
      ...input.batch.cleanup,
      ...input.batch.isolation,
    ].every((record) => record.record_status === "durable") &&
    r.transaction_id === input.request_id &&
    r.request_digest === payloadDigest(input) &&
    r.committed_at.clock_domain === s.clockDomain &&
    r.committed_at.monotonic_ms <= s.now &&
    same([...r.grant_digests].sort(), input.batch.grants.map(payloadDigest).sort()) &&
    same([...r.admission_digests].sort(), input.batch.admissions.map(payloadDigest).sort()) &&
    same([...r.effect_digests].sort(), input.batch.effects.map(payloadDigest).sort())
  );
}

export function executionGrant(
  s: GuardState,
  grant: ExecutionGrant,
  admission: P0AdmissionRecord,
  op: OperatorFact,
  fact: WorkerFact | null,
): boolean {
  if (op.request.method !== "session.authorize" || !fact) return false;
  const i = op.request.params.input;
  return (
    grant.state === "REQUESTED" &&
    s.supervision.state === "supervised" &&
    s.supervision.operator_id === op.identity.operator_id &&
    s.supervision.human_lease_deadline !== null &&
    s.supervision.human_lease_deadline.monotonic_ms > s.now &&
    supervisedEntry(s, op) &&
    grant.supervision_epoch === s.supervision.supervision_epoch &&
    grant.session_id === s.session &&
    grant.host_instance_id === s.host.instance_id &&
    grant.supervisor_instance_id === s.supervisor.instance_id &&
    grant.endpoint_instance_id === s.endpoint.instance_id &&
    grant.operator_id === op.identity.operator_id &&
    grant.mode === "simulation" &&
    !grant.public_broadcast_allowed &&
    grant.profile_ref === "p0-runtime-configuration@1" &&
    same(grant.deadline, i.grant_deadline) &&
    same(grant.target_refs, i.target_refs) &&
    same(
      grant.allowed_capabilities,
      i.allowed_capabilities.map((c) => c.name),
    ) &&
    grant.effect_limit === i.effect_limit &&
    grant.queue_limit === i.queue_limit &&
    grant.cost_limit_units === i.cost_limit_units &&
    grant.admission_ref === admission.admission_id &&
    admission.session_id === s.session &&
    admission.host_instance_id === s.host.instance_id &&
    admission.supervisor_instance_id === s.supervisor.instance_id &&
    admission.endpoint_instance_id === s.endpoint.instance_id &&
    admission.operator_id === op.identity.operator_id &&
    admission.installation_id === s.config.installation.installation_id &&
    admission.installation_digest === payloadDigest(s.config.installation) &&
    admission.manifest_digest === s.config.installation.manifest_digest &&
    admission.profile_digest === payloadDigest(s.config.profile) &&
    admission.schema_digest === schemaDigest &&
    admission.accepted_at.clock_domain === s.clockDomain &&
    admission.accepted_at.monotonic_ms <= s.now &&
    committed(s, fact) &&
    fact.receipt.grant_digests.includes(payloadDigest(grant)) &&
    fact.receipt.admission_digests.includes(
      payloadDigest({ ...admission, record_status: "durable" }),
    )
  );
}

/** Full instance history, not queue length or stop acknowledgement alone. */
export function localEffectStopped(s: GuardState, e: EndpointFact | null): boolean {
  if (!e || e.authorityEpoch !== s.authorityEpoch) return false;
  const f = e.snapshot;
  if (
    f.endpoint_instance_id !== s.endpoint.instance_id ||
    f.session_id !== s.session ||
    f.supervisor_instance_id !== s.supervisor.instance_id ||
    f.supervision_epoch > s.supervision.supervision_epoch ||
    !f.fence_applied ||
    !f.stopped ||
    f.active_grant_ref !== null ||
    f.lease_deadline !== null ||
    f.cleanup_ref === null ||
    f.queued_operation_ids.length ||
    f.unknown_operation_ids.length ||
    f.accepted_watermark !== f.effect_facts.length ||
    new Set(f.effect_facts.map((x) => x.operation_id)).size !== f.effect_facts.length ||
    new Set(f.not_executed_operation_ids).size !== f.not_executed_operation_ids.length
  )
    return false;
  const facts = [...f.effect_facts].sort((a, b) => a.accepted_seq - b.accepted_seq);
  let completed = 0;
  for (const [n, item] of facts.entries()) {
    const entry = s.effects.find((x) => x.registration.operation_id === item.operation_id);
    const grant = s.grants.find((g) => g.grant_id === item.grant_id);
    if (!entry || !grant || grant.supervision_epoch > f.supervision_epoch) return false;
    const r = entry.registration;
    if (
      item.accepted_seq !== n + 1 ||
      item.endpoint_instance_id !== s.endpoint.instance_id ||
      item.grant_id !== r.grant_id ||
      !same(item.target_ref, r.target_ref) ||
      item.payload_digest !== r.payload_digest ||
      item.requested_units !== r.units ||
      item.completed_units > item.requested_units ||
      !["completed", "stopped"].includes(item.outcome) ||
      (item.outcome === "completed" && item.completed_units !== item.requested_units) ||
      (item.outcome === "stopped" && item.completed_units === item.requested_units) ||
      item.occurred_at.clock_domain !== f.observed_at.clock_domain ||
      item.occurred_at.monotonic_ms > f.observed_at.monotonic_ms ||
      (item.completed_units === 0) !== f.not_executed_operation_ids.includes(item.operation_id)
    )
      return false;
    completed += item.completed_units;
  }
  if (completed !== f.completed_effect_count || !Number.isSafeInteger(completed)) return false;
  // A complete post-revocation history is negative evidence for a registered but
  // never accepted old-epoch operation. Local dispatch is fenced, and any late old
  // message will fail at the endpoint. Retain the registration; never infer absence
  // from an empty queue, lost acknowledgement or an unadvanced epoch alone.
  if (
    s.effects.some(
      (entry) =>
        !facts.some((f) => f.operation_id === entry.registration.operation_id) &&
        (entry.authorityEpoch >= e.authorityEpoch ||
          s.grants.some(
            (g) =>
              g.grant_id === entry.registration.grant_id &&
              (g.state === "ACTIVE" || g.state === "REQUESTED"),
          )),
    )
  )
    return false;
  if (f.not_executed_operation_ids.some((id) => !facts.some((f) => f.operation_id === id)))
    return false;
  for (const grant of s.grants) {
    const entries = s.effects.filter((e) => e.registration.grant_id === grant.grant_id);
    if (
      entries.reduce((sum, e) => sum + e.registration.units, 0) > grant.effect_limit ||
      entries.reduce((sum, e) => sum + e.registration.cost_units, 0) > grant.cost_limit_units
    )
      return false;
  }
  return true;
}

export function outputsSafe(s: GuardState): boolean {
  return s.config.installation.allowed_targets.every((target) =>
    s.isolation.some(
      (i) =>
        same(i.resource_ref, target) &&
        i.recovery_owner_ref === s.supervisor.instance_id &&
        (i.status === "blocked" || (i.status === "proven_clean" && i.evidence_refs.length > 0)),
    ),
  );
}
