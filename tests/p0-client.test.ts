import assert from "node:assert/strict";
import { test } from "node:test";
import { payloadDigest, type RpcRequest } from "../packages/contract-sdk/src/index.ts";
import { LateRpcResponse, type PreparedOperator } from "../packages/runtime/src/client.ts";
import { mappedDeadline } from "../packages/runtime/src/clock.ts";
import { businessFailure } from "../packages/runtime/src/errors.ts";
import {
  ConnectionAuthentication,
  completeRequest,
  generateIdentity,
} from "../packages/runtime/src/identity.ts";
import { ClientClock, connectionFixture, credential, endpointEvent } from "./p0-client.helpers.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function failed(request: RpcRequest) {
  return businessFailure(request.id, request.params.context, "PERSISTENCE_NOT_READY");
}
test("p0.client module: Prepared has an unforgeable brand and nested immutable business binding", async (t) => {
  const f = await connectionFixture();
  t.after(f.cleanup);
  const p = f.connection.prepareOperator(
    "session.query",
    { session_id: f.connection.announcement.session_id },
    credential,
  );
  assert.throws(
    () => f.connection.sendPrepared(structuredClone(p), credential),
    /AUTHENTICATION_REQUIRED/,
  );
  assert.throws(
    () => f.connection.sendPrepared({} as PreparedOperator, credential),
    /AUTHENTICATION_REQUIRED/,
  );
  assert.throws(() => {
    p.request.params.context.deadline.expires_at_ms++;
  }, TypeError);
  assert.throws(() => {
    p.service.public_key_spki = "replacement";
  }, TypeError);
  assert.throws(() => {
    f.connection.mapping.target_valid_until_ms++;
  }, TypeError);
  assert.deepEqual(f.connection.announcementEvent, f.original);
  assert.throws(() => {
    f.connection.announcementEvent.params.event_id = "replacement";
  }, TypeError);
});

test("p0.client module: a fresh challenge retains original authorization deadlines, context and business input", async (t) => {
  const f = await connectionFixture();
  t.after(f.cleanup);
  const d = mappedDeadline(f.connection.mapping, f.clock.now(), 1000);
  const p = f.connection.prepareOperator(
    "session.authorize",
    {
      session_id: f.connection.announcement.session_id,
      endpoint_instance_id: "endpoint",
      mode: "simulation",
      supervision_mode: "supervised",
      public_broadcast_allowed: false,
      target_refs: [{ kind: "SimulationTarget", id: "counter" }],
      allowed_capabilities: [{ name: "simulation.execute", version: "0.8.0" }],
      effect_limit: 2,
      queue_limit: 1,
      cost_limit_units: 0,
      human_lease_deadline: d,
      grant_deadline: d,
    },
    credential,
    { operation: "same-business", timeoutMs: 1500 },
  );
  const second = await connectionFixture({
    identity: f.identity,
    authority: f.authority,
    clock: f.clock,
    targetClock: f.targetClock,
  });
  t.after(second.cleanup);
  const exchanges = [];
  for (const fixture of [f, second]) {
    fixture.server.on("message", (request: RpcRequest) => {
      assert.doesNotThrow(() =>
        new ConnectionAuthentication(fixture.connection.announcement).operator(
          request,
          credential,
          fixture.targetClock.now(),
        ),
      );
      fixture.server.send(failed(request));
    });
    exchanges.push(await fixture.connection.sendPrepared(p, credential));
  }
  const [a, b] = exchanges;
  assert.ok(a && b);
  assert.notEqual(a.request.id, b.request.id);
  const context = ({ payload_digest: _, ...fixed }: RpcRequest["params"]["context"]) => fixed;
  assert.deepEqual(context(a.request.params.context), context(b.request.params.context));
  assert.equal(a.request.method, "session.authorize");
  assert.equal(b.request.method, "session.authorize");
  assert.deepEqual(
    a.request.params.input.human_lease_deadline,
    b.request.params.input.human_lease_deadline,
  );
  assert.deepEqual(a.request.params.input.grant_deadline, b.request.params.input.grant_deadline);
  assert.notDeepEqual(a.request.params.input.proof, b.request.params.input.proof);
  assert.notDeepEqual(a.request.params.input.mapping, b.request.params.input.mapping);
  assert.deepEqual(a.response, failed(a.request));
  assert.deepEqual(b.announcement, second.original);
});

test("p0.client module: reconnect rejects changed identity, authority, session, epoch, clock origin and coverage", async (t) => {
  const authority = generateIdentity("supervisor"),
    host = generateIdentity("host");
  const f = await connectionFixture({ identity: host, authority });
  t.after(f.cleanup);
  const p = f.connection.prepareOperator(
    "host.query",
    { session_id: f.connection.announcement.session_id },
    credential,
  );
  const changedKey = generateIdentity("host");
  changedKey.public.instance_id = host.public.instance_id;
  const changedAuthority = generateIdentity("supervisor");
  changedAuthority.public.instance_id = authority.public.instance_id;
  const variants = [
    { identity: generateIdentity("host") },
    { identity: changedKey },
    { authority: changedAuthority },
    { session: "different-session" },
    { epoch: 1 },
    { caller: "other-caller" },
    { clock: new ClientClock(f.clock.domain, f.clock.origin + 1n) },
    { targetClock: new ClientClock() },
    { limits: { clock_mapping_ttl_ms: 300 } },
  ];
  for (const variant of variants) {
    const next = await connectionFixture({
      identity: host,
      authority,
      clock: f.clock,
      targetClock: f.targetClock,
      ...variant,
    });
    t.after(next.cleanup);
    assert.throws(() => next.connection.sendPrepared(p, credential));
    assert.equal(next.requests.length, 0);
  }
  f.clock.time = 4000;
  assert.throws(() => f.connection.sendPrepared(p, credential), /COMMAND_DEADLINE_MISSED/);
});

test("p0.client module: new peer calls may carry an explicit owner epoch without mutating signed announcement", async (t) => {
  const f = await connectionFixture();
  t.after(f.cleanup);
  f.server.on("message", (request: RpcRequest) => f.server.send(failed(request)));
  const original = payloadDigest(f.connection.announcementEvent);
  const exchange = await f.connection.peerExchange(
    "clock.sample",
    { source_sent_at: f.clock.point() },
    "fresh-peer",
    3,
  );
  assert.equal(exchange.request.params.context.authority_epoch, 3);
  assert.equal(payloadDigest(f.connection.announcementEvent), original);
  assert.equal(f.connection.announcement.authority_epoch, 0);
  const peer = generateIdentity("host");
  peer.public.instance_id = f.connection.instanceId;
  await assert.rejects(f.connection.authenticatePeer(peer), /PERSISTENCE_NOT_READY/);
  assert.equal(f.requests.at(-1)?.params.context.authority_epoch, 0);
});

test("p0.client module: out-of-order replies stay with their request; a later timeout cannot reuse an earlier response", async (t) => {
  const f = await connectionFixture();
  t.after(f.cleanup);
  const a = completeRequest(
    "clock.sample",
    { source_sent_at: f.clock.point(), mapping: f.connection.mapping },
    f.connection.context("a"),
  );
  const b = completeRequest(
    "clock.sample",
    { source_sent_at: f.clock.point(), mapping: f.connection.mapping },
    f.connection.context("b"),
  );
  const pa = f.connection.requestExchange(a),
    pb = f.connection.requestExchange(b);
  await tick();
  f.server.send(failed(b));
  f.server.send(failed(a));
  assert.equal((await pb).request.id, b.id);
  assert.equal((await pa).response.id, a.id);
  const c = completeRequest(
    "clock.sample",
    { source_sent_at: f.clock.point(), mapping: f.connection.mapping },
    f.connection.context("c", null, 0, 25),
  );
  await assert.rejects(f.connection.requestExchange(c), /COMMAND_DEADLINE_MISSED/);
  assert.notEqual(f.connection.lastResponse?.id, c.id);
});

test("p0.client module: wrong response id and a different method's success shape reject the pending call", async (t) => {
  for (const wrongId of [true, false]) {
    const f = await connectionFixture();
    t.after(f.cleanup);
    const p = f.connection.prepareOperator(
      "session.query",
      { session_id: f.connection.announcement.session_id },
      credential,
    );
    f.server.on("message", (r: RpcRequest) =>
      f.server.send(
        wrongId
          ? { ...failed(r), id: "foreign-request" }
          : {
              jsonrpc: "2.0",
              id: r.id,
              result: {
                credential_id: "c",
                operator_id: "o",
                role: "operator",
                connection_id: "c",
                authenticated_at: f.targetClock.point(),
              },
            },
      ),
    );
    await assert.rejects(f.connection.sendPrepared(p, credential));
  }
});

test("p0.client module: a valid success received at its original deadline is evidence, never timely success", async (t) => {
  const f = await connectionFixture();
  t.after(f.cleanup);
  const p = f.connection.prepareOperator("operator.authenticate", {}, credential, {
    timeoutMs: 100,
  });
  f.server.on("message", (request: RpcRequest) => {
    // No timer can dispatch between this clock advance and synchronous stream delivery.
    f.clock.time =
      request.params.context.deadline.expires_at_ms - f.connection.mapping.offset_upper_ms;
    f.server.send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        credential_id: credential.credential_id,
        operator_id: credential.operator_id,
        role: credential.role,
        connection_id: f.connection.announcement.connection_id,
        authenticated_at: f.targetClock.point(),
      },
    });
  });
  await assert.rejects(f.connection.sendPrepared(p, credential), (error) => {
    assert.ok(error instanceof LateRpcResponse);
    assert.ok("result" in error.exchange.response);
    assert.equal(error.exchange.request.id, error.exchange.response.id);
    assert.equal(error.exchange.received_at.monotonic_ms, f.clock.now());
    return true;
  });
});

test("p0.client module: original endpoint envelopes archive separately; duplicates and old epochs do not refresh projections", async (t) => {
  const f = await connectionFixture({
    identity: generateIdentity("endpoint"),
    authority: generateIdentity("supervisor"),
  });
  t.after(f.cleanup);
  const facts: unknown[] = [],
    events: unknown[] = [],
    future: unknown[] = [];
  let epoch = 0;
  f.connection.onEndpointFact(
    (fact) => facts.push(fact),
    () => epoch,
    (e) => future.push(e),
  );
  f.connection.onEndpointEvent((event) => events.push(event));
  const first = endpointEvent(f);
  f.server.send(first);
  await tick();
  f.clock.time++;
  f.server.send(first);
  await tick();
  assert.equal(facts.length, 1);
  assert.equal(events.length, 2);
  epoch = 1;
  f.server.send(endpointEvent(f, 1, 0));
  await tick();
  assert.equal(facts.length, 1);
  f.server.send(endpointEvent(f, 2, 2));
  await tick();
  assert.equal(future.length, 1);
  assert.equal(facts.length, 1);
  assert.equal(epoch, 1);
  f.server.send(endpointEvent(f, 3, 1));
  await tick();
  assert.equal(facts.length, 2);
});

test("p0.client module: endpoint event-id/sequence/revision conflicts and unhandled future epochs close the connection", async (t) => {
  for (const kind of ["id", "sequence", "revision", "future"] as const) {
    const f = await connectionFixture({
      identity: generateIdentity("endpoint"),
      authority: generateIdentity("supervisor"),
    });
    t.after(f.cleanup);
    f.connection.onEndpointFact(
      () => {},
      () => 0,
    );
    const first = endpointEvent(f);
    f.server.send(first);
    await tick();
    const second = endpointEvent(f, 1, kind === "future" ? 1 : 0);
    if (kind === "id") second.params.event_id = first.params.event_id;
    if (kind === "sequence") second.params.source_seq = first.params.source_seq;
    if (kind === "revision") {
      assert.ok("source_revision" in second.params.payload);
      second.params.payload.source_revision = 0;
      second.params.payload.fence_applied = false;
    }
    f.server.send(second);
    await tick();
    assert.equal(f.connection.channel.closed, true, kind);
  }
});

test("p0.client module: authority and supervision epochs differ legitimately; expired mapping only archives history", async (t) => {
  const f = await connectionFixture({
    identity: generateIdentity("endpoint"),
    authority: generateIdentity("supervisor"),
  });
  t.after(f.cleanup);
  const facts: unknown[] = [],
    events: unknown[] = [],
    future: unknown[] = [];
  f.connection.onEndpointFact(
    (fact) => facts.push(fact),
    () => 2,
    (event) => future.push(event),
  );
  f.connection.onEndpointEvent((event) => events.push(event));
  const event = endpointEvent(f, 0, 2);
  assert.ok("supervision_epoch" in event.params.payload);
  assert.equal(event.params.payload.supervision_epoch, 0);
  f.server.send(event);
  await tick();
  assert.equal(facts.length, 1);
  const originalTtl = f.connection.mapping.target_valid_until_ms;
  f.clock.time = f.connection.mapping.source_valid_until_ms;
  f.server.send(endpointEvent(f, 1, 2));
  f.server.send(endpointEvent(f, 2, 3));
  await tick();
  assert.equal(events.length, 3);
  assert.equal(facts.length, 1);
  assert.equal(future.length, 0);
  assert.equal(f.connection.mapping.target_valid_until_ms, originalTtl);
});

test("p0.client module: the same complete fact with a new event identity does not refresh its projection", async (t) => {
  const f = await connectionFixture({
    identity: generateIdentity("endpoint"),
    authority: generateIdentity("supervisor"),
  });
  t.after(f.cleanup);
  let projected = 0,
    archived = 0;
  f.connection.onEndpointFact(
    () => projected++,
    () => 0,
  );
  f.connection.onEndpointEvent(() => archived++);
  const event = endpointEvent(f);
  f.server.send(event);
  await tick();
  const replay = structuredClone(event);
  replay.params.event_id = "new-event-same-fact";
  replay.params.source_seq = 1;
  f.clock.time++;
  f.server.send(replay);
  await tick();
  assert.equal(archived, 2);
  assert.equal(projected, 1);
  f.server.send(endpointEvent(f, 2));
  await tick();
  assert.equal(projected, 2);
});

test("p0.client module: endpoint event time must retain the actual fact point and cannot be from the future", async (t) => {
  for (const kind of ["mismatch", "future"]) {
    const f = await connectionFixture({
      identity: generateIdentity("endpoint"),
      authority: generateIdentity("supervisor"),
    });
    t.after(f.cleanup);
    let archived = 0;
    f.connection.onEndpointFact(
      () => assert.fail("invalid fact projected"),
      () => 0,
    );
    f.connection.onEndpointEvent(() => archived++);
    const event = endpointEvent(f);
    assert.ok(event.params.occurred_at);
    event.params.occurred_at.monotonic_ms += 50;
    if (kind === "future") {
      assert.ok("observed_at" in event.params.payload);
      event.params.payload.observed_at = structuredClone(event.params.occurred_at);
    }
    f.server.send(event);
    await tick();
    assert.equal(f.connection.channel.closed, true);
    assert.equal(archived, 0);
  }
});

test("p0.client module: raw failures retain protocol reserved codes and immutable per-request evidence", async (t) => {
  const f = await connectionFixture();
  t.after(f.cleanup);
  f.server.on("message", (request: RpcRequest) =>
    f.server.send({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32603, message: "Internal error", data: null },
    }),
  );
  const request = completeRequest(
    "clock.sample",
    { source_sent_at: f.clock.point(), mapping: f.connection.mapping },
    f.connection.context(),
  );
  const exchange = await f.connection.requestExchange(request);
  assert.ok("error" in exchange.response);
  assert.equal(exchange.response.error.code, -32603);
  assert.throws(() => {
    exchange.request.params.context.operation_id = "tamper";
  }, TypeError);
});
