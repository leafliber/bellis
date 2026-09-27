import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  assertValid,
  type P0EndpointSnapshot,
  type P0OperatorCredential,
  type P0SafetyLimits,
  type RpcEvent,
  type RpcRequest,
} from "../packages/contract-sdk/src/index.ts";
import { RpcConnection } from "../packages/runtime/src/client.ts";
import { MonotonicClock } from "../packages/runtime/src/clock.ts";
import {
  announce,
  announcementEvent,
  generateIdentity,
  type Identity,
} from "../packages/runtime/src/identity.ts";
import { ObservationWriter } from "../packages/runtime/src/observation.ts";
import { JsonChannel } from "../packages/runtime/src/transport.ts";
import { limits, repository } from "./p0-identity.helpers.ts";

export class ClientClock extends MonotonicClock {
  time = 1000;
  override now(): number {
    return this.time;
  }
}
export const credential: P0OperatorCredential = {
  credential_id: "client-module-credential",
  operator_id: "client-module-operator",
  role: "test_operator",
  authentication_key_sha256: "c".repeat(64),
};
export async function connectionFixture(
  options: {
    identity?: Identity;
    authority?: Identity;
    clock?: ClientClock;
    targetClock?: ClientClock;
    epoch?: number;
    session?: string;
    caller?: string;
    limits?: Partial<P0SafetyLimits>;
  } = {},
) {
  const authority = options.authority ?? options.identity ?? generateIdentity("supervisor");
  const identity = options.identity ?? authority;
  const clock = options.clock ?? new ClientClock();
  const targetClock = options.targetClock ?? new ClientClock();
  const bounded = { ...limits, ...options.limits };
  const input = new PassThrough(),
    output = new PassThrough();
  const channel = new JsonChannel(
    input,
    output,
    bounded.max_message_bytes,
    bounded.max_pending_requests,
  );
  const server = new JsonChannel(
    output,
    input,
    bounded.max_message_bytes,
    bounded.max_pending_requests,
  );
  const raw: Buffer[] = [];
  const caller = options.caller ?? "client-module-caller";
  const writer = new ObservationWriter("operator", caller, clock, bounded, {
    write(bytes, callback) {
      raw.push(Buffer.from(bytes));
      callback();
      return true;
    },
  });
  const requests: RpcRequest[] = [];
  server.on("message", (r) => {
    assertValid("RpcRequest", r);
    requests.push(r);
  });
  const ready = RpcConnection.fromChannel(
    channel,
    identity.public,
    bounded,
    caller,
    clock,
    clock.now(),
    authority.public,
    writer,
  );
  const a = announce(
    identity,
    options.session ?? "client-module-session",
    targetClock,
    bounded.clock_mapping_ttl_ms,
    authority.public,
    options.epoch ?? 0,
  );
  const original = announcementEvent(a);
  server.send(original);
  const connection = await ready;
  const directory = join(repository, "reports/p0/w5sl/client-raw", randomUUID());
  return {
    connection,
    server,
    requests,
    original,
    identity,
    authority,
    clock,
    targetClock,
    limits: bounded,
    cleanup: async () => {
      connection.close();
      server.close();
      await writer.finish();
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "protocol.ndjson"), Buffer.concat(raw), { flag: "wx" });
    },
  };
}
export function endpointEvent(
  f: Awaited<ReturnType<typeof connectionFixture>>,
  seq = 0,
  epoch = 0,
): RpcEvent {
  const snapshot: P0EndpointSnapshot = {
    endpoint_instance_id: f.identity.public.instance_id,
    supervisor_instance_id: f.authority.public.instance_id,
    session_id: f.connection.announcement.session_id,
    supervision_epoch: 0,
    source_revision: seq,
    observed_at: f.targetClock.point(),
    active_grant_ref: null,
    lease_deadline: null,
    host_connection_deadline: null,
    fence_applied: true,
    queued_operation_ids: [],
    stopped: true,
    accepted_watermark: 0,
    completed_effect_count: 0,
    effect_facts: [],
    not_executed_operation_ids: [],
    unknown_operation_ids: [],
    cleanup_ref: null,
  };
  assertValid("P0EndpointSnapshot", snapshot);
  const event = {
    jsonrpc: "2.0",
    method: "event.publish",
    params: {
      schema_version: "0.8.0",
      correlation: { key: "endpoint", value: snapshot.endpoint_instance_id },
      event_name: "simulation.stopped",
      event_id: `module-event-${seq}`,
      session_id: snapshot.session_id,
      authority_id: "endpoint",
      source_instance: snapshot.endpoint_instance_id,
      source_seq: seq,
      authority_epoch: epoch,
      scope_ref: { kind: "Session", id: snapshot.session_id },
      occurred_at: f.targetClock.point(),
      trace_id: "module-trace",
      payload: snapshot,
    },
  };
  assertValid("RpcEvent", event);
  return event;
}
