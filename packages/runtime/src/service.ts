import { chmod } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { dirname } from "node:path";
import { commands } from "../../../contracts/generated/registries.ts";
import {
  assertValid,
  type P0ConnectionAnnouncement,
  type P0EndpointProjection,
  type P0OperatorCredential,
  type P0OperatorIdentity,
  type P0PeerIdentity,
  type P0SafetyLimits,
  type P0SessionSnapshot,
  payloadDigest,
  type RpcRequest,
  type StopOperationRecord,
  validate,
  validateRpcResponse,
} from "../../contract-sdk/src/index.ts";
import { checkDeadline, type MonotonicClock, validateMapping } from "./clock.ts";
import { businessFailure, protocolFailure, RuntimeRejection, reject } from "./errors.ts";
import { controlledPath, OwnedPaths } from "./files.ts";
import {
  announce,
  announcementEvent,
  ConnectionAuthentication,
  type Identity,
} from "./identity.ts";
import {
  type CommandTrigger,
  type ObservationWriter,
  observationError,
  ProtocolObservation,
} from "./observation.ts";
import { type ServiceWorkCell, ServiceWorkPool } from "./service-capacity.ts";
import { JsonChannel } from "./transport.ts";

type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type ServiceInvocation = DeepReadonly<{
  request: RpcRequest;
  announcement: P0ConnectionAnnouncement;
  trigger: CommandTrigger;
  actor:
    | { kind: "operator"; identity: P0OperatorIdentity }
    | { kind: "peer"; identity: P0PeerIdentity };
}>;
export type ServiceDelegate = {
  // The coordinator alone owns business idempotency and the synchronous safety fence.
  beginSafety: (invocation: ServiceInvocation) => StopOperationRecord;
  // Production safety dispatch returns that real record synchronously, without DB/cancel.
  dispatch: (
    invocation: ServiceInvocation,
    safety: StopOperationRecord | null,
  ) => unknown | Promise<unknown>;
};
export type ServiceOptions = {
  identity: Identity;
  authority: P0PeerIdentity;
  currentAuthorityEpoch: () => number;
  sessionId: string;
  clock: MonotonicClock;
  limits: P0SafetyLimits;
  credential: P0OperatorCredential | null;
  peers: readonly P0PeerIdentity[];
  snapshot: () => P0SessionSnapshot;
  onHealth?: (invocation: ServiceInvocation) => void;
  faultInjectionEnabled: boolean;
  observation?: ObservationWriter;
  delegate?: ServiceDelegate;
  hostEndpoint?: { instanceId: string; projection: () => P0EndpointProjection };
};
type Category = "ordinary" | "safety" | "query";
type PeerLane = "host-health" | "host-business" | "supervisor-control";
type Connection = {
  channel: JsonChannel;
  authenticated: boolean;
  candidate: boolean;
  lane: PeerLane | Category | undefined;
};
function freeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
function category(method: string): Category {
  if (method === "session.stop" || method === "session.revoke") return "safety";
  if (["operator.authenticate", "session.query", "host.query", "supervisor.query"].includes(method))
    return "query";
  return "ordinary";
}

/** Actual P0 authentication and bounded delegation. No delegate means zero effect authority. */
export class P0Service {
  readonly options: ServiceOptions;
  #channels = new Set<JsonChannel>();
  #connections = new Set<Connection>();
  #server: Server | undefined;
  #owned = new OwnedPaths();
  #socketPath: string | undefined;
  #closing = false;
  readonly #authority: P0PeerIdentity;
  readonly #pools: Record<Category, ServiceWorkPool>;
  constructor(options: ServiceOptions) {
    this.options = options;
    this.#authority = Object.freeze(structuredClone(options.authority));
    this.#pools = {
      ordinary: new ServiceWorkPool(options.clock, options.limits.max_pending_requests),
      safety: new ServiceWorkPool(options.clock, 2),
      query: new ServiceWorkPool(options.clock, 2),
    };
  }
  #classify(connection: Connection, lane: PeerLane | Category): void {
    if (connection.lane) {
      if (connection.lane !== lane) reject("ROLE_SCOPE_DENIED");
      return;
    }
    const maximum =
      lane === "ordinary"
        ? this.options.limits.max_pending_requests
        : lane === "safety" || lane === "query"
          ? 2
          : 1;
    if ([...this.#connections].filter((c) => c.lane === lane).length >= maximum)
      reject("QUEUE_LIMIT_EXCEEDED");
    connection.lane = lane;
    connection.candidate = false;
  }
  #peerLane(peer: P0PeerIdentity, method: string): PeerLane {
    if (peer.role === "host") {
      if (["supervisor.health", "clock.sample"].includes(method)) return "host-health";
      if (["supervisor.query", "supervisor.register_effect"].includes(method))
        return "host-business";
    }
    if (peer.role === "supervisor" && ["clock.sample", "fault.apply"].includes(method))
      return "supervisor-control";
    reject("ROLE_SCOPE_DENIED");
  }

  accept(channel: JsonChannel): void {
    const o = this.options;
    if (this.#closing) {
      channel.close();
      return;
    }
    const candidates = [...this.#connections].filter((c) => c.candidate);
    if (candidates.length >= 2) {
      const oldest = candidates.find((c) => !c.authenticated);
      if (!oldest) {
        channel.close();
        return;
      }
      oldest.channel.close();
    }
    const connection: Connection = {
      channel,
      authenticated: false,
      candidate: true,
      lane: undefined,
    };
    this.#connections.add(connection);
    this.#channels.add(channel);
    const acceptedAt = o.clock.now();
    const authUntil =
      acceptedAt +
      Math.min(
        o.limits.clock_mapping_ttl_ms,
        o.limits.peer_health_timeout_ms,
        o.limits.stop_timeout_ms,
      );
    const a = announce(
      o.identity,
      o.sessionId,
      o.clock,
      o.limits.clock_mapping_ttl_ms,
      this.#authority,
      o.currentAuthorityEpoch(),
    );
    const auth = new ConnectionAuthentication(a);
    const observation = o.observation
      ? new ProtocolObservation(o.observation, a.connection_id)
      : undefined;
    observation?.attach(channel);
    let peer: P0PeerIdentity | undefined;
    const authExpiry = setTimeout(
      () => {
        if (connection.candidate) channel.close();
      },
      Math.max(0, authUntil - o.clock.now()),
    );
    const expiry = setTimeout(() => channel.close(), Math.max(0, a.expires_at_ms - o.clock.now()));
    channel.on("closed", () => {
      clearTimeout(expiry);
      clearTimeout(authExpiry);
      this.#channels.delete(channel);
      this.#connections.delete(connection);
    });
    const failed = (id: string | null, error: unknown, request?: RpcRequest, finish = false) => {
      if (channel.closed || this.#closing) return;
      observation?.failure("dispatch", observationError(error), request);
      channel.send(
        error instanceof RuntimeRejection && request
          ? businessFailure(request.id, request.params.context, error.reason)
          : protocolFailure(id, -32603),
      );
      if (
        finish ||
        (error instanceof RuntimeRejection && error.reason === "AUTHENTICATION_REQUIRED")
      )
        channel.end();
    };
    channel.on("invalid", () => {
      channel.send(protocolFailure(null, -32700));
      channel.end();
    });
    channel.on("message", (raw: unknown) => {
      if (this.#closing || channel.closed) return;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        channel.send(protocolFailure(null, -32600));
        channel.end();
        return;
      }
      const envelope = raw as Record<string, unknown>;
      const id =
        typeof envelope.id === "string" && envelope.id.length > 0 && envelope.id.length <= 256
          ? envelope.id
          : null;
      if (envelope.jsonrpc !== "2.0" || id === null || typeof envelope.method !== "string") {
        channel.send(protocolFailure(id, -32600));
        channel.end();
        return;
      }
      const command = commands.commands.find((c) => c.name === envelope.method);
      if (!command) {
        channel.send(protocolFailure(id, -32601));
        channel.end();
        return;
      }
      if (!validate("RpcRequest", raw)) {
        channel.send(protocolFailure(id, -32602));
        channel.end();
        return;
      }
      const request: RpcRequest = raw;
      const operatorCommand = command.permission_scope.startsWith("operator.");
      // A valid operator frame owns the connection even if its authentication later fails.
      if (operatorCommand) channel.sealRead();
      const trigger = observation?.triggerFor(request);
      const { context, input } = request.params;
      const success = (result: unknown, safety = false) => {
        if (channel.closed || this.#closing) return;
        try {
          checkDeadline(context.deadline, o.clock);
          if (!safety && context.authority_epoch !== o.currentAuthorityEpoch())
            reject("SCOPED_EPOCH_CONFLICT");
          const response = { jsonrpc: "2.0", id, result };
          validateRpcResponse(request.method, response);
          channel.send(response);
          if (operatorCommand) channel.end();
        } catch (error) {
          failed(id, error, request, operatorCommand);
        }
      };
      try {
        if (connection.candidate && o.clock.now() >= authUntil) reject("COMMAND_DEADLINE_MISSED");
        if (payloadDigest({ method: request.method, input }) !== context.payload_digest)
          reject("OPERATION_PAYLOAD_CONFLICT");
        if (![o.identity.public.role, "local_peer"].includes(command.target))
          reject("ROLE_SCOPE_DENIED");
        if (context.object_ref.kind !== "Session" || context.object_ref.id !== o.sessionId)
          reject("ROLE_SCOPE_DENIED");
        if (!("mapping" in input)) reject("CLOCK_MAPPING_INVALID");
        validateMapping(input.mapping, a, context.caller_instance_id, o.limits, o.clock.now());
        checkDeadline(context.deadline, o.clock);
        if (context.deadline.expires_at_ms > input.mapping.target_valid_until_ms)
          reject("CLOCK_MAPPING_INVALID");
        if (
          context.authority_epoch !== o.currentAuthorityEpoch() ||
          ((!peer || request.method === "connection.authenticate") &&
            context.authority_epoch !== a.authority_epoch)
        )
          reject("SCOPED_EPOCH_CONFLICT");
        if (request.method === "connection.authenticate") {
          peer = auth.peer(request, o.peers, o.clock.now());
          connection.authenticated = true;
          success({
            connection_id: a.connection_id,
            peer_role: peer.role,
            peer_instance_id: peer.instance_id,
            authenticated_at: o.clock.point(),
          });
          return;
        }
        let actor: ServiceInvocation["actor"];
        if (operatorCommand) {
          if (!o.credential) reject("ROLE_SCOPE_DENIED");
          const operator = auth.operator(request, o.credential, o.clock.now());
          if (peer) reject("ROLE_SCOPE_DENIED");
          connection.authenticated = true;
          actor = {
            kind: "operator",
            identity: {
              credential_id: operator.credential_id,
              operator_id: operator.operator_id,
              role: operator.role,
              connection_id: a.connection_id,
              authenticated_at: o.clock.point(),
            },
          };
        } else {
          if (!peer || context.caller_instance_id !== peer.instance_id)
            reject("AUTHENTICATION_REQUIRED");
          actor = { kind: "peer", identity: peer };
        }
        if ("session_id" in input && input.session_id !== o.sessionId) reject("ROLE_SCOPE_DENIED");
        if (
          request.method === "session.authorize" &&
          (request.params.input.mode !== "simulation" ||
            request.params.input.supervision_mode !== "supervised" ||
            request.params.input.public_broadcast_allowed)
        )
          reject("P0_MODE_DENIED");
        if (
          request.method === "fault.configure" &&
          (actor.kind !== "operator" ||
            actor.identity.role !== "test_operator" ||
            !o.faultInjectionEnabled)
        )
          reject("ROLE_SCOPE_DENIED");
        if (
          request.method === "host.query" &&
          (o.identity.public.role !== "host" || !o.hostEndpoint)
        )
          reject("ROLE_SCOPE_DENIED");
        if (
          request.method === "supervisor.health" &&
          (actor.kind !== "peer" ||
            actor.identity.role !== "host" ||
            request.params.input.peer_instance_id !== actor.identity.instance_id ||
            request.params.input.peer_role !== actor.identity.role)
        )
          reject("ROLE_SCOPE_DENIED");
        if (request.method === "fault.apply") {
          if (
            actor.kind !== "peer" ||
            actor.identity.role !== "supervisor" ||
            o.identity.public.role !== "host" ||
            !o.faultInjectionEnabled ||
            request.params.input.target_instance_id !== o.identity.public.instance_id ||
            request.params.input.selection.target !== "host"
          )
            reject("ROLE_SCOPE_DENIED");
          checkDeadline(request.params.input.deadline, o.clock);
          if (request.params.input.deadline.expires_at_ms > context.deadline.expires_at_ms)
            reject("CLOCK_MAPPING_INVALID");
        }
        const makeInvocation = (): ServiceInvocation => {
          if (!trigger) reject("SERVICE_NOT_READY");
          return freeze(structuredClone({ request, announcement: a, trigger, actor }));
        };
        const kind = category(request.method);
        const safety = kind === "safety";
        let invocation: ServiceInvocation | undefined;
        let stop: StopOperationRecord | null = null;
        if (safety && o.delegate) {
          invocation = makeInvocation();
          stop = o.delegate.beginSafety(invocation);
          assertValid("StopOperationRecord", stop);
          stop = structuredClone(stop);
        }
        this.#classify(
          connection,
          actor.kind === "operator" ? kind : this.#peerLane(actor.identity, request.method),
        );
        clearTimeout(authExpiry);
        if (request.method === "clock.sample") {
          success({
            target_instance_id: o.identity.public.instance_id,
            target_received_at: o.clock.point(),
            target_sent_at: o.clock.point(),
            connection_id: a.connection_id,
          });
          return;
        }
        if (request.method === "supervisor.health") {
          if (o.onHealth) o.onHealth(makeInvocation());
          success({
            session_id: o.sessionId,
            supervision: o.snapshot().supervision,
            observed_at: o.clock.point(),
          });
          return;
        }
        if (request.method === "operator.authenticate") {
          success(actor.identity);
          return;
        }
        const builtin = (): unknown => {
          if (request.method === "session.query" || request.method === "supervisor.query")
            return o.snapshot();
          if (request.method === "host.query") {
            const endpoint = o.hostEndpoint;
            if (!endpoint) reject("ROLE_SCOPE_DENIED");
            const projection = endpoint.projection();
            if (
              projection.source_instance_id !== endpoint.instanceId ||
              (projection.fact &&
                (projection.fact.endpoint_instance_id !== endpoint.instanceId ||
                  projection.fact.session_id !== o.sessionId))
            )
              reject("ROLE_SCOPE_DENIED");
            return projection;
          }
          if (
            ["session.authorize", "session.execute", "supervisor.register_effect"].includes(
              request.method,
            )
          )
            reject("PERSISTENCE_NOT_READY");
          if (["fault.configure", "fault.apply"].includes(request.method))
            reject("SERVICE_NOT_READY");
          reject("CONTROLLER_NOT_READY");
        };
        // host.query is always this Host's cache, never an arbitrary delegated projection.
        const delegated = request.method !== "host.query" ? o.delegate : undefined;
        if (delegated) invocation ??= makeInvocation();
        const stopDigest = stop ? payloadDigest(stop) : null;
        let cell: ServiceWorkCell;
        const disconnected = () => cell.dropReply();
        cell = this.#pools[kind].reserve(context.deadline.expires_at_ms, {
          success: (result) => {
            try {
              if (stopDigest !== null && payloadDigest(result) !== stopDigest)
                throw new Error("SAFETY_RESULT_CHANGED");
              success(result, safety);
            } catch (error) {
              failed(id, error, request, operatorCommand);
            }
          },
          failure: (error) => failed(id, error, request, operatorCommand),
          detach: () => channel.off("closed", disconnected),
        });
        channel.once("closed", disconnected);
        const prepared = invocation;
        cell.start(() => (delegated && prepared ? delegated.dispatch(prepared, stop) : builtin()));
      } catch (error) {
        failed(id, error, request, operatorCommand);
      }
    });
    channel.send(announcementEvent(a));
  }

  async listen(socketPath: string): Promise<void> {
    if (this.#server || this.#closing) throw new Error("SERVICE_ALREADY_LISTENING");
    await controlledPath(socketPath, dirname(socketPath), false);
    await controlledPath(`${socketPath}.identity.json`, dirname(socketPath), false);
    const server = createServer((socket) =>
      this.accept(
        new JsonChannel(
          socket,
          socket,
          this.options.limits.max_message_bytes,
          // A fixed finite reserve for announcement/auth responses: a peer may
          // pipeline its authentication and first method even when ordinary N=1.
          this.options.limits.max_pending_requests + 2,
        ),
      ),
    );
    this.#server = server;
    this.#socketPath = socketPath;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
      server.on("error", () => {
        for (const channel of this.#channels) channel.close();
      });
      await this.#owned.remember(socketPath);
      await chmod(socketPath, 0o600);
      await this.#owned.writeIdentity(`${socketPath}.identity.json`, this.options.identity.public);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    this.#closing = true;
    for (const pool of Object.values(this.#pools)) pool.close();
    for (const channel of this.#channels) channel.close();
    if (this.#server) {
      const server = this.#server;
      this.#server = undefined;
      if (this.#socketPath && (await this.#owned.matches(this.#socketPath)))
        await new Promise<void>((resolve) => server.close(() => resolve()));
      else server.unref();
    }
    await this.#owned.cleanup();
  }
}
