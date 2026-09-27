import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import type { CommandContext, P0EndpointSnapshot } from "../packages/contract-sdk/src/index.ts";
import { RpcConnection } from "../packages/runtime/src/client.ts";
import { MonotonicClock } from "../packages/runtime/src/clock.ts";
import { launchEndpoint, queryEndpoint } from "../packages/runtime/src/endpoint-client.ts";
import { completeRequest } from "../packages/runtime/src/identity.ts";
import { terminateChild } from "../packages/runtime/src/processes.ts";
import { JsonChannel } from "../packages/runtime/src/transport.ts";
import {
  type EndpointOperationIdentity,
  EndpointOperationLedger,
  endpointBusinessDigest,
} from "../plugins/fake-device/operation-ledger.ts";
import { EndpointProtocol } from "../plugins/fake-device/protocol.ts";
import { createProductionFixture, endpointMaterials } from "./p0-endpoint.helpers.ts";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function identity(operation: string = randomUUID()): EndpointOperationIdentity {
  return {
    peer_role: "supervisor",
    peer_instance_id: "supervisor-instance",
    session_id: "session-instance",
    endpoint_instance_id: "endpoint-instance",
    operation_id: operation,
  };
}

test("p0.endpoint ledger module: one instance checks cross-category conflicts and binds connection results", () => {
  const ledger = new EndpointOperationLedger(16384);
  const operation = identity();
  const reserved = ledger.reserve("ordinary", operation, "original-business", "host-connection");
  assert.ok(reserved);
  const original = { connection_id: "host-connection", accepted: true };
  ledger.commit(reserved, original);
  assert.deepEqual(ledger.lookup(operation, "original-business", "host-connection"), {
    found: true,
    result: original,
  });
  assert.throws(
    () => ledger.lookup(operation, "original-business", "replacement-connection"),
    /OPERATION_PAYLOAD_CONFLICT/,
  );
  assert.throws(
    () => ledger.lookup(operation, "query-method-instead", "host-connection"),
    /OPERATION_PAYLOAD_CONFLICT/,
  );
  assert.deepEqual(ledger.lookup(identity(), "original-business", "host-connection"), {
    found: false,
  });
});

test("p0.endpoint ledger module: fixed business excludes only top-level transport proof/mapping", () => {
  const context: CommandContext = {
    operation_id: randomUUID(),
    payload_digest: "0".repeat(64),
    caller_instance_id: randomUUID(),
    authority_epoch: 0,
    object_ref: { kind: "Session", id: randomUUID() },
    deadline: { clock_domain: "endpoint-clock", issued_at_ms: 10, expires_at_ms: 100 },
    grant_ref: randomUUID(),
  };
  const input = {
    grant_id: context.grant_ref,
    original_deadline: { clock_domain: "source-clock", issued_at_ms: 5, expires_at_ms: 90 },
    mapping: { connection_id: "first" },
    proof: { challenge_id: "first" },
  };
  const digest = endpointBusinessDigest("simulation.execute", input, context);
  assert.equal(
    endpointBusinessDigest(
      "simulation.execute",
      { ...input, mapping: { connection_id: "second" }, proof: { challenge_id: "second" } },
      { ...context, payload_digest: "f".repeat(64) },
    ),
    digest,
  );
  for (const changed of [
    { ...input, grant_id: randomUUID() },
    { ...input, original_deadline: { ...input.original_deadline, expires_at_ms: 91 } },
  ])
    assert.notEqual(endpointBusinessDigest("simulation.execute", changed, context), digest);
  assert.notEqual(
    endpointBusinessDigest("simulation.execute", input, {
      ...context,
      authority_epoch: 1,
    }),
    digest,
  );
  assert.notEqual(endpointBusinessDigest("simulation.query", input, context), digest);
});

test("p0.endpoint ledger module: 128 records and actual 4*M retained bytes are separate bounds", () => {
  const countLedger = new EndpointOperationLedger(16384);
  for (let index = 0; index < 128; index++) {
    const operation = identity(`operation-${index}`);
    const reserved = countLedger.reserve("ordinary", operation, `digest-${index}`, null);
    assert.ok(reserved);
    countLedger.commit(reserved, { accepted: index });
  }
  assert.equal(countLedger.usage("ordinary").count, 128);
  assert.equal(countLedger.reserve("ordinary", identity("overflow"), "overflow", null), null);
  assert.ok(countLedger.usage("ordinary").bytes <= 4 * 16384);
  assert.deepEqual(countLedger.usage("safety"), {
    count: 0,
    bytes: 0,
    maximum_bytes: 4 * 16384,
  });

  const messageBytes = 1024;
  const byteLedger = new EndpointOperationLedger(messageBytes);
  let committed = 0;
  while (committed < 128) {
    const operation = identity(`large-${committed}`);
    const reserved = byteLedger.reserve("query", operation, `digest-${committed}`, null);
    if (!reserved) break;
    const result = { snapshot: "s".repeat(600) };
    const actualBytes = Buffer.byteLength(JSON.stringify({ ...reserved.record, result }));
    const before = byteLedger.usage("query").bytes;
    byteLedger.commit(reserved, result);
    assert.equal(byteLedger.usage("query").bytes, before + actualBytes);
    committed++;
  }
  assert.ok(committed > 0 && committed < 128);
  const usage = byteLedger.usage("query");
  assert.equal(usage.count, committed);
  assert.ok(usage.bytes <= usage.maximum_bytes);
  assert.equal(byteLedger.reserve("query", identity("byte-overflow"), "digest", null), null);
});

async function rawResponse(channel: JsonChannel, requestId: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      channel.off("message", received);
      reject(new Error("ENDPOINT_RAW_RESPONSE_TIMEOUT"));
    }, 1000);
    const received = (value: unknown) => {
      if (!value || typeof value !== "object" || !("id" in value) || value.id !== requestId) return;
      clearTimeout(timer);
      channel.off("message", received);
      resolve(value);
    };
    channel.on("message", received);
  });
}

test("p0.endpoint process: operation and clock results stay bound across authenticated control reconnect", {
  timeout: 15000,
}, async () => {
  const fixture = await createProductionFixture();
  const m = await endpointMaterials(fixture);
  const clock = new MonotonicClock();
  let launched: Awaited<ReturnType<typeof launchEndpoint>> | undefined;
  let first: RpcConnection | undefined;
  let second: RpcConnection | undefined;
  try {
    launched = await launchEndpoint(m.config, m.host, clock, () => {});
    first = await RpcConnection.connect(
      m.config.safety_socket_path,
      m.endpoint.public,
      m.config.limits,
      m.supervisor.public.instance_id,
      clock,
      m.supervisor.public,
    );
    first.onEndpointFact(
      () => {},
      () => 0,
    );
    await first.authenticatePeer(m.supervisor);
    const queryContext = first.context(randomUUID(), null, 0, 1800);
    const firstQuery = (await first.request(
      completeRequest(
        "simulation.query",
        {
          session_id: m.config.session_id,
          endpoint_instance_id: m.config.endpoint_instance_id,
          mapping: first.mapping,
        },
        queryContext,
      ),
    )) as P0EndpointSnapshot;
    const context = first.context(randomUUID(), null, 0, 1800);
    const business = {
      session_id: m.config.session_id,
      grant_id: null,
      endpoint_instance_id: m.config.endpoint_instance_id,
      supervisor_instance_id: m.supervisor.public.instance_id,
      supervision_epoch: 0,
      fence: { scope_type: "session", scope_id: m.config.session_id, cancel_epoch: 0 },
      stop_operation_id: randomUUID(),
      reason: "operator_request",
    } as const;
    const original = (await first.request(
      completeRequest("endpoint.revoke", { ...business, mapping: first.mapping }, context),
    )) as P0EndpointSnapshot;
    const clockContext = first.context(randomUUID(), null, 0, 1800);
    const sample = { source_sent_at: clock.point() };
    const firstSample = (await first.request(
      completeRequest("clock.sample", { ...sample, mapping: first.mapping }, clockContext),
    )) as { connection_id: string };
    assert.equal(firstSample.connection_id, first.announcement.connection_id);
    const firstClosed = once(first.channel, "closed");
    first.close();
    await firstClosed;
    first = undefined;

    second = await RpcConnection.connect(
      m.config.safety_socket_path,
      m.endpoint.public,
      m.config.limits,
      m.supervisor.public.instance_id,
      clock,
      m.supervisor.public,
    );
    let currentEpoch = 0;
    second.onEndpointFact(
      () => {},
      () => currentEpoch,
    );
    await second.authenticatePeer(m.supervisor);
    const rebound = { ...business, mapping: second.mapping };
    const repeated = await second.request(completeRequest("endpoint.revoke", rebound, context));
    assert.deepEqual(repeated, original);
    const unchanged = await queryEndpoint(second, m.config);
    assert.equal(unchanged.source_revision, original.source_revision);
    assert.notEqual(unchanged.source_revision, firstQuery.source_revision);
    assert.deepEqual(
      await second.request(
        completeRequest(
          "simulation.query",
          {
            session_id: m.config.session_id,
            endpoint_instance_id: m.config.endpoint_instance_id,
            mapping: second.mapping,
          },
          queryContext,
        ),
      ),
      firstQuery,
    );
    await assert.rejects(
      second.request(
        completeRequest("endpoint.revoke", { ...rebound, reason: "supervision_expired" }, context),
      ),
      /OPERATION_PAYLOAD_CONFLICT/,
    );
    await assert.rejects(
      second.request(
        completeRequest(
          "endpoint.revoke",
          { ...rebound, endpoint_instance_id: randomUUID() },
          context,
        ),
      ),
      /ROLE_SCOPE_DENIED/,
    );
    await assert.rejects(
      second.request(
        completeRequest(
          "endpoint.revoke",
          { ...rebound, mapping: { ...second.mapping, target_instance_id: randomUUID() } },
          context,
        ),
      ),
      /CLOCK_MAPPING_INVALID/,
    );
    await assert.rejects(
      second.request(
        completeRequest(
          "simulation.query",
          {
            session_id: m.config.session_id,
            endpoint_instance_id: m.config.endpoint_instance_id,
            mapping: second.mapping,
          },
          context,
        ),
      ),
      /OPERATION_PAYLOAD_CONFLICT/,
    );
    await assert.rejects(
      second.request(
        completeRequest("clock.sample", { ...sample, mapping: second.mapping }, clockContext),
      ),
      /OPERATION_PAYLOAD_CONFLICT/,
    );
    const secondSample = (await second.peerCall("clock.sample", sample)) as {
      connection_id: string;
    };
    assert.equal(secondSample.connection_id, second.announcement.connection_id);
    assert.notEqual(secondSample.connection_id, firstSample.connection_id);
    assert.equal((await queryEndpoint(launched.connection, m.config)).completed_effect_count, 0);

    currentEpoch = 1;
    const advancedContext = second.context(randomUUID(), null, 1);
    const advanced = (await second.request(
      completeRequest(
        "endpoint.revoke",
        {
          ...rebound,
          fence: { ...rebound.fence, cancel_epoch: 1 },
          stop_operation_id: randomUUID(),
        },
        advancedContext,
      ),
    )) as P0EndpointSnapshot;
    assert.equal(advanced.fence_applied, true);
    await assert.rejects(
      second.request(completeRequest("endpoint.revoke", rebound, context)),
      /SCOPED_EPOCH_CONFLICT/,
    );

    const shortContext = second.context(randomUUID(), null, 1, 200);
    const shortRequest = completeRequest(
      "simulation.query",
      {
        session_id: m.config.session_id,
        endpoint_instance_id: m.config.endpoint_instance_id,
        mapping: second.mapping,
      },
      shortContext,
    );
    await second.request(shortRequest);
    await pause(260);
    const expired = completeRequest("simulation.query", shortRequest.params.input, shortContext);
    const expiredResponse = rawResponse(second.channel, expired.id);
    assert.equal(second.channel.send(expired), true);
    const expiredWire = (await expiredResponse) as { error?: { data?: { reason_code?: string } } };
    assert.equal(expiredWire.error?.data?.reason_code, "COMMAND_DEADLINE_MISSED");
  } finally {
    second?.close();
    first?.close();
    launched?.connection.close();
    if (launched) await terminateChild(launched.child);
    await fixture.cleanup();
  }
});

test("p0.endpoint protocol module: full safety ledger fences before error; invalid scope does not fence", {
  timeout: 15000,
}, async () => {
  const fixture = await createProductionFixture();
  const m = await endpointMaterials(fixture);
  const endpointClock = new MonotonicClock();
  const sourceClock = new MonotonicClock();
  const protocol = new EndpointProtocol(m.config, m.endpoint, endpointClock);
  const toEndpoint = new PassThrough();
  const toClient = new PassThrough();
  let activeWrite = 0;
  const completedWaiters = new Set<() => void>();
  const serverOutput = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      activeWrite++;
      toClient.write(chunk, (error) => {
        callback(error);
        queueMicrotask(() => {
          activeWrite--;
          if (activeWrite === 0 && serverOutput.writableLength === 0) {
            for (const resolve of completedWaiters) resolve();
            completedWaiters.clear();
          }
        });
      });
    },
  });
  const outputCompleted = () =>
    activeWrite === 0 && serverOutput.writableLength === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => completedWaiters.add(resolve));
  const server = new JsonChannel(toEndpoint, serverOutput, m.config.limits.max_message_bytes, 16);
  const client = new JsonChannel(toClient, toEndpoint, m.config.limits.max_message_bytes, 16);
  let connection: RpcConnection | undefined;
  try {
    const ready = RpcConnection.fromChannel(
      client,
      m.endpoint.public,
      m.config.limits,
      m.supervisor.public.instance_id,
      sourceClock,
      sourceClock.now(),
      m.supervisor.public,
    );
    protocol.accept(server, "supervisor");
    connection = await ready;
    connection.onEndpointFact(
      () => {},
      () => protocol.model.authorityEpoch,
    );
    await connection.authenticatePeer(m.supervisor);
    const revoke = {
      session_id: m.config.session_id,
      grant_id: null,
      endpoint_instance_id: m.config.endpoint_instance_id,
      supervisor_instance_id: m.supervisor.public.instance_id,
      supervision_epoch: 1,
      fence: { scope_type: "session", scope_id: m.config.session_id, cancel_epoch: 0 },
      stop_operation_id: randomUUID(),
      reason: "operator_request",
    } as const;
    const beforeInvalid = protocol.model.snapshot();
    await assert.rejects(
      connection.peerCall("endpoint.revoke", { ...revoke, endpoint_instance_id: randomUUID() }),
      /ROLE_SCOPE_DENIED/,
    );
    assert.deepEqual(protocol.model.snapshot(), beforeInvalid);
    for (let index = 0; index < 128; index++) {
      await outputCompleted();
      await connection.peerCall("endpoint.revoke", { ...revoke, stop_operation_id: randomUUID() });
    }
    const beforeFull = protocol.model.snapshot();
    // The reader can see a frame before the server's local Writable callback
    // completes; the callback barrier keeps this test focused on ledger state.
    await outputCompleted();
    await assert.rejects(
      connection.peerCall("endpoint.revoke", {
        ...revoke,
        supervision_epoch: 0,
        stop_operation_id: randomUUID(),
      }),
      /SCOPED_EPOCH_CONFLICT/,
    );
    assert.deepEqual(protocol.model.snapshot(), beforeFull);
    await outputCompleted();
    await assert.rejects(
      connection.peerCall("endpoint.revoke", { ...revoke, stop_operation_id: randomUUID() }),
      /QUEUE_LIMIT_EXCEEDED/,
    );
    const afterFull = protocol.model.snapshot();
    assert.ok(afterFull.source_revision > beforeFull.source_revision);
    assert.equal(afterFull.fence_applied, true);
    assert.equal(afterFull.host_connection_deadline, null);
    assert.ok(protocol.model.finalDeadline !== null);
    const afterRejected = protocol.model.snapshot();
    await outputCompleted();
    await assert.rejects(
      connection.peerCall("endpoint.revoke", { ...revoke, endpoint_instance_id: randomUUID() }),
      /ROLE_SCOPE_DENIED/,
    );
    assert.deepEqual(protocol.model.snapshot(), afterRejected);
  } finally {
    connection?.close();
    server.close();
    await protocol.close();
    await fixture.cleanup();
  }
});
