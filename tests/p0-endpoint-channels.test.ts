import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import { test } from "node:test";
import {
  assertValid,
  type P0EndpointSnapshot,
  type RpcEvent,
} from "../packages/contract-sdk/src/index.ts";
import { RpcConnection } from "../packages/runtime/src/client.ts";
import { MonotonicClock } from "../packages/runtime/src/clock.ts";
import { launchEndpoint, queryEndpoint } from "../packages/runtime/src/endpoint-client.ts";
import { completeRequest } from "../packages/runtime/src/identity.ts";
import { terminateChild } from "../packages/runtime/src/processes.ts";
import { JsonChannel } from "../packages/runtime/src/transport.ts";
import { createProductionFixture, endpointMaterials } from "./p0-endpoint.helpers.ts";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("ENDPOINT_TEST_WAIT_EXPIRED")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function rawCandidate(
  path: string,
  maxBytes: number,
): Promise<{ socket: Socket; channel: JsonChannel }> {
  const socket = createConnection(path);
  const channel = new JsonChannel(socket, socket, maxBytes, 4);
  const [announcement] = await within(once(channel, "message"), 1000);
  assertValid("RpcEvent", announcement);
  assert.equal(announcement.params.event_name, "connection.announced");
  return { socket, channel };
}

test("p0.endpoint process: N=1 Host, Supervisor control and cancel remain independent when cancel never replies", {
  timeout: 15000,
}, async () => {
  const fixture = await createProductionFixture();
  const m = await endpointMaterials(fixture);
  m.config.limits.max_pending_requests = 1;
  assertValid("P0EndpointConfig", m.config);
  const clock = new MonotonicClock();
  let launched: Awaited<ReturnType<typeof launchEndpoint>> | undefined;
  let control: RpcConnection | undefined;
  let cancel: RpcConnection | undefined;
  let rejectedCandidate: RpcConnection | undefined;
  try {
    launched = await launchEndpoint(m.config, m.host, clock, () => {});
    const hostStops: RpcEvent[] = [];
    const controlStops: RpcEvent[] = [];
    let hostStopSeen!: () => void;
    let controlStopSeen!: () => void;
    const hostStop = new Promise<void>((resolve) => {
      hostStopSeen = resolve;
    });
    const controlStop = new Promise<void>((resolve) => {
      controlStopSeen = resolve;
    });
    const collectStop = (target: RpcEvent[], seen: () => void) => (value: unknown) => {
      if (
        !value ||
        typeof value !== "object" ||
        !("method" in value) ||
        value.method !== "event.publish"
      )
        return;
      assertValid("RpcEvent", value);
      if (value.params.event_name !== "simulation.stopped") return;
      const fact = value.params.payload as P0EndpointSnapshot;
      if (!fact.cleanup_ref) return;
      target.push(value);
      seen();
    };
    launched.connection.channel.on("message", collectStop(hostStops, hostStopSeen));
    control = await RpcConnection.connect(
      m.config.safety_socket_path,
      m.endpoint.public,
      m.config.limits,
      m.supervisor.public.instance_id,
      clock,
      m.supervisor.public,
    );
    control.channel.on("message", collectStop(controlStops, controlStopSeen));
    let resolveStop: (() => void) | undefined;
    const stopEvent = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });
    const events: P0EndpointSnapshot[] = [];
    control.onEndpointFact(
      (fact) => {
        events.push(fact);
        if (fact.cleanup_ref !== null) resolveStop?.();
      },
      () => 0,
    );
    await control.authenticatePeer(m.supervisor);
    const initial = await queryEndpoint(control, m.config);
    assert.equal(initial.accepted_watermark, 0);
    assert.equal(initial.completed_effect_count, 0);
    assert.equal(initial.cleanup_ref, null);

    rejectedCandidate = await RpcConnection.connect(
      m.config.safety_socket_path,
      m.endpoint.public,
      m.config.limits,
      m.supervisor.public.instance_id,
      clock,
      m.supervisor.public,
    );
    await rejectedCandidate.authenticatePeer(m.supervisor);
    await assert.rejects(
      rejectedCandidate.peerCall("controller.observe_status", { instance_id: "wrong-endpoint" }),
      /ROLE_SCOPE_DENIED/,
    );

    cancel = await RpcConnection.connect(
      m.config.safety_socket_path,
      m.endpoint.public,
      m.config.limits,
      m.supervisor.public.instance_id,
      clock,
      m.supervisor.public,
    );
    let cancelEvents = 0;
    cancel.channel.on("message", (value: unknown) => {
      if (
        value &&
        typeof value === "object" &&
        "method" in value &&
        value.method === "event.publish"
      )
        cancelEvents++;
    });
    await cancel.authenticatePeer(m.supervisor);
    const status = await cancel.peerCall("controller.observe_status", {
      instance_id: m.config.endpoint_instance_id,
    });
    assertValid("ControllerStatus", status);
    rejectedCandidate.close();
    rejectedCandidate = undefined;
    const observed = await queryEndpoint(control, m.config);
    assert.equal(observed.source_revision, initial.source_revision);
    assert.equal(observed.cleanup_ref, initial.cleanup_ref);
    assert.equal(observed.accepted_watermark, initial.accepted_watermark);
    await assert.rejects(
      control.peerCall("controller.observe_status", { instance_id: m.config.endpoint_instance_id }),
      /ROLE_SCOPE_DENIED/,
    );
    await assert.rejects(
      cancel.peerCall("simulation.query", {
        session_id: m.config.session_id,
        endpoint_instance_id: m.config.endpoint_instance_id,
      }),
      /ROLE_SCOPE_DENIED/,
    );

    const faultContext = control.context();
    await control.request(
      completeRequest(
        "fault.apply",
        {
          fault_id: randomUUID(),
          session_id: m.config.session_id,
          target_instance_id: m.config.endpoint_instance_id,
          selection: { target: "endpoint", fault: "cancel_never_returns", duration_ms: 3000 },
          mapping: control.mapping,
          deadline: faultContext.deadline,
        },
        faultContext,
      ),
    );
    const stopContext = cancel.context();
    let stopSettled = false;
    const pendingStop = cancel
      .request(
        completeRequest(
          "controller.stop",
          {
            object_ref: stopContext.object_ref,
            reason: "operator_request",
            cancel_fence: { scope_type: "session", scope_id: m.config.session_id, cancel_epoch: 0 },
            stop_deadline: {
              clock_domain: stopContext.deadline.clock_domain,
              monotonic_ms: stopContext.deadline.expires_at_ms,
            },
          },
          stopContext,
        ),
      )
      .then(
        () => {
          stopSettled = true;
        },
        () => {
          stopSettled = true;
        },
      );
    await within(stopEvent, 1000);
    await within(Promise.all([hostStop, controlStop]), 1000);
    assert.equal(stopSettled, false);
    const afterStop = await queryEndpoint(control, m.config);
    const hostStopFact = hostStops[0];
    const controlStopFact = controlStops[0];
    assert.ok(hostStopFact);
    assert.ok(controlStopFact);
    assert.equal(hostStopFact.params.event_id, controlStopFact.params.event_id);
    assert.equal(hostStopFact.params.source_seq, controlStopFact.params.source_seq);
    assert.deepEqual(hostStopFact.params.payload, controlStopFact.params.payload);
    assert.equal(
      (hostStopFact.params.payload as P0EndpointSnapshot).source_revision,
      afterStop.source_revision,
    );
    assert.equal(afterStop.fence_applied, true);
    assert.equal(afterStop.stopped, true);
    assert.ok(afterStop.cleanup_ref);
    assert.equal(afterStop.accepted_watermark, 0);
    assert.equal(afterStop.completed_effect_count, 0);
    assert.ok(events.length > 0);

    await control.peerCall("endpoint.revoke", {
      session_id: m.config.session_id,
      grant_id: null,
      endpoint_instance_id: m.config.endpoint_instance_id,
      supervisor_instance_id: m.supervisor.public.instance_id,
      supervision_epoch: 0,
      fence: { scope_type: "session", scope_id: m.config.session_id, cancel_epoch: 0 },
      stop_operation_id: randomUUID(),
      reason: "operator_request",
    });
    const afterRevoke = await queryEndpoint(control, m.config);
    assert.equal(afterRevoke.fence_applied, true);
    assert.equal(afterRevoke.completed_effect_count, 0);
    assert.equal(afterRevoke.accepted_watermark, 0);
    assert.ok(afterRevoke.cleanup_ref);
    assert.equal(cancel.channel.closed, false);
    assert.equal(cancelEvents, 0);
    assert.equal(stopSettled, false);

    const hostFact = await queryEndpoint(launched.connection, m.config);
    assert.equal(hostFact.source_revision, afterRevoke.source_revision);
    assert.equal(hostFact.completed_effect_count, afterRevoke.completed_effect_count);
    assert.equal(hostFact.accepted_watermark, afterRevoke.accepted_watermark);
    cancel.close();
    await pendingStop;
  } finally {
    rejectedCandidate?.close();
    cancel?.close();
    control?.close();
    launched?.connection.close();
    if (launched) await terminateChild(launched.child);
    await fixture.cleanup();
  }
});

test("p0.endpoint process: N=1 candidate eviction never displaces authenticated candidates or Host", {
  timeout: 15000,
}, async () => {
  const fixture = await createProductionFixture();
  const m = await endpointMaterials(fixture);
  m.config.limits.max_pending_requests = 1;
  // This finite candidate window leaves enough time to observe late authentication separately.
  m.config.limits.stop_timeout_ms = 1800;
  assertValid("P0EndpointConfig", m.config);
  const clock = new MonotonicClock();
  let launched: Awaited<ReturnType<typeof launchEndpoint>> | undefined;
  const raw: JsonChannel[] = [];
  const peers: RpcConnection[] = [];
  try {
    launched = await launchEndpoint(m.config, m.host, clock, () => {});
    const first = await rawCandidate(
      m.config.safety_socket_path,
      m.config.limits.max_message_bytes,
    );
    raw.push(first.channel);
    const second = await rawCandidate(
      m.config.safety_socket_path,
      m.config.limits.max_message_bytes,
    );
    raw.push(second.channel);
    const firstClosed = once(first.channel, "closed");
    const third = await rawCandidate(
      m.config.safety_socket_path,
      m.config.limits.max_message_bytes,
    );
    raw.push(third.channel);
    await within(firstClosed, 500);
    assert.equal(second.channel.closed, false);
    assert.equal(third.channel.closed, false);
    second.channel.close();
    third.channel.close();

    const authenticated = await RpcConnection.connect(
      m.config.safety_socket_path,
      m.endpoint.public,
      m.config.limits,
      m.supervisor.public.instance_id,
      clock,
      m.supervisor.public,
    );
    peers.push(authenticated);
    // Local announcement receipt is later than endpoint accept, so it is a safe
    // upper anchor for asserting that the original candidate window has elapsed.
    const announcedAt = performance.now();
    await pause(500);
    await authenticated.authenticatePeer(m.supervisor);
    const other = await RpcConnection.connect(
      m.config.safety_socket_path,
      m.endpoint.public,
      m.config.limits,
      m.supervisor.public.instance_id,
      clock,
      m.supervisor.public,
    );
    peers.push(other);
    await other.authenticatePeer(m.supervisor);
    const refused = createConnection(m.config.safety_socket_path);
    try {
      await within(once(refused, "close"), 500);
    } finally {
      refused.destroy();
    }
    assert.equal(authenticated.channel.closed, false);
    assert.equal(other.channel.closed, false);
    await within(queryEndpoint(launched.connection, m.config), 500);

    const candidateBudget = Math.min(
      m.config.limits.clock_mapping_ttl_ms,
      m.config.limits.peer_health_timeout_ms,
      m.config.limits.stop_timeout_ms,
    );
    await pause(Math.max(0, candidateBudget + 250 - (performance.now() - announcedAt)));
    assert.equal(authenticated.channel.closed, true);
    // A newly authenticated candidate cannot acquire a fresh full candidate window.
  } finally {
    for (const peer of peers) peer.close();
    for (const channel of raw) channel.close();
    launched?.connection.close();
    if (launched) await terminateChild(launched.child);
    await fixture.cleanup();
  }
});

test("p0.endpoint process: fragmented unauthenticated input does not extend the candidate deadline", {
  timeout: 15000,
}, async () => {
  const fixture = await createProductionFixture();
  const m = await endpointMaterials(fixture);
  m.config.limits.max_pending_requests = 1;
  // A finite one-second candidate window makes a half-window fragment observable.
  m.config.limits.stop_timeout_ms = 1000;
  assertValid("P0EndpointConfig", m.config);
  const clock = new MonotonicClock();
  let launched: Awaited<ReturnType<typeof launchEndpoint>> | undefined;
  let candidate: Awaited<ReturnType<typeof rawCandidate>> | undefined;
  try {
    launched = await launchEndpoint(m.config, m.host, clock, () => {});
    candidate = await rawCandidate(m.config.safety_socket_path, m.config.limits.max_message_bytes);
    const announcedAt = performance.now();
    let closedAt: number | null = null;
    candidate.channel.once("closed", () => {
      closedAt = performance.now();
    });
    await pause(500);
    candidate.socket.write('{"jsonrpc":"2.0","id":"fragment"');
    const candidateBudget = Math.min(
      m.config.limits.clock_mapping_ttl_ms,
      m.config.limits.peer_health_timeout_ms,
      m.config.limits.stop_timeout_ms,
    );
    await pause(Math.max(0, candidateBudget + 350 - (performance.now() - announcedAt)));
    assert.ok(closedAt !== null);
    assert.ok(closedAt - announcedAt < candidateBudget + 350);
    const fact = await queryEndpoint(launched.connection, m.config);
    assert.equal(fact.accepted_watermark, 0);
    assert.equal(fact.completed_effect_count, 0);
  } finally {
    candidate?.channel.close();
    launched?.connection.close();
    if (launched) await terminateChild(launched.child);
    await fixture.cleanup();
  }
});
