import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertValid,
  type CommandContext,
  type P0OperatorCredential,
  type P0SafetyLimits,
  type StopOperationRecord,
} from "../packages/contract-sdk/src/index.ts";
import { RpcConnection } from "../packages/runtime/src/client.ts";
import { clockMapping, MonotonicClock, mappedDeadline } from "../packages/runtime/src/clock.ts";
import {
  generateIdentity,
  type Identity,
  operatorRequest,
  verifyAnnouncement,
} from "../packages/runtime/src/identity.ts";
import { type ObservationSink, ObservationWriter } from "../packages/runtime/src/observation.ts";
import { initialSnapshot } from "../packages/runtime/src/processes.ts";
import {
  P0Service,
  type ServiceDelegate,
  type ServiceInvocation,
} from "../packages/runtime/src/service.ts";
import { JsonChannel } from "../packages/runtime/src/transport.ts";
import { limits } from "./p0-identity.helpers.ts";

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 1500;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("CONTROLLED_CONDITION_TIMEOUT");
    await delay(2);
  }
}
export function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export const selection = { target: "host", fault: "none", duration_ms: 0 } as const;
export async function serviceFixture(
  options: {
    role?: "host" | "supervisor";
    limits?: Partial<P0SafetyLimits>;
    delegate?: ServiceDelegate;
    sink?: ObservationSink;
    observation?: boolean;
    clock?: MonotonicClock;
  } = {},
) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "bs-"));
  await chmod(directory, 0o700);
  const supervisor = generateIdentity("supervisor"),
    host = generateIdentity("host");
  const identity = options.role === "host" ? host : supervisor;
  const clock = options.clock ?? new MonotonicClock();
  const bounded = { ...limits, max_pending_requests: 1, ...options.limits };
  const credential: P0OperatorCredential = {
    credential_id: randomUUID(),
    operator_id: "controlled-operator",
    role: "test_operator",
    authentication_key_sha256: randomBytes(32).toString("hex"),
  };
  const raw: Buffer[] = [];
  const writer = new ObservationWriter(
    identity.public.role,
    identity.public.instance_id,
    clock,
    bounded,
    options.sink ?? {
      write: (bytes, callback) => {
        raw.push(Buffer.from(bytes));
        callback();
        return true;
      },
    },
  );
  const snapshot = initialSnapshot(
    "controlled-session",
    supervisor.public.instance_id,
    host.public.instance_id,
    "controlled-endpoint",
    [],
  );
  let epoch = 0,
    health = 0;
  const service = new P0Service({
    identity,
    authority: supervisor.public,
    currentAuthorityEpoch: () => epoch,
    sessionId: snapshot.session_id,
    clock,
    limits: bounded,
    credential,
    peers: [host.public, supervisor.public],
    snapshot: () => structuredClone(snapshot),
    onHealth: () => {
      health++;
    },
    faultInjectionEnabled: true,
    ...(options.observation === false ? {} : { observation: writer }),
    ...(options.delegate ? { delegate: options.delegate } : {}),
  });
  const socket = join(directory, "service.sock");
  await service.listen(socket);
  const clients: RpcConnection[] = [];
  const wires: JsonChannel[] = [];
  const wire = async (instanceId: string = randomUUID()) => {
    const source = new MonotonicClock(),
      sent = source.now();
    const stream = createConnection(socket);
    const channel = new JsonChannel(stream, stream, bounded.max_message_bytes, 3);
    wires.push(channel);
    const messages: unknown[] = [];
    channel.on("message", (raw) => messages.push(raw));
    await until(() => messages.length > 0);
    const announcement = verifyAnnouncement(messages.shift(), identity.public, supervisor.public);
    const mapping = clockMapping(announcement, source, instanceId, sent, source.now(), bounded);
    return {
      channel,
      messages,
      announcement,
      mapping,
      clock: source,
      context: (): CommandContext => ({
        operation_id: randomUUID(),
        payload_digest: "0".repeat(64),
        caller_instance_id: instanceId,
        authority_epoch: announcement.authority_epoch,
        object_ref: { kind: "Session", id: snapshot.session_id },
        deadline: mappedDeadline(mapping, source.now(), bounded.peer_health_timeout_ms),
        grant_ref: null,
      }),
    };
  };
  const connect = async (peer?: Identity) => {
    const client = await RpcConnection.connect(
      socket,
      identity.public,
      bounded,
      peer?.public.instance_id ?? randomUUID(),
      new MonotonicClock(),
      supervisor.public,
    );
    clients.push(client);
    return client;
  };
  const call = (client: RpcConnection, method: string, input: object, timeout = 1000) => {
    const context = client.context();
    context.deadline.expires_at_ms = Math.min(
      context.deadline.expires_at_ms,
      clock.now() + timeout,
    );
    return client.request(
      operatorRequest(
        method,
        { ...input, mapping: client.mapping },
        context,
        client.announcement,
        credential,
      ),
    );
  };
  return {
    service,
    socket,
    directory,
    identity,
    supervisor,
    host,
    clock,
    limits: bounded,
    credential,
    writer,
    raw,
    snapshot,
    connect,
    wire,
    call,
    get epoch() {
      return epoch;
    },
    set epoch(value: number) {
      epoch = value;
    },
    get health() {
      return health;
    },
    fault: (client: RpcConnection, timeout = 1000) =>
      call(client, "fault.configure", { session_id: snapshot.session_id, selection }, timeout),
    stop: (client: RpcConnection, timeout = 1000) =>
      call(
        client,
        "session.stop",
        {
          session_id: snapshot.session_id,
          target_ref: { kind: "Session", id: snapshot.session_id },
          reason: "operator_request",
        },
        timeout,
      ),
    faultResult: () => ({ fault_id: "controlled-fault", selection, accepted_at: clock.point() }),
    stopRecord(invocation: ServiceInvocation): StopOperationRecord {
      const record: StopOperationRecord = {
        stop_operation_id: invocation.request.params.context.operation_id,
        target: { kind: "Session", id: snapshot.session_id },
        fence: { scope_type: "session", scope_id: snapshot.session_id, cancel_epoch: epoch },
        requested_at: clock.point(),
        deadline: {
          clock_domain: clock.domain,
          monotonic_ms: invocation.request.params.context.deadline.expires_at_ms,
        },
        local_fence_applied: true,
        endpoint_ack: null,
        record_status: "pending",
        incident_ref: null,
        recovery_owner_ref: null,
        state: "REQUESTED",
        supervisor_instance_id: supervisor.public.instance_id,
        endpoint_instance_id: "controlled-endpoint",
        endpoint_fact: null,
        cleanup_ref: null,
      };
      assertValid("StopOperationRecord", record);
      return record;
    },
    async cleanup() {
      for (const client of clients) client.close();
      for (const channel of wires) channel.close();
      await service.close();
      await writer.finish();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
