import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { dirname } from "node:path";
import {
  assertValid,
  type ClockPoint,
  type CommandContext,
  type Deadline,
  type P0ClockMapping,
  type P0ConnectionAnnouncement,
  type P0EndpointSnapshot,
  type P0OperatorCredential,
  type P0PeerIdentity,
  type P0SafetyLimits,
  payloadDigest,
  type RpcEvent,
  type RpcFailure,
  type RpcRequest,
  type RpcSuccess,
  validate,
  validateRpcResponse,
} from "../../contract-sdk/src/index.ts";
import { clockMapping, MonotonicClock, mappedDeadline, validateMapping } from "./clock.ts";
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

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export type RpcExchange = Readonly<{
  request: RpcRequest;
  response: RpcSuccess | RpcFailure;
  announcement: RpcEvent;
  mapping: P0ClockMapping;
  received_at: ClockPoint;
}>;
/** The actual response exists, but it is not a timely business result. */
export class LateRpcResponse extends RuntimeRejection {
  readonly exchange: RpcExchange;
  constructor(exchange: RpcExchange) {
    super("COMMAND_DEADLINE_MISSED");
    this.exchange = exchange;
  }
}
export type EndpointEventDelivery = Readonly<{
  event: RpcEvent;
  announcement: RpcEvent;
  mapping: P0ClockMapping;
  received_at: ClockPoint;
}>;
export type OperatorMethod =
  | "operator.authenticate"
  | "session.query"
  | "host.query"
  | "session.authorize"
  | "session.renew"
  | "session.revoke"
  | "session.stop"
  | "session.execute"
  | "fault.configure";
export type OperatorInput<M extends OperatorMethod> = Omit<
  Extract<RpcRequest, { method: M }>["params"]["input"],
  "proof" | "mapping"
>;
export type PreparedOperator = Readonly<{
  request: RpcRequest;
  service: P0PeerIdentity;
  authority: P0PeerIdentity;
}>;
const preparedOperators = new WeakMap<
  PreparedOperator,
  {
    clock: MonotonicClock;
    origin: bigint;
    domain: string;
    caller: string;
    credential: string;
  }
>();
export type OperatorOptions = { operation?: string; grant?: string | null; timeoutMs?: number };
function resultOf(exchange: RpcExchange): unknown {
  const response = exchange.response;
  if ("error" in response)
    throw response.error.data
      ? new RuntimeRejection(response.error.data.reason_code)
      : new Error(`RPC_PROTOCOL_${response.error.code}`);
  return structuredClone(response.result);
}
function credentialBinding(credential: P0OperatorCredential): string {
  return payloadDigest({
    credential_id: credential.credential_id,
    operator_id: credential.operator_id,
    role: credential.role,
  });
}

export class RpcConnection {
  readonly channel: JsonChannel;
  readonly clock: MonotonicClock;
  readonly instanceId: string;
  readonly limits: P0SafetyLimits;
  readonly observation: ProtocolObservation | undefined;
  #announcement: P0ConnectionAnnouncement | undefined;
  #announcementEvent: RpcEvent | undefined;
  readonly #peer: P0PeerIdentity;
  readonly #authority: P0PeerIdentity;
  get announcementEvent(): Readonly<RpcEvent> {
    if (!this.#announcementEvent) throw new Error("RPC_NOT_ANNOUNCED");
    return this.#announcementEvent;
  }
  get announcement(): P0ConnectionAnnouncement {
    if (!this.#announcement) throw new Error("RPC_NOT_ANNOUNCED");
    return this.#announcement;
  }
  #mapping: P0ClockMapping | undefined;
  get mapping(): P0ClockMapping {
    if (!this.#mapping) throw new Error("RPC_NOT_ANNOUNCED");
    return this.#mapping;
  }
  #pending = new Map<
    string,
    {
      request: RpcRequest;
      waitUntil: number;
      resolve: (value: RpcExchange) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  #firstResolve: ((value: unknown) => void) | undefined;
  #firstReject: ((error: Error) => void) | undefined;
  #announced = false;
  #eventHandler: ((fact: P0EndpointSnapshot) => void) | undefined;
  #eventEpoch: (() => number) | undefined;
  #eventArchive: ((delivery: EndpointEventDelivery) => void) | undefined;
  #futureEvent: ((delivery: EndpointEventDelivery) => void) | undefined;
  #eventSequence = -1;
  #projectedRevision = -1;
  #eventIds = new Map<string, string>();
  #eventDigests = new Map<number, string>();
  #revisionDigests = new Map<number, string>();
  onEndpointFact(
    handler: (fact: P0EndpointSnapshot) => void,
    currentEpoch: () => number,
    futureEvent?: (delivery: EndpointEventDelivery) => void,
  ): void {
    if (this.announcement.service_role !== "endpoint") reject("ROLE_SCOPE_DENIED");
    this.#eventHandler = handler;
    this.#eventEpoch = currentEpoch;
    this.#futureEvent = futureEvent;
  }
  onEndpointEvent(handler: (delivery: EndpointEventDelivery) => void): void {
    if (this.announcement.service_role !== "endpoint") reject("ROLE_SCOPE_DENIED");
    this.#eventArchive = handler;
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
    if (!peer || !authority) throw new Error("RPC_IDENTITY_REQUIRED");
    this.#peer = Object.freeze(structuredClone(peer));
    this.#authority = Object.freeze(structuredClone(authority));
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
            event.source_seq !== null &&
            validate("P0EndpointSnapshot", event.payload) &&
            event.payload.endpoint_instance_id === this.announcement.service_instance_id &&
            event.payload.session_id === this.announcement.session_id &&
            event.payload.supervisor_instance_id === this.announcement.authority_instance_id &&
            event.payload.observed_at.clock_domain === this.mapping.target_clock_domain &&
            event.occurred_at?.clock_domain === this.mapping.target_clock_domain &&
            payloadDigest(event.occurred_at) === payloadDigest(event.payload.observed_at) &&
            event.payload.observed_at.monotonic_ms <=
              this.clock.now() + this.mapping.offset_upper_ms
          ) {
            const eventDigest = payloadDigest(event);
            const revisionDigest = payloadDigest(event.payload);
            const seenId = this.#eventIds.get(event.event_id);
            const seenEvent = this.#eventDigests.get(event.source_seq);
            const seenRevision = this.#revisionDigests.get(event.payload.source_revision);
            if (
              (seenId && seenId !== eventDigest) ||
              (seenEvent && seenEvent !== eventDigest) ||
              (seenRevision && seenRevision !== revisionDigest) ||
              (!seenId && this.#eventIds.size >= 1024) ||
              (!seenEvent && this.#eventDigests.size >= 1024) ||
              (!seenRevision && this.#revisionDigests.size >= 1024)
            ) {
              this.observation?.failure("dispatch", { kind: "internal", code: "invalid_response" });
              channel.close();
              return;
            }
            const delivery = freeze(
              structuredClone({
                event: raw,
                announcement: this.announcementEvent,
                mapping: this.mapping,
                received_at: this.clock.point(),
              }),
            );
            const currentEpoch = this.#eventEpoch?.();
            if (
              !Number.isSafeInteger(currentEpoch) ||
              currentEpoch === undefined ||
              currentEpoch < 0
            ) {
              this.observation?.failure("dispatch", { kind: "internal", code: "invalid_response" });
              channel.close();
              return;
            }
            this.#eventIds.set(event.event_id, eventDigest);
            this.#eventDigests.set(event.source_seq, eventDigest);
            this.#revisionDigests.set(event.payload.source_revision, revisionDigest);
            // Archive actual, validated envelopes independently of the current projection.
            this.#eventArchive?.(delivery);
            const fresh =
              delivery.received_at.monotonic_ms < this.mapping.source_valid_until_ms &&
              delivery.received_at.monotonic_ms + this.mapping.offset_upper_ms <
                this.mapping.target_valid_until_ms;
            if (fresh && event.authority_epoch > currentEpoch) {
              if (this.#futureEvent) this.#futureEvent(delivery);
              else {
                this.observation?.failure("dispatch", {
                  kind: "internal",
                  code: "invalid_response",
                });
                channel.close();
              }
            } else if (
              fresh &&
              !seenId &&
              event.authority_epoch === currentEpoch &&
              event.source_seq > this.#eventSequence &&
              event.payload.source_revision > this.#projectedRevision
            ) {
              this.#eventHandler(structuredClone(event.payload));
              this.#projectedRevision = event.payload.source_revision;
            }
            this.#eventSequence = Math.max(this.#eventSequence, event.source_seq);
            return;
          }
        }
        this.observation?.failure("dispatch", { kind: "internal", code: "invalid_response" });
        channel.close();
        return;
      }
      const receivedAt = this.clock.point();
      const pending = this.#pending.get(raw.id);
      if (!pending) {
        this.observation?.failure("dispatch", { kind: "internal", code: "invalid_response" });
        channel.close();
        return;
      }
      try {
        validateRpcResponse(pending.request.method, raw);
        const response = raw as RpcSuccess | RpcFailure;
        this.#lastResponse = structuredClone(response);
        const exchange = freeze(
          structuredClone({
            request: pending.request,
            response,
            announcement: this.announcementEvent,
            mapping: this.mapping,
            received_at: receivedAt,
          }),
        );
        if (
          receivedAt.monotonic_ms >= pending.waitUntil ||
          receivedAt.monotonic_ms + this.mapping.offset_upper_ms >=
            pending.request.params.context.deadline.expires_at_ms
        ) {
          this.observation?.failure(
            "read",
            { kind: "internal", code: "request_timeout" },
            pending.request,
          );
          throw new LateRpcResponse(exchange);
        }
        pending.resolve(exchange);
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
      const announcement = verifyAnnouncement(raw, identity, authority);
      assertValid("RpcEvent", raw);
      connection.#announcementEvent = freeze(structuredClone(raw)) as RpcEvent;
      connection.#announcement = freeze(structuredClone(announcement));
      stage = "clock";
      connection.#mapping = freeze(
        clockMapping(connection.announcement, clock, instance, sent, received, limits),
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

  context(
    operationId: string = randomUUID(),
    grant: string | null = null,
    authorityEpoch = this.announcement.authority_epoch,
    timeoutMs = this.limits.peer_health_timeout_ms,
  ): CommandContext {
    if (!Number.isSafeInteger(authorityEpoch) || authorityEpoch < 0)
      reject("SCOPED_EPOCH_CONFLICT");
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > this.limits.peer_health_timeout_ms
    )
      reject("TIMEOUT_INVALID");
    return {
      operation_id: operationId,
      payload_digest: "0".repeat(64),
      caller_instance_id: this.instanceId,
      authority_epoch: authorityEpoch,
      object_ref: { kind: "Session", id: this.announcement.session_id },
      deadline: mappedDeadline(this.mapping, this.clock.now(), timeoutMs),
      grant_ref: grant,
    };
  }

  request(request: RpcRequest): Promise<unknown> {
    return this.requestExchange(request).then(resultOf);
  }
  requestExchange(request: RpcRequest): Promise<RpcExchange> {
    assertValid("RpcRequest", request);
    request = freeze(structuredClone(request)) as RpcRequest;
    if (this.#pending.size >= this.limits.max_pending_requests) reject("QUEUE_LIMIT_EXCEEDED");
    if (this.#pending.has(request.id)) reject("OPERATION_PAYLOAD_CONFLICT");
    return new Promise<RpcExchange>((resolve, reject) => {
      const now = this.clock.now();
      const remaining = Math.min(
        this.limits.peer_health_timeout_ms,
        this.mapping.source_valid_until_ms - now,
        request.params.context.deadline.expires_at_ms - (now + this.mapping.offset_upper_ms),
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
      this.#pending.set(request.id, {
        request,
        waitUntil: now + remaining,
        resolve,
        reject,
        timer,
      });
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
  peerCall(
    method: string,
    input: object,
    operation: string = randomUUID(),
    authorityEpoch = this.announcement.authority_epoch,
  ): Promise<unknown> {
    return this.peerExchange(method, input, operation, authorityEpoch).then(resultOf);
  }
  peerExchange(
    method: string,
    input: object,
    operation: string = randomUUID(),
    authorityEpoch = this.announcement.authority_epoch,
  ): Promise<RpcExchange> {
    if (method === "connection.authenticate") reject("ROLE_SCOPE_DENIED");
    const legacy = [
      "plugin.handshake",
      "plugin.describe",
      "controller.observe_status",
      "controller.stop",
      "controller.dispose",
    ].includes(method);
    return this.requestExchange(
      completeRequest(
        method,
        legacy ? input : { ...input, mapping: this.mapping },
        this.context(operation, null, authorityEpoch),
      ),
    );
  }
  operatorCall(
    method: string,
    input: object,
    credential: P0OperatorCredential,
    operation: string = randomUUID(),
  ): Promise<unknown> {
    return this.sendPrepared(
      this.prepareOperator(
        method as OperatorMethod,
        input as OperatorInput<OperatorMethod>,
        credential,
        { operation },
      ),
      credential,
    ).then(resultOf);
  }
  prepareOperator<M extends OperatorMethod>(
    method: M,
    input: OperatorInput<M>,
    credential: P0OperatorCredential,
    options: OperatorOptions = {},
  ): PreparedOperator {
    if (
      ![
        "operator.authenticate",
        "session.query",
        "host.query",
        "session.authorize",
        "session.renew",
        "session.revoke",
        "session.stop",
        "session.execute",
        "fault.configure",
      ].includes(method) ||
      "proof" in input ||
      "mapping" in input
    )
      reject("ROLE_SCOPE_DENIED");
    if ("session_id" in input && input.session_id !== this.announcement.session_id)
      reject("ROLE_SCOPE_DENIED");
    const grant =
      (method === "session.execute" || method === "session.revoke") &&
      "grant_id" in input &&
      typeof input.grant_id === "string"
        ? input.grant_id
        : null;
    if (options.grant !== undefined && options.grant !== grant)
      reject("OPERATION_PAYLOAD_CONFLICT");
    const request = operatorRequest(
      method,
      { ...input, mapping: this.mapping },
      this.context(
        options.operation,
        grant,
        this.announcement.authority_epoch,
        options.timeoutMs ?? this.limits.peer_health_timeout_ms,
      ),
      this.announcement,
      credential,
    );
    const prepared = freeze(
      structuredClone({ request, service: this.#peer, authority: this.#authority }),
    );
    preparedOperators.set(prepared, {
      clock: this.clock,
      origin: this.clock.origin,
      domain: this.clock.domain,
      caller: this.instanceId,
      credential: credentialBinding(credential),
    });
    this.#checkPrepared(prepared, credential);
    return prepared;
  }
  #checkPrepared(prepared: PreparedOperator, credential: P0OperatorCredential): void {
    const fixed = preparedOperators.get(prepared);
    if (
      !fixed ||
      fixed.clock !== this.clock ||
      fixed.origin !== this.clock.origin ||
      fixed.domain !== this.clock.domain ||
      fixed.caller !== this.instanceId ||
      fixed.credential !== credentialBinding(credential)
    )
      reject("AUTHENTICATION_REQUIRED");
    const { request } = prepared;
    const c = request.params.context;
    if (
      payloadDigest(prepared.service) !== payloadDigest(this.#peer) ||
      payloadDigest(prepared.authority) !== payloadDigest(this.#authority) ||
      c.object_ref.kind !== "Session" ||
      c.object_ref.id !== this.announcement.session_id ||
      c.caller_instance_id !== this.instanceId
    )
      reject("ROLE_SCOPE_DENIED");
    if (c.authority_epoch !== this.announcement.authority_epoch) reject("SCOPED_EPOCH_CONFLICT");
    validateMapping(this.mapping, this.announcement, this.instanceId, this.limits);
    const now = this.clock.now();
    if (now >= this.mapping.source_valid_until_ms) reject("CLOCK_MAPPING_INVALID");
    const deadlines: Deadline[] = [c.deadline];
    if (request.method === "session.authorize")
      deadlines.push(
        request.params.input.human_lease_deadline,
        request.params.input.grant_deadline,
      );
    if (request.method === "session.renew")
      deadlines.push(request.params.input.human_lease_deadline);
    for (const deadline of deadlines) {
      if (
        deadline.clock_domain !== this.mapping.target_clock_domain ||
        deadline.expires_at_ms <= deadline.issued_at_ms ||
        deadline.expires_at_ms > this.mapping.target_valid_until_ms
      )
        reject("CLOCK_MAPPING_INVALID");
      if (now + this.mapping.offset_upper_ms >= deadline.expires_at_ms)
        reject("COMMAND_DEADLINE_MISSED");
    }
  }
  sendPrepared(prepared: PreparedOperator, credential: P0OperatorCredential): Promise<RpcExchange> {
    this.#checkPrepared(prepared, credential);
    const original = structuredClone(prepared.request) as RpcRequest;
    const {
      proof: _proof,
      mapping: _mapping,
      ...business
    } = original.params.input as Record<string, unknown>;
    return this.requestExchange(
      operatorRequest(
        original.method,
        { ...business, mapping: this.mapping },
        original.params.context,
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
