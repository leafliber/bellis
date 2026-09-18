import { createHash } from "node:crypto";
import {
  assertValid,
  type P0EndpointSnapshot,
  type P0ObservationError,
  type P0ObservationStreamEnd,
  type P0ObservedRpcRequest,
  type P0PeerIdentity,
  type P0ProcessObservation,
  type P0ProtocolObservation,
  type P0SafetyLimits,
  payloadDigest,
  type RpcRequest,
  SchemaValidationError,
  validate,
} from "../../contract-sdk/src/index.ts";
import { MonotonicClock } from "./clock.ts";
import { RuntimeRejection } from "./errors.ts";
import { authenticationDigest } from "./identity.ts";
import type { FrameEvidence, JsonChannel } from "./transport.ts";

type Stream = P0ObservationStreamEnd["stream"];
type Role = P0ProcessObservation["source_role"];
export type StartupStage = Extract<
  P0ProcessObservation["detail"],
  { kind: "startup_rejected" }
>["stage"];
export type ObservationSink = {
  write: (bytes: Buffer, callback: (error?: Error | null) => void) => unknown;
  on?: (event: string, listener: (error?: Error) => void) => unknown;
  off?: (event: string, listener: (error?: Error) => void) => unknown;
};
export type CommandTrigger = {
  trigger_kind: "command";
  trigger_id: string;
  trigger_digest: string;
  receive_seq: number;
};
export type ObservationTrigger = {
  trigger_kind: "process_fact" | "protocol_fact";
  trigger_id: string;
  trigger_digest: string;
};
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** Classify structured errors only. Error.message, stack, paths and arbitrary values are never read. */
export function observationError(error: unknown): P0ObservationError {
  if (error instanceof RuntimeRejection) return { kind: "runtime", reason_code: error.reason };
  if (error instanceof SchemaValidationError) {
    const result = { kind: "schema", schema_name: error.schemaName, keyword: error.keyword };
    if (validate("P0ObservationError", result)) return result;
  }
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    /^E[A-Z0-9_]+$/.test(error.code)
  ) {
    const node = error as NodeJS.ErrnoException;
    const result = {
      kind: "node",
      name: error.name,
      code: node.code ?? null,
      errno: Number.isInteger(node.errno) ? (node.errno ?? null) : null,
      syscall:
        typeof node.syscall === "string" && /^[A-Za-z][A-Za-z0-9_.]*$/.test(node.syscall)
          ? node.syscall
          : null,
    };
    if (validate("P0ObservationError", result)) return result;
  }
  return { kind: "internal", code: "unexpected_error" };
}

function requestSchemaError(value: unknown): P0ObservationError {
  try {
    assertValid("RpcRequest", value);
  } catch (error) {
    return observationError(error);
  }
  return { kind: "internal", code: "unexpected_error" };
}

export function observationTrigger(
  record: P0ProcessObservation | P0ProtocolObservation,
): ObservationTrigger {
  if (record.source_instance_id === null) throw new Error("UNBOUND_OBSERVATION_TRIGGER");
  return {
    trigger_kind:
      record.record_type === "p0-process-observation" ? "process_fact" : "protocol_fact",
    trigger_id: payloadDigest({
      record_type: record.record_type,
      source_instance_id: record.source_instance_id,
      source_pid: record.source_pid,
      source_seq: record.source_seq,
    }),
    trigger_digest: payloadDigest(record),
  };
}

/** One writer per actual fixed process instance, shared by every connection and direction.
 * Writes never block safety work. Normal close may wait only its explicit finite drain budget.
 */
export class ObservationWriter {
  readonly role: Role;
  readonly instance: string | null;
  readonly clock: MonotonicClock;
  readonly pid: number;
  readonly limits: Pick<P0SafetyLimits, "max_message_bytes" | "max_pending_requests">;
  #sink: ObservationSink;
  #streams = new Map<Stream, { next: number; dropped: number }>();
  #pending = new Map<symbol, { stream: Stream; end: boolean }>();
  #finishing: Promise<void> | undefined;
  #accepting = true;
  #broken = false;
  #failed = () => {
    this.#broken = true;
    for (const { stream, end } of this.#pending.values()) if (!end) this.#state(stream).dropped++;
    this.#pending.clear();
  };
  constructor(
    role: Role,
    instance: string | null,
    clock: MonotonicClock,
    limits: Pick<P0SafetyLimits, "max_message_bytes" | "max_pending_requests">,
    sink: ObservationSink = process.stderr,
    pid = process.pid,
  ) {
    this.role = role;
    this.instance = instance;
    this.clock = clock;
    this.limits = limits;
    this.#sink = sink;
    this.pid = pid;
    sink.on?.("error", this.#failed);
    sink.on?.("close", this.#failed);
  }
  #state(stream: Stream) {
    let state = this.#streams.get(stream);
    if (!state) {
      state = { next: 0, dropped: 0 };
      this.#streams.set(stream, state);
    }
    return state;
  }
  #send(stream: Stream, record: unknown, end = false): void {
    const state = this.#state(stream);
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
    // At most 4096 bytes for fixed observation/response metadata and exact authenticator redaction.
    // This is an output framing budget, not an enlargement of the accepted RPC frame limit.
    if (
      this.#broken ||
      bytes.length > this.limits.max_message_bytes + 4096 ||
      this.#pending.size >= this.limits.max_pending_requests
    ) {
      if (!end) state.dropped++;
      return;
    }
    const token = Symbol();
    this.#pending.set(token, { stream, end });
    const done = (error?: Error | null) => {
      if (!this.#pending.delete(token)) return;
      if (error) {
        this.#broken = true;
        if (!end) state.dropped++;
      }
    };
    try {
      this.#sink.write(bytes, done);
    } catch {
      done(new Error("OBSERVATION_WRITE_FAILED"));
    }
  }
  #base(stream: Stream) {
    const state = this.#state(stream);
    return {
      source_role: this.role,
      source_instance_id: this.instance,
      source_pid: this.pid,
      source_seq: state.next++,
      dropped_observations: state.dropped,
      observed_at: this.clock.point(),
    };
  }
  process(detail: P0ProcessObservation["detail"]): P0ProcessObservation | undefined {
    if (!this.#accepting) return;
    const record = { record_type: "p0-process-observation", ...this.#base("process"), detail };
    if (!validate("P0ProcessObservation", record)) {
      this.#state("process").dropped++;
      return;
    }
    this.#send("process", record);
    return record;
  }
  protocol(
    connectionId: string | null,
    detail: P0ProtocolObservation["detail"],
  ): P0ProtocolObservation | undefined {
    if (!this.#accepting || this.instance === null) return;
    const record = {
      record_type: "p0-protocol-observation",
      ...this.#base("protocol"),
      connection_id: connectionId,
      detail,
    };
    if (!validate("P0ProtocolObservation", record)) {
      this.#state("protocol").dropped++;
      return;
    }
    this.#send("protocol", record);
    return record;
  }
  endpoint(fact: P0EndpointSnapshot): void {
    if (!this.#accepting || this.role !== "endpoint" || this.instance !== fact.endpoint_instance_id)
      return;
    const state = this.#state("endpoint");
    const record = {
      observation_seq: state.next++,
      endpoint_fact: fact,
      dropped_observations: state.dropped,
    };
    if (!validate("P0EndpointObservation", record)) {
      state.dropped++;
      return;
    }
    this.#send("endpoint", record);
  }
  requestReceived(connectionId: string, request: RpcRequest): CommandTrigger | undefined {
    const record = this.protocol(connectionId, {
      kind: "request_received",
      request: observedRequest(request),
    });
    if (!record) return;
    return {
      trigger_kind: "command",
      receive_seq: record.source_seq,
      trigger_id: payloadDigest({
        connection_id: connectionId,
        receiver_instance_id: this.instance,
        request_id: request.id,
        receive_seq: record.source_seq,
      }),
      trigger_digest: authenticationDigest(
        request.method,
        request.params.context,
        request.params.input,
      ),
    };
  }
  finish(timeoutMs = 100): Promise<void> {
    if (this.#finishing) return this.#finishing;
    this.#accepting = false;
    this.#finishing = (async () => {
      const until = performance.now() + Math.max(0, Math.min(timeoutMs, 1000));
      const drain = async () => {
        while (this.#pending.size && performance.now() < until)
          await new Promise<void>((resolve) => setTimeout(resolve, 1));
        return this.#pending.size === 0;
      };
      // A pending/failed write may still change loss counts. Never manufacture a complete tail.
      if (!(await drain()) || this.#broken) return;
      for (const [stream, state] of this.#streams) {
        if (performance.now() >= until || this.#broken) return;
        const end = {
          record_type: "p0-observation-stream-end",
          stream,
          source_role: this.role,
          source_instance_id: this.instance,
          source_pid: this.pid,
          next_seq: state.next,
          dropped_observations: state.dropped,
          observed_at: this.clock.point(),
        };
        if (!validate("P0ObservationStreamEnd", end)) return;
        this.#send(stream, end, true);
        if (!(await drain())) return;
      }
    })().finally(() => {
      if (!this.#pending.size && !this.#broken) {
        this.#sink.off?.("error", this.#failed);
        this.#sink.off?.("close", this.#failed);
      }
    });
    return this.#finishing;
  }
}

export function observedRequest(request: RpcRequest): P0ObservedRpcRequest {
  const value = structuredClone(request) as unknown as {
    params: { input: { proof?: Record<string, unknown> } };
  };
  const proof = value.params.input.proof;
  if (proof) {
    const key = "proof_hmac" in proof ? "proof_hmac" : "signature";
    const authenticator = proof[key];
    if (typeof authenticator !== "string") throw new Error("INVALID_OBSERVED_AUTHENTICATOR");
    delete proof[key];
    proof.redaction = `${key}_removed`;
    proof.authenticator_sha256 = sha256(authenticator);
  }
  if (!validate("P0ObservedRpcRequest", value)) throw new Error("INVALID_OBSERVED_REQUEST");
  return value;
}

/** Bootstrap owns its eventual fixed writer. A null writer exists only on failure and then ends. */
export class StartupObservation {
  stage: StartupStage = "runtime";
  readonly role: Role;
  readonly clock = new MonotonicClock();
  writer: ObservationWriter | undefined;
  constructor(role: Role) {
    this.role = role;
  }
  bind(instance: string, limits: P0SafetyLimits): ObservationWriter {
    if (this.writer) throw new Error("OBSERVATION_INSTANCE_ALREADY_BOUND");
    this.writer = new ObservationWriter(this.role, instance, this.clock, limits);
    return this.writer;
  }
  async failed(error: unknown): Promise<void> {
    const writer =
      this.writer ??
      new ObservationWriter(this.role, null, this.clock, {
        max_message_bytes: 65536,
        max_pending_requests: 4,
      });
    writer.process({ kind: "startup_rejected", stage: this.stage, error: observationError(error) });
    await writer.finish();
  }
}

/** Per-connection correlation only; all sequences belong to the shared process writer. */
export class ProtocolObservation {
  readonly writer: ObservationWriter;
  connectionId: string | null;
  #sent = new Map<string, RpcRequest>();
  #received = new Map<string, RpcRequest>();
  #triggers = new WeakMap<RpcRequest, CommandTrigger>();
  constructor(writer: ObservationWriter, connectionId: string | null = null) {
    this.writer = writer;
    this.connectionId = connectionId;
  }
  failure(
    stage: Extract<P0ProtocolObservation["detail"], { kind: "local_failure" }>["stage"],
    error: P0ObservationError,
    request?: RpcRequest,
    frame?: FrameEvidence,
  ): P0ProtocolObservation | undefined {
    return this.writer.protocol(this.connectionId, {
      kind: "local_failure",
      stage,
      request_id: request?.id ?? null,
      operation_id: request?.params.context.operation_id ?? null,
      request_digest: request
        ? authenticationDigest(request.method, request.params.context, request.params.input)
        : null,
      error,
      frame_sha256: frame?.frame_sha256 ?? null,
      frame_bytes: frame?.frame_bytes ?? null,
    });
  }
  triggerFor(request: RpcRequest): CommandTrigger | undefined {
    return this.#triggers.get(request);
  }
  attach(channel: JsonChannel, peer?: P0PeerIdentity, authority?: P0PeerIdentity): void {
    // Observation callbacks may never throw into transport/business dispatch.
    const observe = (direction: "queued" | "received", raw: unknown, frame?: FrameEvidence) => {
      try {
        if (validate("RpcRequest", raw)) {
          if (
            direction === "received" &&
            this.#received.size < this.writer.limits.max_pending_requests
          )
            this.#received.set(raw.id, raw);
          if (!this.connectionId) {
            this.failure(
              "request_schema",
              { kind: "internal", code: "unexpected_error" },
              undefined,
              frame,
            );
            return;
          }
          if (direction === "received") {
            const trigger = this.writer.requestReceived(this.connectionId, raw);
            if (trigger) this.#triggers.set(raw, trigger);
          } else
            this.writer.protocol(this.connectionId, {
              kind: "request_queued",
              request: observedRequest(raw),
            });
          return;
        }
        if (validate("RpcEvent", raw)) {
          if (direction === "received" && raw.params.event_name === "connection.announced") {
            if (peer && authority && validate("P0ConnectionAnnouncement", raw.params.payload)) {
              this.connectionId = raw.params.payload.connection_id;
              this.writer.protocol(this.connectionId, {
                kind: "announcement_received",
                announcement: raw.params,
                fixed_peer: peer,
                fixed_authority: authority,
              });
            } else
              this.failure(
                "announcement",
                { kind: "internal", code: "invalid_response" },
                undefined,
                frame,
              );
          } else if (this.connectionId)
            this.writer.protocol(this.connectionId, {
              kind: direction === "queued" ? "event_queued" : "event_received",
              event: raw,
            });
          return;
        }
        if (raw && typeof raw === "object" && "id" in raw && ("result" in raw || "error" in raw)) {
          const records = direction === "received" ? this.#sent : this.#received;
          const request = typeof raw.id === "string" ? records.get(raw.id) : undefined;
          const rpc = { method: request?.method ?? null, response: raw };
          if (typeof raw.id === "string") records.delete(raw.id);
          if (this.connectionId && validate("P0ObservedRpcResponse", rpc))
            this.writer.protocol(this.connectionId, {
              kind: direction === "queued" ? "response_queued" : "response_received",
              rpc,
            });
          else
            this.failure(
              "response_schema",
              { kind: "internal", code: "invalid_response" },
              request,
              frame,
            );
          return;
        }
        this.failure("request_schema", requestSchemaError(raw), undefined, frame);
      } catch {
        this.failure("dispatch", { kind: "internal", code: "unexpected_error" });
      }
    };
    channel.on("enqueue", (raw: unknown) => {
      if (validate("RpcRequest", raw) && this.#sent.size < this.writer.limits.max_pending_requests)
        this.#sent.set(raw.id, raw);
    });
    channel.on("queued", (raw: unknown) => observe("queued", raw));
    channel.on("message", (raw: unknown, frame: FrameEvidence) => observe("received", raw, frame));
    channel.on("invalid", (_reason: string, frame?: FrameEvidence) =>
      this.failure("parse", { kind: "internal", code: "invalid_frame" }, undefined, frame),
    );
    channel.on("dispatchError", (error: unknown) =>
      this.failure("dispatch", observationError(error)),
    );
    channel.on("transportError", (stage: "read" | "write" | "encode", error: unknown) =>
      this.failure(stage, observationError(error)),
    );
    channel.on("closed", () => {
      this.failure("close", { kind: "internal", code: "connection_closed" });
      this.#sent.clear();
      this.#received.clear();
    });
  }
}
