import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { payloadDigest, type StopOperationRecord } from "../packages/contract-sdk/src/index.ts";
import { clockMapping, MonotonicClock } from "../packages/runtime/src/clock.ts";
import { reject } from "../packages/runtime/src/errors.ts";
import {
  completeRequest,
  generateIdentity,
  operatorRequest,
  peerRequest,
} from "../packages/runtime/src/identity.ts";
import type { ServiceInvocation } from "../packages/runtime/src/service.ts";
import { JsonChannel } from "../packages/runtime/src/transport.ts";
import { deferred, delay, selection, serviceFixture, until } from "./p0-service.helpers.ts";

// All delegation/ledger/state in this file is controlled module evidence only.
// No production grant, persistence receipt, endpoint effect or SUT status is created.

test("p0.service module: N=1 ordinary work cannot consume stop/query/Host health, and trusted input is immutable", async (t) => {
  const held = deferred();
  const invoked: ServiceInvocation[] = [];
  const f = await serviceFixture({
    delegate: {
      beginSafety: (i) => {
        f.epoch++;
        return f.stopRecord(i);
      },
      dispatch: (i, stop) => {
        invoked.push(i);
        if (stop) return stop;
        if (["session.query", "supervisor.query"].includes(i.request.method)) return f.snapshot;
        return held.promise;
      },
    },
  });
  t.after(() => f.cleanup());
  const first = await f.connect();
  const pending = f.fault(first).catch((e: Error) => e);
  await until(() => invoked.length === 1);
  const second = await f.connect();
  await assert.rejects(f.fault(second), /QUEUE_LIMIT_EXCEEDED/);
  const health = await f.connect(f.host);
  await health.authenticatePeer(f.host);
  await health.peerCall("supervisor.health", {
    session_id: f.snapshot.session_id,
    peer_instance_id: f.host.public.instance_id,
    peer_role: "host",
  });
  assert.equal(f.health, 1);
  const business = await f.connect(f.host);
  await business.authenticatePeer(f.host);
  const action = {
    target_ref: { kind: "Controller", id: "controlled-fake" },
    capability: "simulation.execute",
    units: 1,
    interval_ms: 1,
    cost_units: 1,
  };
  await assert.rejects(
    business.peerCall("supervisor.register_effect", {
      registration: {
        operation_id: "controlled-registration",
        session_id: f.snapshot.session_id,
        grant_id: "controlled-grant",
        endpoint_instance_id: "controlled-endpoint",
        target_ref: action.target_ref,
        capability: action.capability,
        payload_digest: payloadDigest({
          session_id: f.snapshot.session_id,
          grant_id: "controlled-grant",
          endpoint_instance_id: "controlled-endpoint",
          action,
        }),
        units: 1,
        cost_units: 1,
        deadline: {
          clock_domain: business.clock.domain,
          issued_at_ms: business.clock.now(),
          expires_at_ms: business.clock.now() + 1000,
        },
        registered_at: business.clock.point(),
      },
      action,
    }),
    /QUEUE_LIMIT_EXCEEDED/,
  );
  assert.deepEqual(
    await business.peerCall("supervisor.query", { session_id: f.snapshot.session_id }),
    f.snapshot,
  );
  const query = await f.connect();
  assert.deepEqual(
    await f.call(query, "session.query", { session_id: f.snapshot.session_id }),
    f.snapshot,
  );
  const stopClient = await f.connect();
  const stop = (await f.stop(stopClient)) as StopOperationRecord;
  assert.equal(stop.local_fence_applied, true);
  assert.equal(stop.fence.cancel_epoch, 1);
  assert.equal(f.epoch, 1);
  const i = invoked[0];
  assert.ok(i);
  assert.equal(i.actor.kind, "operator");
  assert.equal("authentication_key_sha256" in i.actor.identity, false);
  assert.ok(
    Object.isFrozen(i) &&
      Object.isFrozen(i.request.params.input) &&
      Object.isFrozen(i.actor.identity),
  );
  const received = f.raw
    .map((b) => JSON.parse(b.toString()))
    .find((r) => r.source_seq === i.trigger.receive_seq && r.detail?.kind === "request_received");
  assert.equal(received.detail.request.id, i.request.id);
  assert.equal(i.trigger.trigger_kind, "command");
  held.resolve(f.faultResult());
  assert.match(String(await pending), /SCOPED_EPOCH_CONFLICT/);
  assert.equal(invoked.length, 4);
});

test("p0.service module: two expired ordinary calls retain unfinished capacity; late settle alone makes room", async (t) => {
  const one = deferred(),
    two = deferred();
  let calls = 0;
  const f = await serviceFixture({
    delegate: {
      beginSafety: () => reject("CONTROLLER_NOT_READY"),
      dispatch: () => (++calls === 1 ? one.promise : calls === 2 ? two.promise : f.faultResult()),
    },
  });
  t.after(() => f.cleanup());
  for (let n = 0; n < 2; n++) {
    const client = await f.connect();
    await assert.rejects(f.fault(client, 65), /COMMAND_DEADLINE_MISSED/);
    await until(() => client.channel.closed);
  }
  const third = await f.connect();
  await assert.rejects(f.fault(third), /QUEUE_LIMIT_EXCEEDED/);
  assert.equal(calls, 2);
  one.resolve(f.faultResult());
  two.reject(new Error("controlled late rejection"));
  await delay(5);
  const next = await f.connect();
  assert.equal(((await f.fault(next)) as { fault_id: string }).fault_id, "controlled-fault");
  assert.equal(calls, 3);
  const responses = f.raw
    .map((b) => JSON.parse(b.toString()))
    .filter((r) => r.detail?.kind === "response_queued" && r.detail.rpc.response.result?.fault_id);
  assert.equal(responses.length, 1, "late resolve/reject must not reply");
});

test("p0.service module: disconnect does not cancel work; same Promise waiters count separately and shutdown is finite", async (t) => {
  const held = deferred();
  let calls = 0;
  const f = await serviceFixture({
    delegate: {
      beginSafety: () => reject("CONTROLLER_NOT_READY"),
      dispatch: () => {
        calls++;
        return held.promise;
      },
    },
  });
  t.after(() => f.cleanup());
  const first = await f.connect();
  const pending = f.fault(first, 100).catch((e) => e);
  await until(() => calls === 1);
  first.close();
  await pending;
  await delay(5);
  const second = await f.connect();
  await assert.rejects(f.fault(second), /QUEUE_LIMIT_EXCEEDED/);
  assert.equal(calls, 1);
  await delay(110);
  const third = await f.connect();
  const next = f.fault(third, 65).catch((e) => e);
  await until(() => calls === 2);
  await next;
  const fourth = await f.connect();
  await assert.rejects(f.fault(fourth), /QUEUE_LIMIT_EXCEEDED/);
  const start = performance.now();
  await f.service.close();
  assert.ok(performance.now() - start < 300);
  held.resolve(f.faultResult());
  await delay(5);
  assert.equal(calls, 2);
});

test("p0.service module: actual clock expiry wins when the timer callback has not run", async (t) => {
  class AdjustableClock extends MonotonicClock {
    offset = 0;
    override now() {
      return super.now() + this.offset;
    }
  }
  const clock = new AdjustableClock(),
    held = deferred();
  let invoked: ServiceInvocation | undefined;
  const f = await serviceFixture({
    clock,
    delegate: {
      beginSafety: () => reject("CONTROLLER_NOT_READY"),
      dispatch: (i) => {
        invoked = i;
        return held.promise;
      },
    },
  });
  t.after(() => f.cleanup());
  const client = await f.connect();
  const result = f.fault(client, 200).catch((e) => e);
  await until(() => !!invoked);
  clock.offset = 250;
  held.resolve(f.faultResult()); // Promise microtask precedes the scheduled timeout.
  assert.match(String(await result), /COMMAND_DEADLINE_MISSED/);
  assert.equal(
    f.raw.some((b) => b.toString().includes('"result":{"fault_id"')),
    false,
  );
});

test("p0.service module: safety fence precedes full safety budgets but never returns a late success", async (t) => {
  let fences = 0,
    calls = 0;
  const held = deferred();
  const f = await serviceFixture({
    delegate: {
      beginSafety: (i) => {
        fences++;
        f.epoch++;
        return f.stopRecord(i);
      },
      dispatch: () => {
        calls++;
        return held.promise;
      },
    },
  });
  t.after(() => f.cleanup());
  for (let n = 0; n < 4; n++) {
    const client = await f.connect();
    await assert.rejects(f.stop(client, 65), /COMMAND_DEADLINE_MISSED/);
    await until(() => client.channel.closed);
  }
  const next = await f.connect();
  await assert.rejects(f.stop(next), /QUEUE_LIMIT_EXCEEDED/);
  assert.equal(fences, 5);
  assert.equal(calls, 4);
  assert.equal(f.epoch, 5);
  held.reject(new Error("controlled late stop failure"));
  await delay(5);
  assert.equal(
    f.raw.some((b) => b.toString().includes('"result":{"stop_operation_id"')),
    false,
  );
});

test("p0.service module: stable actor ledger rejects payload conflict before fence", async (t) => {
  const ledger = new Map<string, { digest: string; record: StopOperationRecord }>();
  let fences = 0;
  const f = await serviceFixture({
    delegate: {
      beginSafety: (i) => {
        assert.equal(i.actor.kind, "operator");
        const key =
          i.actor.kind === "operator"
            ? `${i.actor.identity.credential_id}:${i.request.params.context.operation_id}`
            : "denied";
        const input = i.request.params.input;
        assert.ok("target_ref" in input);
        const digest = payloadDigest(input.target_ref);
        const old = ledger.get(key);
        if (old) {
          if (old.digest !== digest) reject("OPERATION_PAYLOAD_CONFLICT");
          return old.record;
        }
        if (input.target_ref.id !== f.snapshot.session_id) reject("ROLE_SCOPE_DENIED");
        fences++;
        const record = f.stopRecord(i);
        ledger.set(key, { digest, record });
        return record;
      },
      dispatch: (_i, record) => record,
    },
  });
  t.after(() => f.cleanup());
  const call = async (target: string) => {
    const client = await f.connect();
    return client.operatorCall(
      "session.stop",
      {
        session_id: f.snapshot.session_id,
        target_ref: { kind: "Session", id: target },
        reason: "operator_request",
      },
      f.credential,
      "stable-business-operation",
    );
  };
  const original = await call(f.snapshot.session_id);
  assert.deepEqual(await call(f.snapshot.session_id), original);
  await assert.rejects(call("different-scope"), /OPERATION_PAYLOAD_CONFLICT/);
  assert.equal(fences, 1);
});

test("p0.service module: candidate2 evicts only oldest unauthenticated and authenticated waiting peers expire without renewal", async (t) => {
  const f = await serviceFixture({ limits: { stop_timeout_ms: 160 } });
  t.after(() => f.cleanup());
  const first = await f.connect(),
    second = await f.connect();
  const third = await f.connect();
  await until(() => first.channel.closed);
  assert.equal(second.channel.closed, false);
  assert.equal(third.channel.closed, false);
  second.close();
  third.close();
  await delay(5);
  const a = await f.connect(f.host),
    b = await f.connect(f.supervisor);
  await a.authenticatePeer(f.host);
  await b.authenticatePeer(f.supervisor);
  await assert.rejects(f.connect(), /RPC_CLOSED/);
  assert.equal(a.channel.closed, false);
  assert.equal(b.channel.closed, false);
  await until(() => a.channel.closed && b.channel.closed);
});

test("p0.service module: fixed peer first-method lane stays locked; old signed map permits only current owner epoch", async (t) => {
  const f = await serviceFixture();
  t.after(() => f.cleanup());
  const peer = await f.connect(f.host);
  await peer.authenticatePeer(f.host);
  await peer.peerCall("clock.sample", { source_sent_at: peer.clock.point() });
  await assert.rejects(
    peer.peerCall("supervisor.query", { session_id: f.snapshot.session_id }),
    /ROLE_SCOPE_DENIED/,
  );
  f.epoch = 1;
  await assert.rejects(
    peer.peerCall("clock.sample", { source_sent_at: peer.clock.point() }),
    /SCOPED_EPOCH_CONFLICT/,
  );
  const context = peer.context();
  context.authority_epoch = 1;
  await peer.request(
    completeRequest(
      "clock.sample",
      { mapping: peer.mapping, source_sent_at: peer.clock.point() },
      context,
    ),
  );
  const future = { ...peer.context(), authority_epoch: 2 };
  await assert.rejects(
    peer.request(
      completeRequest(
        "clock.sample",
        { mapping: peer.mapping, source_sent_at: peer.clock.point() },
        future,
      ),
    ),
    /SCOPED_EPOCH_CONFLICT/,
  );
  const business = await f.connect(f.host);
  await business.authenticatePeer(f.host);
  assert.deepEqual(
    await business.peerCall("supervisor.query", { session_id: f.snapshot.session_id }),
    f.snapshot,
  );
  await assert.rejects(
    business.peerCall("clock.sample", { source_sent_at: business.clock.point() }),
    /ROLE_SCOPE_DENIED/,
  );
});

test("p0.service module: pipelined N=1 peer auth+method both reply; operator first valid frame seals same chunk", async (t) => {
  let queries = 0;
  const f = await serviceFixture({
    delegate: {
      beginSafety: () => reject("CONTROLLER_NOT_READY"),
      dispatch: () => {
        queries++;
        return f.snapshot;
      },
    },
  });
  t.after(() => f.cleanup());
  const peer = await f.wire(f.host.public.instance_id);
  const auth = peerRequest({ mapping: peer.mapping }, peer.context(), peer.announcement, f.host);
  const sample = completeRequest(
    "clock.sample",
    { mapping: peer.mapping, source_sent_at: peer.clock.point() },
    peer.context(),
  );
  const replies = peer.messages;
  peer.channel.output.write(`${JSON.stringify(auth)}\n${JSON.stringify(sample)}\n`);
  await until(() => replies.length === 2);
  assert.deepEqual(
    replies.map((r) => (r as { id: string }).id),
    [auth.id, sample.id],
  );
  assert.ok(replies.every((r) => "result" in (r as object)));
  const client = await f.wire();
  const request = operatorRequest(
    "session.query",
    { session_id: f.snapshot.session_id, mapping: client.mapping },
    client.context(),
    client.announcement,
    f.credential,
  );
  const responses = client.messages;
  client.channel.output.write(
    `${JSON.stringify(request)}\n${JSON.stringify({ ...request, id: "discarded-second" })}\n`,
  );
  await until(() => client.channel.closed);
  assert.equal(queries, 1);
  assert.equal(responses.length, 1);
});

test("p0.service module: sink failure preserves actual command trigger; absence of a writer never invents one", async (t) => {
  let calls = 0;
  const seen: ServiceInvocation[] = [];
  const f = await serviceFixture({
    sink: {
      write: (_bytes, callback) => {
        callback(new Error("controlled EPIPE"));
        return false;
      },
    },
    delegate: {
      beginSafety: () => reject("CONTROLLER_NOT_READY"),
      dispatch: (i) => {
        calls++;
        seen.push(i);
        return f.faultResult();
      },
    },
  });
  t.after(() => f.cleanup());
  const first = await f.connect();
  await f.fault(first);
  const second = await f.connect();
  await f.fault(second);
  assert.equal(calls, 2);
  assert.ok(seen[1] && seen[0] && seen[1].trigger.receive_seq > seen[0].trigger.receive_seq);
  const g = await serviceFixture({
    observation: false,
    delegate: {
      beginSafety: () => reject("CONTROLLER_NOT_READY"),
      dispatch: () => {
        calls++;
        return null;
      },
    },
  });
  t.after(() => g.cleanup());
  await assert.rejects(g.fault(await g.connect()), /SERVICE_NOT_READY/);
  assert.equal(calls, 2);
});

test("p0.service module: completed task retains operator connection quota through slow output drain", async (t) => {
  let calls = 0;
  const f = await serviceFixture({
    delegate: {
      beginSafety: () => reject("CONTROLLER_NOT_READY"),
      dispatch: () => {
        calls++;
        return f.faultResult();
      },
    },
  });
  t.after(() => f.cleanup());
  // Actual service auth on a controlled Writable whose second write never drains.
  const input = new PassThrough();
  const sent: unknown[] = [];
  const output = new Writable({
    write(bytes, _encoding, callback) {
      sent.push(JSON.parse(bytes.toString()));
      if (sent.length === 1) callback();
    },
  });
  const channel = new JsonChannel(input, output, f.limits.max_message_bytes, 3);
  f.service.accept(channel);
  const event = sent[0] as {
    params: { payload: import("../packages/contract-sdk/src/index.ts").P0ConnectionAnnouncement };
  };
  const a = event.params.payload,
    clock = new MonotonicClock(),
    instance = "controlled-slow-client";
  const mapping = clockMapping(a, clock, instance, clock.now(), clock.now(), f.limits);
  const request = operatorRequest(
    "fault.configure",
    { session_id: f.snapshot.session_id, selection, mapping },
    {
      operation_id: "slow-op",
      payload_digest: "0".repeat(64),
      caller_instance_id: instance,
      authority_epoch: 0,
      object_ref: { kind: "Session", id: f.snapshot.session_id },
      deadline: {
        clock_domain: f.clock.domain,
        issued_at_ms: f.clock.now(),
        expires_at_ms: Math.min(mapping.target_valid_until_ms, f.clock.now() + 500),
      },
      grant_ref: null,
    },
    a,
    f.credential,
  );
  input.write(`${JSON.stringify(request)}\n`);
  assert.equal(calls, 1);
  assert.equal(channel.closed, false);
  for (let n = 0; n < 3; n++)
    await assert.rejects(f.fault(await f.connect()), /QUEUE_LIMIT_EXCEEDED/);
  assert.equal(calls, 1);
  await until(() => channel.closed);
  await f.fault(await f.connect());
  assert.equal(calls, 2);
});

test("p0.service module: default remains storage-blocked; fixed Supervisor fault target and role are checked before delegation", async (t) => {
  const f = await serviceFixture({ role: "host" });
  t.after(() => f.cleanup());
  const client = await f.connect();
  await assert.rejects(
    f.call(client, "session.execute", {
      session_id: f.snapshot.session_id,
      grant_id: "no-grant",
      endpoint_instance_id: "controlled-endpoint",
      action: {
        target_ref: { kind: "Controller", id: "fake" },
        capability: "simulation.execute",
        units: 1,
        interval_ms: 1,
        cost_units: 1,
      },
    }),
    /PERSISTENCE_NOT_READY/,
  );
  const sup = await f.connect(f.supervisor);
  await sup.authenticatePeer(f.supervisor);
  await sup.peerCall("clock.sample", { source_sent_at: sup.clock.point() });
  const context = sup.context();
  const applied = (target: "host" | "endpoint") =>
    completeRequest(
      "fault.apply",
      {
        fault_id: "controlled-fault",
        session_id: f.snapshot.session_id,
        target_instance_id: f.host.public.instance_id,
        selection: { target, fault: "none", duration_ms: 0 },
        mapping: sup.mapping,
        deadline: context.deadline,
      },
      context,
    );
  await assert.rejects(sup.request(applied("endpoint")), /ROLE_SCOPE_DENIED/);
  await assert.rejects(sup.request(applied("host")), /SERVICE_NOT_READY/);
  const impostor = await f.connect(generateIdentity("supervisor"));
  await assert.rejects(
    impostor.authenticatePeer(generateIdentity("supervisor")),
    /AUTHENTICATION_REQUIRED/,
  );
});

test("p0.service module: query/safety live2 are independent; full safety live budget still fences", async (t) => {
  const query = deferred(),
    safety = deferred();
  let queryCalls = 0,
    safetyCalls = 0,
    fences = 0;
  const f = await serviceFixture({
    delegate: {
      beginSafety: (i) => {
        fences++;
        return f.stopRecord(i);
      },
      dispatch: (i, stop) => {
        if (stop) {
          safetyCalls++;
          return safety.promise;
        }
        if (i.request.method === "session.query") {
          queryCalls++;
          return query.promise;
        }
        return f.faultResult();
      },
    },
  });
  t.after(() => f.cleanup());
  const waiting: Promise<unknown>[] = [];
  for (let n = 0; n < 2; n++) {
    const client = await f.connect();
    waiting.push(
      f.call(client, "session.query", { session_id: f.snapshot.session_id }).catch((e) => e),
    );
    await until(() => queryCalls === n + 1);
  }
  await assert.rejects(
    f.call(await f.connect(), "session.query", { session_id: f.snapshot.session_id }),
    /QUEUE_LIMIT_EXCEEDED/,
  );
  for (let n = 0; n < 2; n++) {
    waiting.push(f.stop(await f.connect()).catch((e) => e));
    await until(() => safetyCalls === n + 1);
  }
  await assert.rejects(f.stop(await f.connect()), /QUEUE_LIMIT_EXCEEDED/);
  assert.equal(fences, 3);
  assert.equal(safetyCalls, 2);
  assert.equal(queryCalls, 2);
  await f.fault(await f.connect());
  const host = await f.connect(f.host);
  await host.authenticatePeer(f.host);
  await host.peerCall("supervisor.health", {
    session_id: f.snapshot.session_id,
    peer_role: "host",
    peer_instance_id: f.host.public.instance_id,
  });
  assert.equal(f.health, 1);
  await f.service.close();
  await Promise.all(waiting);
  query.resolve(f.snapshot);
  safety.reject(new Error("controlled cleanup"));
});

test("p0.service module: four unfinished queries reject a fifth without adding delegate callbacks", async (t) => {
  const held = deferred();
  let queries = 0;
  const f = await serviceFixture({
    delegate: {
      beginSafety: (i) => f.stopRecord(i),
      dispatch: (_i, record) => {
        if (record) return record;
        queries++;
        return held.promise;
      },
    },
  });
  t.after(() => f.cleanup());
  for (let n = 0; n < 4; n++) {
    const client = await f.connect();
    await assert.rejects(
      f.call(client, "session.query", { session_id: f.snapshot.session_id }, 65),
      /COMMAND_DEADLINE_MISSED/,
    );
    await until(() => client.channel.closed);
  }
  await assert.rejects(
    f.call(await f.connect(), "session.query", { session_id: f.snapshot.session_id }),
    /QUEUE_LIMIT_EXCEEDED/,
  );
  assert.equal(queries, 4);
  const stopped = (await f.stop(await f.connect())) as StopOperationRecord;
  assert.equal(stopped.state, "REQUESTED");
  held.resolve(f.snapshot);
});

test("p0.service module: fragmented authentication cannot extend the original candidate deadline", async (t) => {
  const f = await serviceFixture({
    limits: { stop_timeout_ms: 100, peer_health_timeout_ms: 1000 },
  });
  t.after(() => f.cleanup());
  const wire = await f.wire();
  const request = operatorRequest(
    "operator.authenticate",
    { mapping: wire.mapping },
    wire.context(),
    wire.announcement,
    f.credential,
  );
  const bytes = Buffer.from(`${JSON.stringify(request)}\n`);
  // Fragments never complete a frame; the deadline remains the one at accept.
  let position = 0;
  const fragments = setInterval(() => {
    if (!wire.channel.closed) wire.channel.output.write(bytes.subarray(position, ++position));
  }, 25);
  t.after(() => clearInterval(fragments));
  await delay(160);
  assert.equal(wire.channel.closed, true);
  assert.equal(wire.messages.length, 0);
});

test("p0.service module: transport/role/epoch rejection never delegates or fences", async (t) => {
  let calls = 0,
    fences = 0;
  const f = await serviceFixture({
    delegate: {
      beginSafety: (i) => {
        fences++;
        return f.stopRecord(i);
      },
      dispatch: () => {
        calls++;
        return null;
      },
    },
  });
  t.after(() => f.cleanup());
  for (const kind of ["credential", "digest", "session", "epoch", "deadline"] as const) {
    const client = await f.connect();
    const context = client.context();
    if (kind === "session") context.object_ref.id = "foreign-session";
    if (kind === "epoch") context.authority_epoch = 7;
    if (kind === "deadline") context.deadline.clock_domain = "foreign-clock";
    const credential =
      kind === "credential"
        ? { ...f.credential, authentication_key_sha256: "a".repeat(64) }
        : f.credential;
    const request = operatorRequest(
      "session.stop",
      {
        session_id: f.snapshot.session_id,
        target_ref: { kind: "Session", id: f.snapshot.session_id },
        reason: "operator_request",
        mapping: client.mapping,
      },
      context,
      client.announcement,
      credential,
    );
    if (kind === "digest") request.params.context.payload_digest = "b".repeat(64);
    await assert.rejects(
      client.request(request),
      /AUTHENTICATION_REQUIRED|OPERATION_PAYLOAD_CONFLICT|ROLE_SCOPE_DENIED|SCOPED_EPOCH_CONFLICT|COMMAND_CLOCK_MISMATCH/,
    );
  }
  f.credential.role = "operator";
  await assert.rejects(f.fault(await f.connect()), /ROLE_SCOPE_DENIED/);
  assert.equal(calls, 0);
  assert.equal(fences, 0);
});
