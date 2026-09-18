import { chmod } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { dirname } from "node:path";
import { commands } from "../../../contracts/generated/registries.ts";
import {
  type P0OperatorCredential,
  type P0PeerIdentity,
  type P0SafetyLimits,
  type P0SessionSnapshot,
  payloadDigest,
  type RpcRequest,
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
import { JsonChannel } from "./transport.ts";

export type ServiceOptions = {
  identity: Identity;
  sessionId: string;
  clock: MonotonicClock;
  limits: P0SafetyLimits;
  credential: P0OperatorCredential | null;
  peers: readonly P0PeerIdentity[];
  snapshot: () => P0SessionSnapshot;
  onHealth?: () => void;
  faultInjectionEnabled: boolean;
};

/** W3 service: actual identity and transport, zero execution authority. */
export class P0Service {
  readonly options: ServiceOptions;
  #channels = new Set<JsonChannel>();
  #server: Server | undefined;
  #owned = new OwnedPaths();
  #socketPath: string | undefined;
  #closing = false;
  constructor(options: ServiceOptions) {
    this.options = options;
  }

  accept(channel: JsonChannel): void {
    const o = this.options;
    if (this.#closing || this.#channels.size >= o.limits.max_pending_requests) {
      channel.close();
      return;
    }
    this.#channels.add(channel);
    const a = announce(o.identity, o.sessionId, o.clock, o.limits.clock_mapping_ttl_ms);
    const auth = new ConnectionAuthentication(a);
    let peer: P0PeerIdentity | undefined;
    let pending = 0;
    const expiry = setTimeout(() => channel.close(), o.limits.clock_mapping_ttl_ms);
    channel.on("closed", () => {
      clearTimeout(expiry);
      this.#channels.delete(channel);
    });
    channel.on("invalid", () => {
      channel.send(protocolFailure(null, -32700));
      channel.end();
    });
    channel.on("message", (raw: unknown) => {
      if (pending >= o.limits.max_pending_requests) {
        channel.close();
        return;
      }
      pending++;
      try {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          channel.send(protocolFailure(null, -32600));
          return;
        }
        const envelope = raw as Record<string, unknown>;
        const id =
          typeof envelope.id === "string" && envelope.id.length > 0 && envelope.id.length <= 256
            ? envelope.id
            : null;
        if (envelope.jsonrpc !== "2.0" || id === null || typeof envelope.method !== "string") {
          channel.send(protocolFailure(id, -32600));
          return;
        }
        const command = commands.commands.find((c) => c.name === envelope.method);
        if (!command) {
          channel.send(protocolFailure(id, -32601));
          return;
        }
        if (!validate("RpcRequest", raw)) {
          channel.send(protocolFailure(id, -32602));
          return;
        }
        const request: RpcRequest = raw;
        const { context, input } = request.params;
        try {
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
          if (context.authority_epoch !== 0) reject("SCOPED_EPOCH_CONFLICT");
          let result: unknown;
          if (request.method === "connection.authenticate") {
            peer = auth.peer(request, o.peers, o.clock.now());
            result = {
              connection_id: a.connection_id,
              peer_role: peer.role,
              peer_instance_id: peer.instance_id,
              authenticated_at: o.clock.point(),
            };
          } else if (command.permission_scope.startsWith("operator.")) {
            if (!o.credential) reject("ROLE_SCOPE_DENIED");
            const operator = auth.operator(request, o.credential, o.clock.now());
            if (peer) reject("ROLE_SCOPE_DENIED");
            if ("session_id" in input && input.session_id !== o.sessionId)
              reject("ROLE_SCOPE_DENIED");
            if (request.method === "operator.authenticate")
              result = {
                credential_id: operator.credential_id,
                operator_id: operator.operator_id,
                role: operator.role,
                connection_id: a.connection_id,
                authenticated_at: o.clock.point(),
              };
            else if (request.method === "session.query") result = o.snapshot();
            else if (request.method === "session.authorize") {
              if (
                request.params.input.mode !== "simulation" ||
                request.params.input.supervision_mode !== "supervised" ||
                request.params.input.public_broadcast_allowed
              )
                reject("P0_MODE_DENIED");
              reject("PERSISTENCE_NOT_READY");
            } else if (request.method === "session.execute") reject("PERSISTENCE_NOT_READY");
            else if (request.method === "fault.configure") {
              if (operator.role !== "test_operator" || !o.faultInjectionEnabled)
                reject("ROLE_SCOPE_DENIED");
              reject("SERVICE_NOT_READY");
            } else reject("CONTROLLER_NOT_READY");
          } else {
            if (!peer || context.caller_instance_id !== peer.instance_id)
              reject("AUTHENTICATION_REQUIRED");
            if ("session_id" in input && input.session_id !== o.sessionId)
              reject("ROLE_SCOPE_DENIED");
            if (request.method === "clock.sample")
              result = {
                target_instance_id: o.identity.public.instance_id,
                target_received_at: o.clock.point(),
                target_sent_at: o.clock.point(),
                connection_id: a.connection_id,
              };
            else if (
              request.method === "supervisor.query" ||
              request.method === "supervisor.health" ||
              request.method === "supervisor.register_effect"
            ) {
              if (peer.role !== "host") reject("ROLE_SCOPE_DENIED");
              if (request.method === "supervisor.query") result = o.snapshot();
              else if (request.method === "supervisor.health") {
                if (
                  request.params.input.peer_instance_id !== peer.instance_id ||
                  request.params.input.peer_role !== peer.role
                )
                  reject("ROLE_SCOPE_DENIED");
                o.onHealth?.();
                result = {
                  session_id: o.sessionId,
                  supervision: o.snapshot().supervision,
                  observed_at: o.clock.point(),
                };
              } else reject("PERSISTENCE_NOT_READY");
            } else if (request.method === "fault.apply") {
              if (
                peer.role !== "supervisor" ||
                !o.faultInjectionEnabled ||
                request.params.input.target_instance_id !== o.identity.public.instance_id
              )
                reject("ROLE_SCOPE_DENIED");
              reject("SERVICE_NOT_READY");
            } else reject("ROLE_SCOPE_DENIED");
          }
          const response = { jsonrpc: "2.0", id, result };
          validateRpcResponse(request.method, response);
          channel.send(response);
        } catch (error) {
          channel.send(
            error instanceof RuntimeRejection
              ? businessFailure(id, context, error.reason)
              : protocolFailure(id, -32603),
          );
          if (error instanceof RuntimeRejection && error.reason === "AUTHENTICATION_REQUIRED")
            channel.end();
        }
      } finally {
        pending--;
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
          this.options.limits.max_pending_requests,
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
