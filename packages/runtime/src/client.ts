import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { dirname } from "node:path";
import {
  assertValid,
  type CommandContext,
  type P0ClockMapping,
  type P0ConnectionAnnouncement,
  type P0OperatorCredential,
  type P0PeerIdentity,
  type P0SafetyLimits,
  type RpcFailure,
  type RpcRequest,
  type RpcSuccess,
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
import { JsonChannel } from "./transport.ts";

export class RpcConnection {
  readonly channel: JsonChannel;
  readonly clock: MonotonicClock;
  readonly instanceId: string;
  readonly limits: P0SafetyLimits;
  announcement!: P0ConnectionAnnouncement;
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
  #lastResponse: RpcSuccess | RpcFailure | undefined;
  get lastResponse(): RpcSuccess | RpcFailure | undefined {
    return this.#lastResponse ? structuredClone(this.#lastResponse) : undefined;
  }

  private constructor(
    channel: JsonChannel,
    clock: MonotonicClock,
    instance: string,
    limits: P0SafetyLimits,
  ) {
    this.channel = channel;
    this.clock = clock;
    this.instanceId = instance;
    this.limits = limits;
    channel.on("message", (raw: unknown) => {
      if (!this.#announced) {
        this.#announced = true;
        this.#firstResolve?.(raw);
        return;
      }
      if (!raw || typeof raw !== "object" || !("id" in raw) || typeof raw.id !== "string") {
        channel.close();
        return;
      }
      const pending = this.#pending.get(raw.id);
      if (!pending) {
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
  ): Promise<RpcConnection> {
    await controlledPath(socketPath, dirname(socketPath), true, true);
    const sent = clock.now();
    const socket = createConnection(socketPath);
    const channel = new JsonChannel(
      socket,
      socket,
      limits.max_message_bytes,
      limits.max_pending_requests,
    );
    return RpcConnection.fromChannel(channel, identity, limits, instance, clock, sent);
  }

  static async fromChannel(
    channel: JsonChannel,
    identity: P0PeerIdentity,
    limits: P0SafetyLimits,
    instance: string,
    clock: MonotonicClock,
    sent: number,
  ): Promise<RpcConnection> {
    const connection = new RpcConnection(channel, clock, instance, limits);
    const timer = setTimeout(() => channel.close(), limits.peer_health_timeout_ms);
    try {
      const raw = await new Promise<unknown>((resolve, reject) => {
        connection.#firstResolve = resolve;
        connection.#firstReject = reject;
      });
      const received = clock.now();
      connection.announcement = verifyAnnouncement(raw, identity);
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
      authority_epoch: 0,
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
    return this.request(
      completeRequest(method, { ...input, mapping: this.mapping }, this.context(operation)),
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
