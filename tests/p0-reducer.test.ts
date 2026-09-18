import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { after, test } from "node:test";
import { stateMachines } from "../contracts/generated/registries.ts";
import {
  assertValid,
  type P0IsolationRecord,
  payloadDigest,
} from "../packages/contract-sdk/src/index.ts";
import { completeRequest } from "../packages/runtime/src/identity.ts";
import { type GuardState, outputsSafe } from "../packages/runtime/src/p0-guards.ts";
import type { P0Input, P0Timer } from "../packages/runtime/src/p0-reducer.ts";
import { moduleReductions, reducerFixture, reductions } from "./p0-reducer.helpers.ts";

function required<T>(value: T | null | undefined): T {
  assert.ok(value);
  return value;
}

test("p0.reducer module: default zero authority, actual source bindings and no boolean input", () => {
  const f = reducerFixture();
  assert.equal(f.core.supervision.state, "stopped");
  assert.deepEqual(f.core.snapshot().grants, []);
  assert.equal(f.core.snapshot().persistence, "blocked");
  assert.equal(f.core.canExecute("missing"), false);
  assert.throws(() => f.core.supervise("safe_stop", { kind: "command" } as P0Input), /UNBOUND/);
  const op = f.stop();
  assert.throws(() =>
    f.core.command(op.request, { ...op.identity, operator_id: "" }, op.announcement, op.trigger),
  );
  assert.throws(
    () =>
      f.core.command(op.request, op.identity, op.announcement, {
        ...op.trigger,
        trigger_id: "a".repeat(64),
      }),
    /TRIGGER/,
  );
  const wrongEpoch = structuredClone(op.request);
  wrongEpoch.params.context.authority_epoch++;
  assert.throws(
    () => f.core.command(wrongEpoch, op.identity, op.announcement, op.trigger),
    /EPOCH/,
  );
  const before = reductions(f).length;
  assert.throws(() => f.core.supervise("grace_deadline", op.token), /TIMER_INPUT/);
  assert.equal(reductions(f).length, before);
  const allowed = f.core.supervise("safe_stop", op.token);
  assert.equal(allowed.disposition, "accepted");
  assert.equal(f.core.authorityEpoch, 1);
  assert.ok(
    f.core.snapshot().stops.every((s) => s.local_fence_applied && s.record_status === "pending"),
  );
  assert.ok(f.core.takeActions().some((a) => a.kind === "endpoint_revoke"));
});

test("p0.reducer module: supervised entry needs every finite readiness fact; disabled modes stay rejected", () => {
  const missingHealth = reducerFixture();
  missingHealth.fact();
  assert.equal(missingHealth.authorize().decision.disposition, "guard_rejected");
  const missingEndpoint = reducerFixture();
  missingEndpoint.health();
  assert.equal(missingEndpoint.authorize().decision.disposition, "guard_rejected");
  const notReady = reducerFixture();
  notReady.health();
  notReady.fact({ host_connection_deadline: null });
  assert.equal(notReady.authorize().decision.disposition, "guard_rejected");
  for (const override of [
    { mode: "test_only" },
    { mode: "public", public_broadcast_allowed: true },
    { supervision_mode: "unattended_approved" },
    { endpoint_instance_id: "other" },
    { target_refs: [{ kind: "SimulationTarget", id: "other" }] },
    { allowed_capabilities: [{ name: "unknown", version: "0.8.0" }] },
    { effect_limit: 17 },
    { queue_limit: 9 },
    {
      human_lease_deadline: {
        clock_domain: "wrong-clock",
        issued_at_ms: 1000,
        expires_at_ms: 2000,
      },
    },
    {
      grant_deadline: {
        clock_domain: "module-supervisor-clock",
        issued_at_ms: 1000,
        expires_at_ms: 9000,
      },
    },
  ]) {
    const f = reducerFixture();
    f.health();
    f.fact();
    const result = f.authorize(override);
    assert.equal(result.decision.disposition, "guard_rejected", JSON.stringify(override));
    assert.equal(f.core.supervision.state, "stopped");
    assert.equal(result.grant, null);
  }
  const f = reducerFixture();
  f.health();
  f.fact();
  const result = f.authorize();
  assert.equal(result.decision.to, "supervised");
  assert.equal(result.grant?.state, "REQUESTED");
  assert.equal(result.grant?.profile_ref, "p0-runtime-configuration@1");
  assert.deepEqual(result.grant?.gate_evidence_refs, []);
  assert.equal(f.core.canExecute(result.grant?.grant_id ?? ""), false);
  const second = f.authorize();
  assert.equal(second.decision.disposition, "table_rejected");
  assert.equal(second.decision.guard_result, null);
  assert.equal(f.core.snapshot().grants.length, 1);
});

test("p0.reducer module: REQUESTED + exact committed durable admission, then ACTIVE commit and real lease", () => {
  const f = reducerFixture();
  f.health();
  f.fact();
  const a = f.authorize();
  assert.ok(a.grant);
  assert.equal(
    f.core.reduceGrant(a.grant.grant_id, "approve", a.token).disposition,
    "guard_rejected",
  );
  const r = f.receipt(a.grant);
  assert.throws(
    () => f.core.workerReceipt(r.input, { ...r.receipt, writer_instance_id: "wrong" }),
    /PERSISTENCE/,
  );
  assert.throws(
    () => f.core.workerReceipt(r.input, { ...r.receipt, grant_digests: [] }),
    /PERSISTENCE/,
  );
  const malformedInput = structuredClone(r.input);
  required(malformedInput.batch.admissions[0]).profile_digest = "b".repeat(64);
  const malformedReceipt = {
    ...r.receipt,
    request_digest: payloadDigest(malformedInput),
    admission_digests: malformedInput.batch.admissions.map(payloadDigest),
  };
  const malformed = f.core.workerReceipt(malformedInput, malformedReceipt);
  assert.equal(
    f.core.reduceGrant(a.grant.grant_id, "approve", malformed).disposition,
    "guard_rejected",
  );
  assert.equal(f.core.reduceGrant(a.grant.grant_id, "approve", r.token).to, "ACTIVE");
  const active = f.core.grant(a.grant.grant_id);
  assert.ok(active);
  assert.equal(f.core.canExecute(active.grant_id), false);
  f.core.bindActiveCommit(active.grant_id, f.receipt(active).token);
  assert.equal(f.core.canExecute(active.grant_id), false);
  f.fact({
    active_grant_ref: active.grant_id,
    supervision_epoch: active.supervision_epoch,
    fence_applied: false,
    lease_deadline: {
      clock_domain: f.endpointClock.domain,
      issued_at_ms: 1000,
      expires_at_ms: 1500,
    },
  });
  assert.equal(f.core.canExecute(active.grant_id), true);
  const before = active.deadline;
  f.clock.time = 1500;
  assert.equal(f.core.canExecute(active.grant_id), false);
  assert.deepEqual(f.core.grant(active.grant_id)?.deadline, before);
});

test("p0.reducer module: original command timeout rejects delayed approve and stale renewal token", () => {
  const f = reducerFixture();
  f.health();
  f.fact();
  const a = f.authorize({
    human_lease_deadline: { clock_domain: f.clock.domain, issued_at_ms: 1000, expires_at_ms: 3500 },
    grant_deadline: { clock_domain: f.clock.domain, issued_at_ms: 1000, expires_at_ms: 3500 },
  });
  assert.ok(a.grant);
  const receipt = f.receipt(a.grant);
  f.clock.time = a.request.params.context.deadline.expires_at_ms;
  f.health();
  f.fact();
  assert.equal(
    f.core.reduceGrant(a.grant.grant_id, "approve", receipt.token).disposition,
    "guard_rejected",
  );
  const renewal = f.command("session.renew", {
    session_id: "module-session",
    supervision_epoch: f.core.supervision.supervision_epoch,
    human_lease_deadline: {
      clock_domain: f.clock.domain,
      issued_at_ms: f.clock.now(),
      expires_at_ms: 3900,
    },
  });
  f.clock.time = renewal.request.params.context.deadline.expires_at_ms;
  assert.throws(() => f.core.supervise("human_renewal", renewal.token), /DEADLINE/);
});

test("p0.reducer module: human renewal is explicit; heartbeat never changes human/grant deadlines or epochs", () => {
  const f = reducerFixture();
  const grant = f.active();
  const epoch = f.core.supervision.supervision_epoch,
    authority = f.core.authorityEpoch;
  const oldDeadline = grant.deadline;
  const renewal = f.command("session.renew", {
    session_id: "module-session",
    supervision_epoch: epoch,
    human_lease_deadline: { clock_domain: f.clock.domain, issued_at_ms: 1000, expires_at_ms: 2500 },
  });
  assert.equal(f.core.supervise("human_renewal", renewal.token).disposition, "accepted");
  assert.equal(f.core.supervision.supervision_epoch, epoch);
  assert.equal(f.core.authorityEpoch, authority);
  assert.deepEqual(f.core.grant(grant.grant_id)?.deadline, oldDeadline);
  const bad = f.command("session.renew", {
    session_id: "module-session",
    supervision_epoch: epoch + 1,
    human_lease_deadline: { clock_domain: f.clock.domain, issued_at_ms: 1000, expires_at_ms: 2600 },
  });
  assert.equal(f.core.supervise("human_renewal", bad.token).disposition, "guard_rejected");
  const timer = f.core.timer("SupervisionMode", "module-session", "supervision_lost");
  f.clock.time = 2500;
  f.health();
  assert.equal(f.core.fire(timer).decision?.to, "restricted");
  assert.equal(f.core.supervision.connection_healthy, true);
  const human = f.core.supervision.human_lease_deadline;
  const epochAfter = f.core.supervision.supervision_epoch;
  assert.equal(f.core.supervise("heartbeat", f.health()).to, "restricted");
  assert.deepEqual(f.core.supervision.human_lease_deadline, human);
  assert.equal(f.core.supervision.supervision_epoch, epochAfter);
  assert.equal(f.core.grant(grant.grant_id)?.state, "REVOKED");
  const lateRenewal = f.command("session.renew", {
    session_id: "module-session",
    supervision_epoch: epochAfter,
    human_lease_deadline: { clock_domain: f.clock.domain, issued_at_ms: 2500, expires_at_ms: 3500 },
  });
  assert.equal(f.core.supervise("human_renewal", lateRenewal.token).disposition, "table_rejected");
});

test("p0.reducer module: timer source/deadline binding, early callback, health replacement and no fake coverage", () => {
  const f = reducerFixture();
  f.active();
  const timer = f.core.timer("SupervisionMode", "module-session", "supervision_lost");
  const count = reductions(f).length;
  assert.deepEqual(f.core.fire(timer), { reschedule: timer.deadline, decision: null });
  assert.equal(reductions(f).length, count);
  for (const broken of [
    { ...timer },
    { ...timer, deadline: { ...timer.deadline, clock_domain: "other" } },
    { ...timer, owner_instance_id: "other" },
  ])
    assert.throws(() => f.core.fire(broken as P0Timer), /INVALID_TIMER/);
  const hostTimer = f.core.timer(
    "SupervisionMode",
    "module-session",
    "supervision_lost",
    "host_health",
  );
  f.clock.time += 10;
  f.health();
  assert.throws(() => f.core.fire(hostTimer), /INVALID_TIMER/);
  assert.equal(reductions(f).length, count);
  const current = f.core.timer(
    "SupervisionMode",
    "module-session",
    "supervision_lost",
    "host_health",
  );
  f.clock.time = current.deadline.monotonic_ms;
  assert.equal(f.core.fire(current).decision?.to, "restricted");
  const grace = f.core.timer("SupervisionMode", "module-session", "grace_deadline");
  f.clock.time = grace.deadline.monotonic_ms;
  assert.equal(f.core.fire(grace).decision?.to, "safe_stopping");
  const final = f.core.timer("SupervisionMode", "module-session", "stop_timeout");
  f.clock.time = final.deadline.monotonic_ms;
  assert.equal(f.core.fire(final).decision?.to, "stopped");
  assert.ok(f.core.snapshot().isolation.every((i) => i.status === "blocked"));
  assert.equal(f.core.supervise("heartbeat", f.health()).to, "stopped");
});

test("p0.reducer module: target/grant scope rejection has no safety side effects; terminals never revive", () => {
  const f = reducerFixture();
  const grant = f.active();
  const badStop = f.command("session.stop", {
    session_id: "module-session",
    target_ref: { kind: "SimulationTarget", id: "other" },
    reason: "operator_request",
  });
  const before = f.core.snapshot();
  assert.equal(f.core.supervise("safe_stop", badStop.token).disposition, "guard_rejected");
  assert.deepEqual(f.core.snapshot(), before);
  const badRevoke = f.command("session.revoke", {
    session_id: "module-session",
    grant_id: "other",
    reason: "operator_request",
  });
  assert.equal(
    f.core.reduceGrant(grant.grant_id, "revoke", badRevoke.token).disposition,
    "guard_rejected",
  );
  assert.equal(f.core.authorityEpoch, 0);
  const stop = f.stop();
  assert.equal(f.core.reduceGrant(grant.grant_id, "revoke", stop.token).to, "REVOKED");
  const current = f.stop();
  for (const event of ["approve", "deny", "revoke", "complete"]) {
    const r = f.core.reduceGrant(grant.grant_id, event, current.token);
    assert.equal(r.disposition, "terminal_rejected");
    assert.equal(r.guard_result, null);
  }
  assert.throws(() => f.core.supervise("safe_stop", stop.token), /EPOCH/);
  assert.equal(f.core.canExecute(grant.grant_id), false);
});

test("p0.reducer module: grant deny/expiry in each reachable source and table rejections", () => {
  for (const active of [false, true]) {
    const f = reducerFixture();
    let grant: ReturnType<typeof f.active> | null = null;
    if (active) grant = f.active();
    else {
      f.health();
      f.fact();
      grant = f.authorize().grant;
    }
    assert.ok(grant);
    const timer = f.core.timer("ExecutionGrant", grant.grant_id, "deadline");
    f.clock.time = timer.deadline.monotonic_ms;
    assert.equal(f.core.fire(timer).decision?.to, "EXPIRED");
    assert.equal(f.core.fire(timer).decision?.disposition, "terminal_rejected");
    assert.equal(f.core.canExecute(grant.grant_id), false);
  }
  const f = reducerFixture();
  f.health();
  f.fact();
  const a = f.authorize();
  assert.ok(a.grant);
  assert.equal(
    f.core.reduceGrant(a.grant.grant_id, "natural_complete", a.token).disposition,
    "table_rejected",
  );
  assert.equal(f.core.reduceGrant(a.grant.grant_id, "deny", a.token).to, "DENIED");
  assert.equal(
    f.core.reduceGrant(a.grant.grant_id, "approve", a.token).disposition,
    "terminal_rejected",
  );
});

test("p0.reducer module: natural completion before/after stop preserves actual effects and clean terminal", () => {
  for (const before of [true, false]) {
    const f = reducerFixture();
    const grant = f.active();
    const work = f.completed(grant);
    const completed = {
      effect_facts: [work.effect],
      accepted_watermark: 1,
      completed_effect_count: 2,
    };
    if (before) f.fact(completed);
    f.core.supervise("safe_stop", f.stop().token);
    f.fact({
      ...completed,
      active_grant_ref: null,
      lease_deadline: null,
      fence_applied: true,
      stopped: true,
      cleanup_ref: "actual-cleanup",
    });
    const snapshot = f.core.snapshot();
    assert.ok(snapshot.stops.every((s) => s.state === "CONFIRMED"));
    assert.ok(snapshot.cleanup.every((c) => c.status === "confirmed"));
    assert.equal(snapshot.endpoint.fact?.completed_effect_count, 2);
    assert.equal(snapshot.endpoint.fact?.effect_facts[0]?.outcome, "completed");
    assert.equal(f.core.grant(grant.grant_id)?.state, "REVOKED");
    const input = f.fact();
    assert.equal(
      f.core.reduceStop(required(snapshot.stops[0]).stop_operation_id, "local_ack", input)
        .disposition,
      "terminal_rejected",
    );
    assert.equal(f.core.supervise("outputs_accounted", input).to, "stopped");
  }
});

test("p0.reducer module: UNKNOWN stays terminal, late cleanup separate, old incident stays blocked", () => {
  const old: P0IsolationRecord = {
    isolation_id: "old",
    resource_ref: { kind: "SimulationTarget", id: "counter" },
    endpoint_instance_id: "old-instance",
    incident_ref: "old-incident",
    recovery_owner_ref: "old-owner",
    status: "blocked",
    evidence_refs: [],
    record_status: "failed",
  };
  const f = reducerFixture([old]);
  f.core.supervise("safe_stop", f.stop().token);
  const firstPersist = f.core.takeActions().filter((a) => a.kind === "persist");
  for (const kind of ["StopOperation", "P0CleanupRecord", "P0IsolationRecord"]) {
    const action = firstPersist.find((a) => a.object_ref.kind === kind);
    assert.ok(action);
    assert.ok(f.core.persistenceRecord(action.object_ref));
  }
  const stop = required(f.core.snapshot().stops[0]);
  const timer = f.core.timer("StopOperation", stop.stop_operation_id, "deadline");
  f.clock.time = timer.deadline.monotonic_ms;
  assert.equal(f.core.fire(timer).decision?.to, "UNKNOWN");
  assert.ok(
    f.core
      .takeActions()
      .some((a) => a.kind === "persist" && a.object_ref.kind === "P0CleanupRecord"),
  );
  f.fact({ cleanup_ref: "late-cleanup" });
  const lateActions = f.core.takeActions();
  assert.ok(
    lateActions.some((a) => a.kind === "persist" && a.object_ref.kind === "P0CleanupRecord"),
  );
  assert.ok(
    lateActions.some((a) => a.kind === "persist" && a.object_ref.kind === "P0IsolationRecord"),
  );
  assert.ok(!lateActions.some((a) => a.kind === "persist" && a.object_ref.kind === "Session"));
  f.core.endpointFact(f.endpointSource(f.currentFact()));
  assert.deepEqual(f.core.takeActions(), []);
  const snapshot = f.core.snapshot();
  assert.equal(snapshot.stops[0]?.state, "UNKNOWN");
  assert.equal(snapshot.stops[0]?.endpoint_fact, null);
  assert.equal(snapshot.cleanup[0]?.status, "confirmed");
  assert.equal(snapshot.isolation.find((i) => i.isolation_id === "old")?.status, "blocked");
  assert.equal(snapshot.supervision.blocked_scopes.length, 1);
  assert.equal(f.core.supervise("outputs_accounted", f.fact()).to, "stopped");
  f.health();
  assert.equal(f.authorize().decision.disposition, "guard_rejected");
});

test("p0.reducer module: complete negative history accounts registered but never accepted old operation", () => {
  const f = reducerFixture();
  const grant = f.active();
  f.completed(grant); // registration/in-flight only; never accepted.
  f.core.supervise("safe_stop", f.stop().token);
  f.fact({
    active_grant_ref: null,
    lease_deadline: null,
    fence_applied: false,
    stopped: true,
    cleanup_ref: "not-proof",
  });
  assert.ok(f.core.snapshot().stops.every((s) => s.state === "REQUESTED"));
  f.fact({ fence_applied: true, cleanup_ref: "actual-fence" });
  assert.ok(f.core.snapshot().stops.every((s) => s.state === "CONFIRMED"));
});

test("p0.reducer module: incomplete/conflicting endpoint history never clears isolation", () => {
  for (const mutate of [
    (x: ReturnType<ReturnType<typeof reducerFixture>["currentFact"]>) => {
      x.accepted_watermark = 2;
    },
    (x: ReturnType<ReturnType<typeof reducerFixture>["currentFact"]>) => {
      x.completed_effect_count = 1;
    },
    (x: ReturnType<ReturnType<typeof reducerFixture>["currentFact"]>) => {
      required(x.effect_facts[0]).accepted_seq = 2;
    },
    (x: ReturnType<ReturnType<typeof reducerFixture>["currentFact"]>) => {
      required(x.effect_facts[0]).payload_digest = "b".repeat(64);
    },
    (x: ReturnType<ReturnType<typeof reducerFixture>["currentFact"]>) => {
      x.unknown_operation_ids = ["unknown"];
    },
  ]) {
    const f = reducerFixture();
    const grant = f.active();
    const work = f.completed(grant);
    f.core.supervise("safe_stop", f.stop().token);
    const snapshot = {
      ...f.currentFact(),
      active_grant_ref: null,
      lease_deadline: null,
      fence_applied: true,
      stopped: true,
      cleanup_ref: "not-sufficient",
      accepted_watermark: 1,
      completed_effect_count: 2,
      effect_facts: [work.effect],
    };
    mutate(snapshot);
    f.fact({ ...snapshot, source_revision: snapshot.source_revision + 1 });
    assert.ok(f.core.snapshot().stops.every((s) => s.state === "REQUESTED"));
    assert.ok(f.core.snapshot().isolation.every((i) => i.status === "blocked"));
  }
});

test("p0.reducer module: query requires actual epoch/clock correlation, unchanged observed_at remains valid", () => {
  const f = reducerFixture();
  f.health();
  f.fact();
  const observed = f.currentFact().observed_at;
  f.clock.time += 10;
  const unchanged = f.endpointSource({ observed_at: observed });
  assert.doesNotThrow(() => f.core.endpointFact(unchanged));
  const old = f.endpointSource();
  f.core.supervise("safe_stop", f.stop().token);
  assert.throws(() => f.core.endpointFact(old), /EPOCH/);
  const fresh = f.endpointSource({ observed_at: observed, cleanup_ref: "clean" });
  // An already authenticated connection may retain an earlier signed announcement;
  // current query context/response must still prove the new owner epoch.
  fresh.announcement = old.announcement;
  fresh.mapping = old.mapping;
  fresh.delivery.request = completeRequest(
    "simulation.query",
    {
      session_id: "module-session",
      endpoint_instance_id: f.endpoint.public.instance_id,
      mapping: old.mapping,
    },
    {
      ...fresh.delivery.request.params.context,
      deadline: old.delivery.request.params.context.deadline,
    },
  );
  fresh.delivery.response.id = fresh.delivery.request.id;
  assert.doesNotThrow(() => f.core.endpointFact(fresh));
  const wrongClock = f.endpointSource({
    observed_at: { clock_domain: "wrong", monotonic_ms: 1000 },
  });
  assert.throws(() => f.core.endpointFact(wrongClock), /EPOCH/);
  const wrongInstance = f.endpointSource({
    observed_at: f.endpointClock.point(),
    endpoint_instance_id: "old",
  });
  assert.throws(() => f.core.endpointFact(wrongInstance), /EPOCH/);
  const noMapping = { ...fresh, mapping: undefined };
  assert.throws(() =>
    f.core.endpointFact(noMapping as unknown as Parameters<typeof f.core.endpointFact>[0]),
  );
});

test("p0.reducer module: restricted reauthorization requires proved cleanup; unattended rejected in all reachable sources", () => {
  for (const state of ["stopped", "supervised", "restricted"] as const) {
    const f = reducerFixture();
    if (state !== "stopped") f.active();
    else {
      f.health();
      f.fact();
    }
    if (state === "restricted") {
      const timer = f.core.timer("SupervisionMode", "module-session", "supervision_lost");
      f.clock.time = timer.deadline.monotonic_ms;
      f.core.fire(timer);
    }
    const input = f.command("session.authorize", {
      session_id: "module-session",
      endpoint_instance_id: f.endpoint.public.instance_id,
      mode: "simulation",
      supervision_mode: "unattended_approved",
      target_refs: [f.target],
      allowed_capabilities: f.config.profile.enabled_capabilities,
      effect_limit: 1,
      queue_limit: 1,
      cost_limit_units: 0,
      human_lease_deadline: {
        clock_domain: f.clock.domain,
        issued_at_ms: f.clock.now(),
        expires_at_ms: f.clock.now() + 100,
      },
      grant_deadline: {
        clock_domain: f.clock.domain,
        issued_at_ms: f.clock.now(),
        expires_at_ms: f.clock.now() + 100,
      },
      public_broadcast_allowed: false,
    });
    assert.equal(f.core.supervise("approve_unattended", input.token).disposition, "guard_rejected");
    assert.equal(f.core.supervision.state, state);
  }
  const f = reducerFixture();
  f.active();
  const timer = f.core.timer("SupervisionMode", "module-session", "supervision_lost");
  f.clock.time = timer.deadline.monotonic_ms;
  f.core.fire(timer);
  f.health();
  assert.equal(f.authorize().decision.disposition, "guard_rejected");
  f.fact({
    active_grant_ref: null,
    lease_deadline: null,
    fence_applied: true,
    stopped: true,
    cleanup_ref: "clean",
  });
  assert.equal(f.authorize().decision.to, "supervised");
});

test("p0.reducer module: outputs-safe checks actual owned per-resource isolation; no empty-set shortcut", () => {
  const f = reducerFixture();
  // Pure guard negative for a missing coordinator record; production fence reserves it.
  const s: GuardState = {
    config: f.config,
    session: "module-session",
    host: f.host.public,
    supervisor: f.supervisor.public,
    endpoint: f.endpoint.public,
    worker: null,
    clockDomain: f.clock.domain,
    now: f.clock.now(),
    authorityEpoch: 0,
    supervision: f.core.supervision,
    hostHealth: null,
    endpointFact: null,
    isolation: [],
    grants: [],
    effects: [],
  };
  assert.equal(outputsSafe(s), false);
  f.core.supervise("safe_stop", f.stop().token);
  s.isolation = f.core.snapshot().isolation;
  assert.equal(outputsSafe(s), true);
  s.isolation = s.isolation.map((i) => ({ ...i, recovery_owner_ref: "wrong" }));
  assert.equal(outputsSafe(s), false);
});

test("p0.reducer module: reductions are real schema-valid records, no guard on table/terminal rejection; end includes stream", async () => {
  const f = reducerFixture();
  f.core.supervise("unknown_event", f.stop().token);
  f.core.supervise("safe_stop", f.stop().token);
  const stop = required(f.core.snapshot().stops[0]);
  assert.equal(
    f.core.reduceStop(stop.stop_operation_id, "unknown_event", f.stop().token).disposition,
    "table_rejected",
  );
  const deadline = f.core.timer("StopOperation", stop.stop_operation_id, "deadline");
  f.clock.time = deadline.deadline.monotonic_ms;
  f.core.fire(deadline);
  f.core.reduceStop(stop.stop_operation_id, "local_ack", f.fact({ cleanup_ref: "done" }));
  const records = reductions(f);
  assert.ok(records.length > 3);
  for (const record of records) {
    assertValid("P0ReductionObservation", record);
    assert.ok(!("scenario_id" in record));
  }
  assert.ok(
    records.some(
      (r) => r.disposition === "terminal_rejected" && r.guard === null && r.guard_result === null,
    ),
  );
  const finished = await f.writer.finish();
  assert.equal(finished.complete, true);
  assert.ok(
    f.lines.some(
      (line) =>
        !!line && typeof line === "object" && "stream" in line && line.stream === "reduction",
    ),
  );
});

test("p0.reducer module: duplicate authorize across new authentication does not change fixed operation", () => {
  const f = reducerFixture();
  f.health();
  f.fact();
  const operation = randomUUID(),
    a = f.authorize({}, operation);
  assert.ok(a.grant);
  const before = reductions(f).length;
  const duplicate = f.authorize({}, operation);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.grant?.grant_id, a.grant.grant_id);
  assert.equal(reductions(f).length, before);
  assert.equal(f.core.snapshot().grants.length, 1);
  assert.throws(() => f.authorize({ effect_limit: 1 }, operation), /PAYLOAD_CONFLICT/);
  f.clock.time += 1;
  assert.throws(() => f.authorize({}, operation), /PAYLOAD_CONFLICT/);
  f.clock.time = a.request.params.context.deadline.expires_at_ms;
  assert.throws(() => f.core.requestGrant(a.token), /DEADLINE/);
});

test("p0.reducer module: requested revoke and late receipt never activate revoked/expired grant", () => {
  for (const event of ["revoke", "deadline"] as const) {
    const f = reducerFixture();
    f.health();
    f.fact();
    const a = f.authorize();
    assert.ok(a.grant);
    const r = f.receipt(a.grant);
    if (event === "revoke") {
      const revoke = f.command("session.revoke", {
        session_id: "module-session",
        grant_id: a.grant.grant_id,
        reason: "operator_request",
      });
      assert.equal(f.core.reduceGrant(a.grant.grant_id, "revoke", revoke.token).to, "REVOKED");
    } else {
      const timer = f.core.timer("ExecutionGrant", a.grant.grant_id, "deadline");
      f.clock.time = timer.deadline.monotonic_ms;
      assert.equal(f.core.fire(timer).decision?.to, "EXPIRED");
    }
    assert.equal(
      f.core.reduceGrant(a.grant.grant_id, "approve", r.token).disposition,
      "terminal_rejected",
    );
    assert.throws(
      () => f.core.bindActiveCommit(required(a.grant).grant_id, r.token),
      /PERSISTENCE/,
    );
    assert.equal(f.core.canExecute(a.grant.grant_id), false);
  }
});

test("p0.reducer module: health expiry blocks execution immediately, before timer delivery", () => {
  const f = reducerFixture();
  const grant = f.active({
    human_lease_deadline: { clock_domain: f.clock.domain, issued_at_ms: 1000, expires_at_ms: 4500 },
    grant_deadline: { clock_domain: f.clock.domain, issued_at_ms: 1000, expires_at_ms: 4500 },
  });
  f.clock.time = 3000;
  f.fact({
    lease_deadline: {
      clock_domain: f.endpointClock.domain,
      issued_at_ms: 3000,
      expires_at_ms: 4000,
    },
  });
  assert.equal(f.core.supervision.state, "supervised");
  assert.equal(f.core.canExecute(grant.grant_id), false);
  const endpointTimer = f.core.timer(
    "SupervisionMode",
    "module-session",
    "supervision_lost",
    "endpoint_health",
  );
  assert.equal(endpointTimer.deadline.monotonic_ms, 5000);
  const connectionTimer = f.core.timer(
    "SupervisionMode",
    "module-session",
    "supervision_lost",
    "endpoint_connection",
  );
  assert.ok(connectionTimer.deadline.monotonic_ms < 4900);
});

test("p0.reducer module: actual process/channel failure bindings drive supervision loss, not synthetic timers", () => {
  for (const kind of ["process", "protocol"] as const) {
    const f = reducerFixture();
    f.active();
    const record =
      kind === "process"
        ? f.writer.process({
            kind: "exited",
            launch_id: "actual-launch",
            child_role: "host",
            expected_instance_id: f.host.public.instance_id,
            actual_pid: 1234,
            exit_code: null,
            signal: "SIGTERM",
          })
        : f.writer.protocol("actual-connection", {
            kind: "local_failure",
            stage: "close",
            request_id: null,
            request_digest: null,
            operation_id: null,
            error: { kind: "internal", code: "connection_closed" },
            frame_sha256: null,
            frame_bytes: null,
          });
    assert.ok(record);
    const token = f.core.failure(record, f.host.public);
    assert.equal(f.core.supervise("supervision_lost", token).to, "restricted");
    assert.equal(
      reductions(f).findLast((r) => r.event === "supervision_lost")?.trigger_kind,
      `${kind}_fact`,
    );
    assert.equal(f.core.supervise("safe_stop", f.stop().token).to, "safe_stopping");
    assert.throws(
      () => f.core.failure({ ...record, source_instance_id: "old" }, f.host.public),
      /FAILURE_SOURCE/,
    );
  }
});

test("p0.reducer module: supervision revision changes with facts, not heartbeat/query frequency", () => {
  const f = reducerFixture();
  const start = f.core.supervision.source_revision;
  f.health();
  const healthy = f.core.supervision.source_revision;
  assert.ok(healthy > start);
  f.health();
  assert.equal(f.core.supervision.source_revision, healthy);
  f.fact();
  const a = f.authorize();
  assert.ok(a.grant);
  const beforeApprove = f.core.supervision.source_revision;
  f.core.reduceGrant(a.grant.grant_id, "approve", f.receipt(a.grant).token);
  assert.ok(f.core.supervision.source_revision > beforeApprove);
  f.core.supervise("safe_stop", f.stop().token);
  const fenced = f.core.supervision.source_revision;
  f.fact({ cleanup_ref: "actual-cleanup" });
  assert.ok(f.core.supervision.source_revision > fenced);
  const queryRevision = f.core.supervision.source_revision;
  f.core.snapshot();
  f.core.snapshot();
  assert.equal(f.core.supervision.source_revision, queryRevision);
  assert.equal(f.core.supervision.record_status, "pending");
});

test("p0.reducer module: per-target safety capacity reserved before new grant, full records do not block stopping", () => {
  const f = reducerFixture([], 16);
  f.health();
  f.fact();
  for (let n = 0; n < 7; n++) {
    const a = f.authorize({ target_refs: f.config.installation.allowed_targets });
    assert.ok(a.grant);
    f.core.supervise("safe_stop", f.stop().token);
    const source = f.fact({ cleanup_ref: `cleanup-${n}` });
    f.core.supervise("outputs_accounted", source);
  }
  const before = f.core.snapshot();
  assert.equal(before.stops.length, 128);
  assert.equal(before.cleanup.length, 128);
  assert.equal(before.isolation.length, 128);
  assert.throws(
    () => f.authorize({ target_refs: f.config.installation.allowed_targets }),
    /QUEUE_LIMIT/,
  );
  assert.equal(f.core.supervise("safe_stop", f.stop().token).disposition, "accepted");
  assertValid("P0SessionSnapshot", f.core.snapshot());
  assert.equal(f.core.snapshot().stops.length, 128);
  assert.equal(f.core.snapshot().cleanup.length, 128);
  assert.equal(f.core.snapshot().isolation.length, 128);
});

test("p0.reducer module: both endpoint deadlines require the mapped domain and valid observed interval", () => {
  for (const key of ["lease_deadline", "host_connection_deadline"] as const) {
    for (const invalid of ["domain", "reversed", "empty", "future_issued"] as const) {
      const f = reducerFixture();
      const grant = f.active();
      assert.equal(f.core.canExecute(grant.grant_id), true);
      const before = f.core.snapshot().endpoint;
      const original = required(f.currentFact()[key]);
      const deadline = {
        ...original,
        ...(invalid === "domain" ? { clock_domain: "unmapped" } : {}),
        ...(invalid === "reversed" ? { expires_at_ms: original.issued_at_ms - 1 } : {}),
        ...(invalid === "empty" ? { expires_at_ms: original.issued_at_ms } : {}),
        ...(invalid === "future_issued" ? { issued_at_ms: f.clock.now() + 1 } : {}),
      };
      assert.throws(
        () => f.fact({ [key]: deadline }),
        /CLOCK_MAPPING_INVALID/,
        `${key}:${invalid}`,
      );
      assert.deepEqual(
        f.core.snapshot().endpoint,
        before,
        "invalid input cannot replace the projection",
      );
    }
  }
});

test("p0.reducer module: endpoint supervision cannot advance or invent an active grant binding", () => {
  for (const invalid of ["future", "unknown_grant", "grant_epoch"] as const) {
    const f = reducerFixture();
    f.health();
    f.fact();
    const grant = required(f.authorize().grant);
    const before = f.core.snapshot().endpoint;
    const change =
      invalid === "future"
        ? { supervision_epoch: f.core.supervision.supervision_epoch + 1 }
        : {
            active_grant_ref: invalid === "unknown_grant" ? "unknown" : grant.grant_id,
            supervision_epoch: 0,
          };
    assert.throws(() => f.fact(change), /SCOPED_EPOCH_CONFLICT/, invalid);
    assert.deepEqual(f.core.snapshot().endpoint, before);
  }
});

test("p0.reducer module: expired endpoint history is retained without execution or loss of old-epoch cleanup", () => {
  for (const key of ["lease_deadline", "host_connection_deadline"] as const) {
    const f = reducerFixture();
    const grant = f.active();
    f.clock.time = 1200;
    const expired = {
      clock_domain: f.endpointClock.domain,
      issued_at_ms: 1000,
      expires_at_ms: 1200,
    };
    f.fact({ [key]: expired });
    assert.deepEqual(f.core.snapshot().endpoint.fact?.[key], expired);
    assert.equal(f.core.canExecute(grant.grant_id), false);
    f.core.supervise("safe_stop", f.stop().token);
    f.fact({
      supervision_epoch: grant.supervision_epoch,
      active_grant_ref: null,
      lease_deadline: null,
      host_connection_deadline: expired,
      fence_applied: true,
      stopped: true,
      cleanup_ref: "expired-channel-cleanup",
    });
    assert.ok(grant.supervision_epoch < f.core.supervision.supervision_epoch);
    assert.ok(f.core.snapshot().stops.every((s) => s.state === "CONFIRMED"));
    assert.ok(f.core.snapshot().cleanup.every((c) => c.status === "confirmed"));
  }
});

test("p0.reducer module: actual proof receive time orders the undispatched stop deadline before late cleanup", () => {
  for (const offset of [-1, 0, 1]) {
    const f = reducerFixture();
    const grant = f.active();
    const work = f.completed(grant);
    f.core.supervise("safe_stop", f.stop().token);
    const stop = required(f.core.snapshot().stops[0]);
    const timer = f.core.timer("StopOperation", stop.stop_operation_id, "deadline");
    f.core.takeActions();
    f.clock.time = stop.deadline.monotonic_ms + offset;
    f.fact({
      observed_at: { clock_domain: f.endpointClock.domain, monotonic_ms: 1000 },
      effect_facts: [work.effect],
      accepted_watermark: 1,
      completed_effect_count: 2,
      active_grant_ref: null,
      lease_deadline: null,
      fence_applied: true,
      stopped: true,
      cleanup_ref: "complete-stop-proof",
    });
    const snapshot = f.core.snapshot();
    const expected = offset < 0 ? "CONFIRMED" : "UNKNOWN";
    assert.ok(
      snapshot.stops.every((s) => s.state === expected),
      `received at deadline ${offset >= 0 ? "+" : ""}${offset}`,
    );
    assert.equal(snapshot.endpoint.fact?.completed_effect_count, 2);
    assert.ok(snapshot.cleanup.every((c) => c.status === "confirmed"));
    assert.ok(snapshot.isolation.every((i) => i.status === "proven_clean"));
    const accepted = reductions(f).filter(
      (r) => r.machine === "StopOperation" && r.disposition === "accepted",
    );
    assert.ok(accepted.length > 0);
    assert.ok(accepted.every((r) => r.event === (offset < 0 ? "local_ack" : "deadline")));
    assert.ok(accepted.every((r) => r.trigger_kind === (offset < 0 ? "endpoint_fact" : "timer")));
    if (offset >= 0) {
      assert.ok(
        accepted.every((r) => payloadDigest(r.timer_deadline) === payloadDigest(stop.deadline)),
      );
      assert.ok(snapshot.stops.every((s) => s.endpoint_fact === null));
    }
    const actions = f.core.takeActions();
    for (const kind of ["StopOperation", "P0CleanupRecord", "P0IsolationRecord"]) {
      assert.ok(actions.some((a) => a.kind === "persist" && a.object_ref.kind === kind));
    }
    const cleanup = snapshot.cleanup;
    f.clock.time = stop.deadline.monotonic_ms + 2;
    assert.equal(f.core.fire(timer).decision?.disposition, "terminal_rejected");
    f.fact();
    assert.ok(f.core.snapshot().stops.every((s) => s.state === expected));
    assert.deepEqual(
      f.core.snapshot().cleanup,
      cleanup,
      "first complete cleanup proof stays fixed",
    );
  }
});

after(() => {
  const accepted = new Set(
    moduleReductions
      .filter((r) => r.disposition === "accepted")
      .map((r) => `${r.machine}:${r.from}:${r.event}`),
  );
  const required = stateMachines.machines
    .filter((m) => ["SupervisionMode", "ExecutionGrant", "StopOperation"].includes(m.id))
    .flatMap((m) =>
      m.transitions
        .filter((t) => t.phase === "P0" && t.target !== "unattended_approved")
        .flatMap((t) =>
          (t.source as readonly string[])
            .filter((s) => s !== "unattended_approved")
            .map((s) => `${m.id}:${s}:${t.event}`),
        ),
    );
  const missing = required.filter((key) => !accepted.has(key));
  mkdirSync("reports/p0/w5r", { recursive: true });
  writeFileSync(
    "reports/p0/w5r/module-coverage.json",
    JSON.stringify(
      {
        source: "controlled-module",
        sut_status: "PENDING",
        required,
        accepted: [...accepted].sort(),
        missing,
        excluded:
          "unattended_approved is unreachable in P0; approve_unattended rejection checked from each reachable source",
        guard_rejections: [
          ...new Set(
            moduleReductions.filter((r) => r.disposition === "guard_rejected").map((r) => r.guard),
          ),
        ].sort(),
        pure_guard_negative: [
          "supervision_outputs_safe: missing/incorrectly-owned isolation; unreachable after intact reserved fence",
        ],
        observations: moduleReductions,
      },
      null,
      2,
    ),
  );
  assert.deepEqual(missing, []);
});
