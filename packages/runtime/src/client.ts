import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { dirname } from "node:path";
import {
  assertValid,
  type CommandContext,
  type P0ClockMapping,
  type P0ConnectionAnnouncement,
  type P0EndpointSnapshot,
  type P0OperatorCredential,
  type P0PeerIdentity,
  type P0SafetyLimits,
  payloadDigest,
  type RpcFailure,
  type RpcRequest,
  type RpcSuccess,
  validate,
  validateRpcResponse,
} from "../../contract-sdk/src/index.ts";
import { clockMapping, MonotonicClock, mappedDeadline } from "./clock.ts";
import { RuntimeRejection, reject } from "./errors.ts";
import { controlledPath, readServiceIdentity } from "./files.ts";
import {
  completeRequest,
  type Identity,
  operatorRequest,
  peerRequest,
  verifyAnnouncement,
} from "./identity.ts";
import { type ObservationWriter, observationError, ProtocolObservation } from "./observation.ts";
import { JsonChannel } from "./transport.ts";

export class RpcConnection {
  readonly channel: JsonChannel;
  readonly clock: MonotonicClock;
  readonly instanceId: string;
  readonly limits: P0SafetyLimits;
  readonly observation: ProtocolObservation | undefined;
  #announcement: P0ConnectionAnnouncement | undefined;
  get announcement(): P0ConnectionAnnouncement {
    if (!this.#announcement) throw new Error("RPC_NOT_ANNOUNCED");
    return this.#announcement;
  }
  mapping!: P0ClockMapping;
  #pending = new Map<
    string,
    {
      method: string;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  #firstResolve: ((value: unknown) => void) | undefined;
  #firstReject: ((error: Error) => void) | undefined;
  #announced = false;
  #eventHandler: ((fact: P0EndpointSnapshot) => void) | undefined;
  #eventEpoch: (() => number) | undefined;
  #eventSequence = -1;
  #eventDigests = new Map<number, string>();
  #revisionDigests = new Map<number, string>();
  onEndpointFact(handler: (fact: P0EndpointSnapshot) => void, currentEpoch: () => number): void {
    if (this.announcement.service_role !== "endpoint") reject("ROLE_SCOPE_DENIED");
    this.#eventHandler = handler;
    this.#eventEpoch = currentEpoch;
  }
  #lastResponse: RpcSuccess | RpcFailure | undefined;
  get lastResponse(): RpcSuccess | RpcFailure | undefined {
    return this.#lastResponse ? structuredClone(this.#lastResponse) : undefined;
  }

  private constructor(
    channel: JsonChannel,
    clock: MonotonicClock,
    instance: string,
    limits: P0SafetyLimits,
    observation?: ObservationWriter,
    peer?: P0PeerIdentity,
    authority?: P0PeerIdentity,
  ) {
    this.channel = channel;
    this.clock = clock;
    this.instanceId = instance;
    this.limits = limits;
    this.observation = observation ? new ProtocolObservation(observation) : undefined;
    this.observation?.attach(channel, peer, authority);
    channel.on("message", (raw: unknown) => {
      if (!this.#announced) {
        this.#announced = true;
        this.#firstResolve?.(raw);
        return;
      }
      if (!raw || typeof raw !== "object" || !("id" in raw) || typeof raw.id !== "string") {
        if (this.#eventHandler && validate("RpcEvent", raw)) {
          const event = raw.params;
          if (
            ["simulation.progressed", "simulation.stopped"].includes(event.event_name) &&
            event.authority_id === "endpoint" &&
            event.source_instance === this.announcement.service_instance_id &&
            event.session_id === this.announcement.session_id &&
            event.scope_ref.kind === "Session" &&
            event.scope_ref.id === this.announcement.session_id &&
            event.authority_epoch === this.#eventEpoch?.() &&
            event.source_seq !== null &&
            validate("P0EndpointSnapshot", event.payload) &&
            event.payload.endpoint_instance_id === this.announcement.service_instance_id &&
            event.payload.session_id === this.announcement.session_id &&
            event.payload.supervisor_instance_id === this.announcement.authority_instance_id &&
            event.payload.observed_at.clock_domain === this.mapping.target_clock_domain
          ) {
            const eventDigest = payloadDigest(event);
            const revisionDigest = payloadDigest(event.payload);
            const seenEvent = this.#eventDigests.get(event.source_seq);
            const seenRevision = this.#revisionDigests.get(event.payload.source_revision);
            if (
              (seenEvent && seenEvent !== eventDigest) ||
              (seenRevision && seenRevision !== revisionDigest) ||
              (!seenEvent && this.#eventDigests.size >= 1024) ||
              (!seenRevision && this.#revisionDigests.size >= 1024)
            ) {
              this.observation?.failure("dispatch", { kind: "internal", code: "invalid_response" });
              channel.close();
              return;
            }
            this.#eventDigests.set(event.source_seq, eventDigest);
            this.#revisionDigests.set(event.payload.source_revision, revisionDigest);
            if (event.source_seq > this.#eventSequence) {
              this.#eventSequence = event.source_seq;
              this.#eventHandler(structuredClone(event.payload));
            }
            return;
          }
        }
        this.observation?.failure("dispatch", { kind: "internal", code: "invalid_response" });
        channel.close();
        return;
      }
      const pending = this.#pending.get(raw.id);
      if (!pending) {
        this.observation?.failure("dispatch", { kind: "internal", code: "invalid_response" });
        channel.close();
        return;
      }
      try {
        validateRpcResponse(pending.method, raw);
        this.#lastResponse = raw as RpcSuccess | RpcFailure;
        if ("error" in raw) {
          assertValid("RpcFailure", raw);
          throw raw.error.data
            ? new RuntimeRejection(raw.error.data.reason_code)
            : new Error(`RPC_PROTOCOL_${raw.error.code}`);
        }
        pending.resolve((raw as RpcSuccess).result);
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error("RPC_INVALID_RESPONSE"));
      } finally {
        clearTimeout(pending.timer);
        this.#pending.delete(raw.id);
      }
    });
    channel.on("invalid", () => channel.close());
    channel.on("closed", () => {
      this.#firstReject?.(new Error("RPC_CLOSED"));
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("RPC_CLOSED"));
      }
      this.#pending.clear();
    });
  }

  static async connect(
    socketPath: string,
    identity: P0PeerIdentity,
    limits: P0SafetyLimits,
    instance: string = randomUUID(),
    clock = new MonotonicClock(),
    authority: P0PeerIdentity = identity,
    signal?: AbortSignal,
    observation?: ObservationWriter,
  ): Promise<RpcConnection> {
    signal?.throwIfAborted();
    try {
      await controlledPath(socketPath, dirname(socketPath), true, true);
    } catch (error) {
      if (observation)
        new ProtocolObservation(observation).failure("connect", observationError(error));
      throw error;
    }
    signal?.throwIfAborted();
    const sent = clock.now();
    const socket = createConnection(socketPath);
    const channel = new JsonChannel(
      socket,
      socket,
      limits.max_message_bytes,
      limits.max_pending_requests,
    );
    const abort = () => channel.close();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      return await RpcConnection.fromChannel(
        channel,
        identity,
        limits,
        instance,
        clock,
        sent,
        authority,
        observation,
      );
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  static async fromChannel(
    channel: JsonChannel,
    identity: P0PeerIdentity,
    limits: P0SafetyLimits,
    instance: string,
    clock: MonotonicClock,
    sent: number,
    authority: P0PeerIdentity = identity,
    observation?: ObservationWriter,
  ): Promise<RpcConnection> {
    const connection = new RpcConnection(
      channel,
      clock,
      instance,
      limits,
      observation,
      identity,
      authority,
    );
    let stage: "announcement" | "clock" = "announcement";
    const timer = setTimeout(() => channel.close(), limits.peer_health_timeout_ms);
    try {
      const raw = await new Promise<unknown>((resolve, reject) => {
        connection.#firstResolve = resolve;
        connection.#firstReject = reject;
      });
      const received = clock.now();
      connection.#announcement = Object.freeze(verifyAnnouncement(raw, identity, authority));
      stage = "clock";
      connection.mapping = clockMapping(
        connection.announcement,
        clock,
        instance,
        sent,
        received,
        limits,
      );
      return connection;
    } catch (error) {
      connection.observation?.failure(stage, observationError(error));
      channel.close();
      throw error;
    } finally {
      clearTimeout(timer);
      connection.#firstResolve = undefined;
      connection.#firstReject = undefined;
    }
  }

  context(operationId: string = randomUUID(), grant: string | null = null): CommandContext {
    return {
      operation_id: operationId,
      payload_digest: "0".repeat(64),
      caller_instance_id: this.instanceId,
      authority_epoch: this.announcement.authority_epoch,
      object_ref: { kind: "Session", id: this.announcement.session_id },
      deadline: mappedDeadline(this.mapping, this.clock.now(), this.limits.peer_health_timeout_ms),
      grant_ref: grant,
    };
  }

  request(request: RpcRequest): Promise<unknown> {
    assertValid("RpcRequest", request);
    if (this.#pending.size >= this.limits.max_pending_requests) reject("QUEUE_LIMIT_EXCEEDED");
    if (this.#pending.has(request.id)) reject("OPERATION_PAYLOAD_CONFLICT");
    return new Promise<unknown>((resolve, reject) => {
      const remaining = Math.min(
        this.limits.peer_health_timeout_ms,
        request.params.context.deadline.expires_at_ms -
          (this.clock.now() + this.mapping.offset_upper_ms),
      );
      if (remaining <= 0) {
        reject(new RuntimeRejection("COMMAND_DEADLINE_MISSED"));
        return;
      }
      const timer = setTimeout(() => {
        this.observation?.failure("read", { kind: "internal", code: "request_timeout" }, request);
        this.#pending.delete(request.id);
        reject(new RuntimeRejection("COMMAND_DEADLINE_MISSED"));
        this.channel.close();
      }, remaining);
      this.#pending.set(request.id, { method: request.method, resolve, reject, timer });
      if (!this.channel.send(request)) {
        clearTimeout(timer);
        this.#pending.delete(request.id);
        reject(new Error("RPC_CLOSED"));
      }
    });
  }

  async authenticatePeer(identity: Identity): Promise<void> {
    if (identity.public.instance_id !== this.instanceId) reject("AUTHENTICATION_REQUIRED");
    await this.request(
      peerRequest({ mapping: this.mapping }, this.context(), this.announcement, identity),
    );
  }
  peerCall(method: string, input: object, operation: string = randomUUID()): Promise<unknown> {
    const legacy = [
      "plugin.handshake",
      "plugin.describe",
      "controller.observe_status",
      "controller.stop",
      "controller.dispose",
    ].includes(method);
    return this.request(
      completeRequest(
        method,
        legacy ? input : { ...input, mapping: this.mapping },
        this.context(operation),
      ),
    );
  }
  operatorCall(
    method: string,
    input: object,
    credential: P0OperatorCredential,
    operation: string = randomUUID(),
  ): Promise<unknown> {
    return this.request(
      operatorRequest(
        method,
        { ...input, mapping: this.mapping },
        this.context(operation),
        this.announcement,
        credential,
      ),
    );
  }
  close(): void {
    this.channel.close();
  }
}

export async function connectOperator(
  socketPath: string,
  limits: P0SafetyLimits,
): Promise<RpcConnection> {
  const identity = await readServiceIdentity(socketPath);
  return RpcConnection.connect(socketPath, identity, limits);
}
