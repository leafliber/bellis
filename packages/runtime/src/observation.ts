import { createHash } from "node:crypto";
import { write as writeFd } from "node:fs";
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
  readonly inFlight?: boolean;
  readonly backpressureObserved?: boolean;
  abort?: () => void;
};
export type ObservationFinish = {
  complete: boolean;
  pending_records: number;
  os_write_in_flight: boolean;
  os_backpressure_observed: boolean;
};
export type AsyncWrite = (
  fd: number,
  bytes: Buffer,
  offset: number,
  length: number,
  position: null,
  callback: (error: NodeJS.ErrnoException | null, written: number) => void,
) => unknown;

/** Public asynchronous fs.write only. One FIFO record and one OS write in flight.
 * The fd is inherited, never closed here. A timed-out OS request may outlive this sink.
 */
export class AsyncFdSink implements ObservationSink {
  readonly fd: number;
  readonly maxPending: number;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly writeFn: AsyncWrite;
  #queue: Array<{
    bytes: Buffer;
    offset: number;
    until: number;
    done: (error?: Error | null) => void;
  }> = [];
  #bytes = 0;
  #inFlight = false;
  #backpressure = false;
  #broken: Error | undefined;
  #deadline: ReturnType<typeof setTimeout> | undefined;
  #retry: ReturnType<typeof setTimeout> | undefined;
  constructor(
    fd: number,
    maxPending: number,
    maxBytes: number,
    timeoutMs = 1000,
    writeFn: AsyncWrite = writeFd,
  ) {
    this.fd = fd;
    this.maxPending = maxPending;
    this.maxBytes = maxBytes;
    this.timeoutMs = timeoutMs;
    this.writeFn = writeFn;
  }
  get inFlight(): boolean {
    return this.#inFlight;
  }
  get backpressureObserved(): boolean {
    return this.#backpressure;
  }
  abort(): void {
    this.#fail(Object.assign(new Error("ASYNC_FD_TIMEOUT"), { code: "ETIMEDOUT" }));
  }
  write(bytes: Buffer, done: (error?: Error | null) => void): boolean {
    if (this.#broken) {
      done(this.#broken);
      return false;
    }
    if (
      bytes.length > this.maxBytes ||
      this.#queue.length >= this.maxPending ||
      this.#bytes + bytes.length > this.maxPending * this.maxBytes
    ) {
      done(new Error("ASYNC_FD_CAPACITY"));
      return false;
    }
    this.#queue.push({ bytes, offset: 0, until: performance.now() + this.timeoutMs, done });
    this.#bytes += bytes.length;
    if (this.#queue.length === 1) this.#start();
    return true;
  }
  #fail(error: Error): void {
    if (this.#broken) return;
    this.#broken = error;
    clearTimeout(this.#deadline);
    clearTimeout(this.#retry);
    const pending = this.#queue.splice(0);
    this.#bytes = 0;
    for (const record of pending) record.done(error);
  }
  #start(): void {
    const record = this.#queue[0];
    if (!record || this.#broken) return;
    const remaining = record.until - performance.now();
    if (remaining <= 0) {
      this.abort();
      return;
    }
    this.#deadline = setTimeout(() => this.abort(), remaining);
    this.#part();
  }
  #part(): void {
    const record = this.#queue[0];
    if (!record || this.#broken) return;
    if (performance.now() >= record.until) {
      this.abort();
      return;
    }
    this.#inFlight = true;
    try {
      this.writeFn(
        this.fd,
        record.bytes,
        record.offset,
        record.bytes.length - record.offset,
        null,
        (error, written) => {
          this.#inFlight = false;
          if (this.#broken || this.#queue[0] !== record) return;
          if (performance.now() >= record.until) {
            this.abort();
            return;
          }
          if (error && error.code !== "EAGAIN" && error.code !== "EINTR") {
            this.#fail(error);
            return;
          }
          if (error?.code === "EAGAIN" || (!error && written === 0)) this.#backpressure = true;
          if (!error) {
            if (
              !Number.isSafeInteger(written) ||
              written < 0 ||
              written > record.bytes.length - record.offset
            ) {
              this.#fail(new Error("ASYNC_FD_INVALID_PROGRESS"));
              return;
            }
            record.offset += written;
            if (record.offset === record.bytes.length) {
              clearTimeout(this.#deadline);
              this.#queue.shift();
              this.#bytes -= record.bytes.length;
              record.done();
              this.#start();
              return;
            }
          }
          // Retry does not replace the original absolute deadline, including zero progress.
          this.#retry = setTimeout(() => this.#part(), 1);
        },
      );
    } catch (error) {
      this.#inFlight = false;
      this.#fail(error instanceof Error ? error : new Error("ASYNC_FD_WRITE_FAILED"));
    }
  }
}

/** CLI's one bounded stdout result. The entrypoint must exit after this finite attempt. */
export async function writeCliResult(
  bytes: Buffer,
  timeoutMs = 100,
): Promise<{ complete: boolean; writer: AsyncFdSink }> {
  const sink = new AsyncFdSink(1, 1, 16 * 1024 * 1024 + 4096, timeoutMs);
  const complete = await new Promise<boolean>((resolve) =>
    sink.write(bytes, (error) => resolve(!error)),
  );
  return { complete, writer: sink };
}
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
 * Default OS writes are asynchronous; JSON validation/encoding still costs bounded CPU.
 * Normal close may wait only its explicit finite drain budget.
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
  #finishing: Promise<ObservationFinish> | undefined;
  #accepting = true;
  #broken = false;
  #failed = () => {
    this.#broken = true;
    for (const { stream, end } of this.#pending.values()) if (!end) this.#state(stream).dropped++;
    this.#pending.clear();
  };
  get osWriteInFlight(): boolean {
    return this.#sink.inFlight ?? false;
  }
  constructor(
    role: Role,
    instance: string | null,
    clock: MonotonicClock,
    limits: Pick<P0SafetyLimits, "max_message_bytes" | "max_pending_requests">,
    sink?: ObservationSink,
    pid = process.pid,
  ) {
    this.role = role;
    this.instance = instance;
    this.clock = clock;
    this.limits = limits;
    this.#sink =
      sink ?? new AsyncFdSink(2, limits.max_pending_requests, limits.max_message_bytes + 4096);
    this.pid = pid;
    this.#sink.on?.("error", this.#failed);
    this.#sink.on?.("close", this.#failed);
  }
  #state(stream: Stream) {
    let state = this.#streams.get(stream);
    if (!state) {
      state = { next: 0, dropped: 0 };
      this.#streams.set(stream, state);
    }
    return state;
  }
  #send(stream: Stream, record: unknown, end = false): boolean {
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
      return false;
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
    return !this.#broken;
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
  finish(timeoutMs = 100): Promise<ObservationFinish> {
    if (this.#finishing) return this.#finishing;
    this.#accepting = false;
    this.#finishing = (async () => {
      const result = (complete: boolean): ObservationFinish => ({
        complete:
          complete &&
          !this.#broken &&
          [...this.#streams.values()].every((state) => state.dropped === 0),
        pending_records: this.#pending.size,
        os_write_in_flight: this.#sink.inFlight ?? false,
        os_backpressure_observed: this.#sink.backpressureObserved ?? false,
      });
      const until = performance.now() + Math.max(0, Math.min(timeoutMs, 1000));
      const drain = async () => {
        while (this.#pending.size && performance.now() < until)
          await new Promise<void>((resolve) => setTimeout(resolve, 1));
        return this.#pending.size === 0;
      };
      // A pending/failed write may still change loss counts. Never manufacture a complete tail.
      if (!(await drain()) || this.#broken) {
        this.#sink.abort?.();
        return result(false);
      }
      for (const [stream, state] of this.#streams) {
        if (performance.now() >= until || this.#broken) {
          this.#sink.abort?.();
          return result(false);
        }
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
        if (!validate("P0ObservationStreamEnd", end) || !this.#send(stream, end, true))
          return result(false);
        if (!(await drain())) {
          this.#sink.abort?.();
          return result(false);
        }
      }
      return result(true);
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
    this.writer ??= new ObservationWriter(this.role, null, this.clock, {
      max_message_bytes: 65536,
      max_pending_requests: 4,
    });
    this.writer.process({
      kind: "startup_rejected",
      stage: this.stage,
      error: observationError(error),
    });
    await this.writer.finish();
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
