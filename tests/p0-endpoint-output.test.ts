import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import type { RpcEvent } from "../packages/contract-sdk/src/index.ts";
import { RpcConnection } from "../packages/runtime/src/client.ts";
import { MonotonicClock } from "../packages/runtime/src/clock.ts";
import { queryEndpoint } from "../packages/runtime/src/endpoint-client.ts";
import type { Identity } from "../packages/runtime/src/identity.ts";
import { JsonChannel } from "../packages/runtime/src/transport.ts";
import { EndpointOutput } from "../plugins/fake-device/endpoint-output.ts";
import { EndpointProtocol } from "../plugins/fake-device/protocol.ts";
import { createProductionFixture, endpointMaterials } from "./p0-endpoint.helpers.ts";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("p0.endpoint output module: slow Writable keeps exact per-class count and bytes until completion", async () => {
  const pending: Array<() => void> = [];
  const written: Buffer[] = [];
  const sink = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, callback) {
      written.push(Buffer.from(chunk));
      pending.push(callback);
    },
  });
  const channel = new JsonChannel(new PassThrough(), sink, 1024, 12);
  const failures: string[] = [];
  const output = new EndpointOutput(1024, 1, (_channel, reason) => failures.push(reason));
  try {
    const ordinary = output.reserve(channel, "ordinary");
    assert.ok(ordinary);
    assert.equal(output.usage(channel, "ordinary").bytes, 1024);
    let enqueued = 0;
    channel.on("enqueue", () => enqueued++);
    const response = { jsonrpc: "2.0", result: { accepted: true } };
    output.send(ordinary, response);
    assert.equal(output.usage(channel, "ordinary").count, 1);
    assert.equal(
      output.usage(channel, "ordinary").bytes,
      Buffer.byteLength(JSON.stringify(response)),
    );
    assert.equal(output.reserve(channel, "ordinary"), null);
    const payload = { data: "x".repeat(1000) };
    const envelope = { jsonrpc: "2.0", method: "event.publish", params: payload };
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(envelope)) > 1024);
    assert.equal(output.reserve(channel, "event", envelope), null);
    const safety = output.reserve(channel, "safety");
    const query = output.reserve(channel, "query");
    assert.ok(safety);
    assert.ok(query);
    output.send(safety, { result: "safety" });
    output.send(query, { result: "query" });
    assert.equal(enqueued, 3);
    assert.equal(pending.length, 1); // The first write(false) did not reject or release it.
    assert.equal(output.usage(channel, "safety").count, 1);
    assert.equal(output.usage(channel, "query").count, 1);
    for (const kind of ["ordinary", "safety", "query"] as const) {
      const complete = pending.shift();
      assert.ok(complete);
      complete();
      await turn();
      assert.equal(output.usage(channel, kind).count, 0);
      assert.equal(output.usage(channel, kind).bytes, 0);
    }
    assert.equal(written.length, 3);
    assert.deepEqual(failures, []);
  } finally {
    channel.close();
  }
});

test("p0.endpoint output module: delayed cancellation, duplicate callback and close release once", () => {
  class AdversarialWritable extends EventEmitter {
    readonly callbacks: Array<(error?: Error | null) => void> = [];
    write(_chunk: Buffer, callback: (error?: Error | null) => void): boolean {
      this.callbacks.push(callback);
      return false;
    }
    destroy(): void {
      this.emit("close");
    }
    end(callback?: () => void): void {
      callback?.();
    }
  }
  const sink = new AdversarialWritable();
  const channel = new JsonChannel(new PassThrough(), sink as unknown as Writable, 1024, 12);
  const failures: string[] = [];
  const output = new EndpointOutput(1024, 1, (_channel, reason) => failures.push(reason));
  const delayed = output.reserve(channel, "event", { payload: "original" });
  assert.ok(delayed);
  assert.equal(output.usage(channel, "event").count, 1);
  output.cancel(delayed); // No timer was admitted, so no send will occur.
  output.send(delayed, { payload: "original" });
  assert.equal(output.usage(channel, "event").count, 0);
  assert.equal(sink.callbacks.length, 0);

  const query = output.reserve(channel, "query");
  assert.ok(query);
  output.send(query, { result: "once" });
  assert.equal(output.usage(channel, "query").count, 1);
  sink.callbacks[0]?.();
  sink.callbacks[0]?.();
  assert.equal(output.usage(channel, "query").count, 0);
  assert.deepEqual(failures, []);

  const safety = output.reserve(channel, "safety");
  const unsent = output.reserve(channel, "event", { payload: "pending timer" });
  assert.ok(safety);
  assert.ok(unsent);
  output.send(safety, { result: "late" });
  channel.close();
  assert.equal(output.usage(channel, "safety").count, 0);
  assert.equal(output.usage(channel, "event").count, 0);
  output.send(unsent, { payload: "pending timer" });
  assert.deepEqual(failures, ["closed"]);
  sink.callbacks[1]?.();
  sink.callbacks[1]?.(new Error("late"));
  assert.equal(output.usage(channel, "safety").count, 0);
  assert.deepEqual(failures, ["closed"]);
});

test("p0.endpoint output module: a real write failure fences its channel once", () => {
  const callbacks: Array<(error?: Error | null) => void> = [];
  const sink = new Writable({
    write(_chunk: Buffer, _encoding, callback) {
      callbacks.push(callback);
    },
  });
  const channel = new JsonChannel(new PassThrough(), sink, 1024, 12);
  const reasons: string[] = [];
  const output = new EndpointOutput(1024, 1, (_channel, reason) => reasons.push(reason));
  const ticket = output.reserve(channel, "safety");
  assert.ok(ticket);
  output.send(ticket, { result: "pending" });
  callbacks[0]?.(new Error("controlled write failure"));
  assert.equal(channel.closed, true);
  assert.deepEqual(reasons, ["write"]);
  assert.equal(output.usage(channel, "safety").count, 0);
});

test("p0.endpoint output module: an oversized complete response closes before any write", () => {
  let writes = 0;
  const sink = new Writable({
    write(_chunk: Buffer, _encoding, callback) {
      writes++;
      callback();
    },
  });
  const channel = new JsonChannel(new PassThrough(), sink, 1024, 12);
  const reasons: string[] = [];
  const output = new EndpointOutput(1024, 1, (_channel, reason) => reasons.push(reason));
  const ticket = output.reserve(channel, "safety");
  assert.ok(ticket);
  output.send(ticket, { jsonrpc: "2.0", result: { data: "x".repeat(1000) } });
  assert.equal(writes, 0);
  assert.equal(channel.closed, true);
  assert.deepEqual(reasons, ["frame"]);
  assert.equal(output.usage(channel, "safety").count, 0);
});

test("p0.endpoint protocol module: a slow Host stop fact isolates once while control still queries actual facts", {
  timeout: 10000,
}, async () => {
  const fixture = await createProductionFixture();
  const m = await endpointMaterials(fixture);
  m.config.limits.max_pending_requests = 1;
  const protocol = new EndpointProtocol(m.config, m.endpoint, new MonotonicClock());
  const clock = new MonotonicClock();
  const connections: RpcConnection[] = [];
  const serverChannels: JsonChannel[] = [];
  const hostPending: Array<() => void> = [];
  let holdHost = false;
  let stage = "connect host";
  const connect = async (role: "host" | "supervisor", identity: Identity) => {
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    const output = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        toClient.write(chunk);
        if (role === "host" && holdHost) hostPending.push(callback);
        else callback();
      },
    });
    const server = new JsonChannel(toServer, output, m.config.limits.max_message_bytes, 12);
    const client = new JsonChannel(toClient, toServer, m.config.limits.max_message_bytes, 12);
    const ready = RpcConnection.fromChannel(
      client,
      m.endpoint.public,
      m.config.limits,
      identity.public.instance_id,
      clock,
      clock.now(),
      m.supervisor.public,
    );
    protocol.accept(server, role);
    const connection = await ready;
    connection.onEndpointFact(
      () => {},
      () => 0,
    );
    connections.push(connection);
    serverChannels.push(server);
    await connection.authenticatePeer(identity);
    return connection;
  };
  try {
    const host = await connect("host", m.host);
    stage = "connect control";
    const control = await connect("supervisor", m.supervisor);
    stage = "classify control";
    await queryEndpoint(control, m.config); // Classify the candidate as control.
    const hostEvents: RpcEvent[] = [];
    const controlEvents: RpcEvent[] = [];
    const collect = (target: RpcEvent[]) => (value: unknown) => {
      if (
        value &&
        typeof value === "object" &&
        "method" in value &&
        value.method === "event.publish"
      )
        target.push(value as RpcEvent);
    };
    host.channel.on("message", collect(hostEvents));
    control.channel.on("message", collect(controlEvents));

    holdHost = true;
    stage = "first stop fact";
    protocol.model.fence();
    assert.equal(hostPending.length, 1);
    assert.equal(hostEvents.length, 1);
    assert.equal(controlEvents.length, 1);
    assert.equal(hostEvents[0]?.params.event_id, controlEvents[0]?.params.event_id);
    assert.equal(hostEvents[0]?.params.source_seq, controlEvents[0]?.params.source_seq);
    assert.deepEqual(hostEvents[0]?.params.payload, controlEvents[0]?.params.payload);
    await turn(); // Only the healthy control write completes; the Host stays stalled.
    stage = "second stop fact";
    protocol.model.fence(); // A second normal fact is bounded independently of safety/query.
    await turn();
    stage = "third stop fact";
    protocol.model.fence(); // The Host event slots are still held by real write callbacks.
    const actual = protocol.model.snapshot();
    assert.equal(actual.source_revision, 4); // One nested isolation fence, no recursive stream.
    assert.ok(protocol.model.finalDeadline !== null);
    assert.equal(actual.fence_applied, true);
    assert.equal(actual.stopped, true);
    assert.equal(actual.completed_effect_count, 0);
    assert.ok(actual.cleanup_ref);
    assert.equal(serverChannels[0]?.closed, true);
    stage = "independent control query";
    const independent = await queryEndpoint(control, m.config);
    assert.deepEqual(independent, actual);
    assert.equal(control.channel.closed, false);
    assert.deepEqual(
      controlEvents.map((event) => event.params.payload.source_revision),
      [1, 2, 4],
      "the old third event is withdrawn before the nested emergency fact is broadcast",
    );
    hostPending[0]?.(); // Late local completion cannot reopen or change the terminal fact.
    assert.deepEqual(protocol.model.snapshot(), actual);
  } catch (error) {
    throw new Error(`OUTPUT_TEST_STAGE_${stage}`, { cause: error });
  } finally {
    for (const connection of connections) connection.close();
    await protocol.close();
    await fixture.cleanup();
  }
});

test("p0.endpoint protocol module: output failure withdraws delayed old facts before their timer fires", {
  timeout: 10000,
}, async () => {
  const fixture = await createProductionFixture();
  const m = await endpointMaterials(fixture);
  m.config.limits.max_pending_requests = 1;
  const protocol = new EndpointProtocol(m.config, m.endpoint, new MonotonicClock());
  const clock = new MonotonicClock();
  const connections: RpcConnection[] = [];
  let hostInput: PassThrough | undefined;
  let holdHost = false;
  const connect = async (role: "host" | "supervisor", identity: Identity) => {
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    const output = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        toClient.write(chunk);
        if (role !== "host" || !holdHost) callback();
      },
    });
    const server = new JsonChannel(toServer, output, m.config.limits.max_message_bytes, 12);
    const client = new JsonChannel(toClient, toServer, m.config.limits.max_message_bytes, 12);
    const ready = RpcConnection.fromChannel(
      client,
      m.endpoint.public,
      m.config.limits,
      identity.public.instance_id,
      clock,
      clock.now(),
      m.supervisor.public,
    );
    protocol.accept(server, role);
    const connection = await ready;
    connection.onEndpointFact(
      () => {},
      () => 0,
    );
    connections.push(connection);
    await connection.authenticatePeer(identity);
    if (role === "host") hostInput = toServer;
    return connection;
  };
  try {
    await connect("host", m.host);
    const control = await connect("supervisor", m.supervisor);
    await queryEndpoint(control, m.config);
    const events: RpcEvent[] = [];
    control.channel.on("message", (value: unknown) => {
      if (
        value &&
        typeof value === "object" &&
        "method" in value &&
        value.method === "event.publish"
      )
        events.push(value as RpcEvent);
    });
    holdHost = true;
    protocol.model.setFault({ target: "endpoint", fault: "ack_delay", duration_ms: 1000 });
    protocol.model.fence(); // The old rev=1 event is reserved for both recipients, but not sent.
    assert.equal(events.length, 0);
    assert.ok(hostInput);
    hostInput.write(Buffer.from("{}\n".repeat(5))); // Exhaust only Host setup writes.
    assert.equal(protocol.model.snapshot().source_revision, 2);
    assert.equal(protocol.model.snapshot().fence_applied, true);
    assert.equal(protocol.model.snapshot().stopped, true);
    const observed = await queryEndpoint(control, m.config);
    assert.deepEqual(observed, protocol.model.snapshot());
    assert.deepEqual(
      events.map((event) => event.params.payload.source_revision),
      [2],
    );
    await new Promise<void>((resolve) => setTimeout(resolve, m.config.limits.stop_timeout_ms + 25));
    assert.deepEqual(
      events.map((event) => event.params.payload.source_revision),
      [2],
      "the canceled rev=1 timer cannot publish after the emergency fact",
    );
    assert.deepEqual(protocol.model.snapshot(), observed);
  } finally {
    for (const connection of connections) connection.close();
    await protocol.close();
    await fixture.cleanup();
  }
});
