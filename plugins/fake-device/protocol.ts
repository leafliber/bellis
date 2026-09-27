import { randomUUID } from "node:crypto";
import { chmod } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { dirname } from "node:path";
import { commands } from "../../contracts/generated/registries.ts";
import {
  assertValid,
  type P0ClockMapping,
  type P0EndpointConfig,
  type P0EndpointSnapshot,
  type P0PeerIdentity,
  payloadDigest,
  type RpcRequest,
  schemaDigest,
  validate,
  validateRpcResponse,
} from "../../packages/contract-sdk/src/index.ts";
import {
  checkDeadline,
  type MonotonicClock,
  validateMapping,
} from "../../packages/runtime/src/clock.ts";
import {
  businessFailure,
  protocolFailure,
  RuntimeRejection,
  reject,
} from "../../packages/runtime/src/errors.ts";
import { controlledPath, OwnedPaths } from "../../packages/runtime/src/files.ts";
import {
  announce,
  announcementEvent,
  ConnectionAuthentication,
  type Identity,
} from "../../packages/runtime/src/identity.ts";
import {
  ObservationWriter,
  observationError,
  ProtocolObservation,
} from "../../packages/runtime/src/observation.ts";
import { JsonChannel } from "../../packages/runtime/src/transport.ts";
import { EndpointModel } from "./model.ts";
import {
  type EndpointLedgerKind,
  EndpointOperationLedger,
  endpointBusinessDigest,
} from "./operation-ledger.ts";

const legacy = new Set([
  "plugin.handshake",
  "plugin.describe",
  "controller.observe_status",
  "controller.stop",
  "controller.dispose",
]);

type ChannelRole = "host" | "supervisor";
type ChannelLane = "host" | "candidate" | "control" | "cancel";
type ChannelState = {
  role: ChannelRole;
  lane: ChannelLane;
  authenticated: boolean;
  candidateDeadline: number | null;
  candidateTimer: ReturnType<typeof setTimeout> | undefined;
};

const supervisorCancelMethods = new Set([
  "controller.observe_status",
  "controller.stop",
  "controller.dispose",
]);
const supervisorControlMethods = new Set([
  "endpoint.lease",
  "endpoint.revoke",
  "simulation.query",
  "clock.sample",
  "fault.apply",
]);

// Physical write cells are separate from the service-wide ordinary task allowance N.
// P1c will account for response and event classes before submitting these cells.
const ENDPOINT_WIRE_RESERVE = 8;

export class EndpointProtocol {
  readonly model: EndpointModel;
  readonly identity: Identity;
  readonly config: P0EndpointConfig;
  readonly clock: MonotonicClock;
  readonly observation: ObservationWriter;
  #channels = new Map<JsonChannel, ChannelState>();
  #hostAccepted = false;
  #server: Server | undefined;
  #owned = new OwnedPaths();
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #ticker: ReturnType<typeof setInterval> | undefined;
  #closing = false;
  #eventSequence = 0;
  #operations: EndpointOperationLedger;
  onExit: (() => void) | undefined;

  constructor(
    config: P0EndpointConfig,
    identity: Identity,
    clock: MonotonicClock,
    observation?: ObservationWriter,
  ) {
    this.config = config;
    this.identity = identity;
    this.clock = clock;
    this.observation =
      observation ??
      new ObservationWriter("endpoint", config.endpoint_instance_id, clock, config.limits);
    this.model = new EndpointModel(config, clock);
    this.#operations = new EndpointOperationLedger(config.limits.max_message_bytes);
    this.model.onChange = (fact) => this.#publish(fact);
  }
  #observe(fact: P0EndpointSnapshot): void {
    this.observation.endpoint(fact);
  }
  #later(callback: () => void, ms: number): void {
    if (this.#timers.size >= this.config.limits.max_pending_requests + ENDPOINT_WIRE_RESERVE) {
      for (const channel of this.#channels.keys()) channel.close();
      this.model.disconnect();
      return;
    }
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      if (!this.#closing) callback();
    }, ms);
    this.#timers.add(timer);
  }
  #publish(fact: P0EndpointSnapshot): void {
    this.#observe(fact);
    const event = {
      jsonrpc: "2.0",
      method: "event.publish",
      params: {
        schema_version: "0.8.0",
        event_name: fact.stopped ? "simulation.stopped" : "simulation.progressed",
        event_id: randomUUID(),
        authority_id: "endpoint",
        source_instance: this.config.endpoint_instance_id,
        authority_epoch: this.model.authorityEpoch,
        source_seq: this.#eventSequence++,
        session_id: this.config.session_id,
        scope_ref: { kind: "Session", id: this.config.session_id },
        correlation: { key: "endpoint", value: this.config.endpoint_instance_id },
        occurred_at: fact.observed_at,
        trace_id: randomUUID(),
        payload: fact,
      },
    };
    assertValid("RpcEvent", event);
    for (const [channel, state] of this.#channels) {
      if (!state.authenticated || state.lane === "candidate" || state.lane === "cancel") continue;
      const send = () => {
        if (!channel.closed) channel.send(event);
      };
      // Delay a progress receipt without rewriting its original facts. A later stop can arrive first.
      if (
        this.model.fault() === "ack_delay" ||
        (this.model.fault() === "ack_reverse_order" && !fact.stopped)
      )
        this.#later(send, this.config.limits.stop_timeout_ms);
      else send();
    }
  }
  accept(channel: JsonChannel, role: ChannelRole): void {
    if (channel.closed || this.#closing || (role === "host" && this.#hostAccepted)) {
      channel.close();
      return;
    }
    if (role === "supervisor") {
      const candidates = [...this.#channels].filter(([, state]) => state.lane === "candidate");
      if (candidates.length >= 2) {
        const oldestUnauthenticated = candidates.find(([, state]) => !state.authenticated);
        if (!oldestUnauthenticated) {
          channel.close();
          return;
        }
        oldestUnauthenticated[0].close();
      }
    } else this.#hostAccepted = true;
    const candidateBudget = Math.min(
      this.config.limits.clock_mapping_ttl_ms,
      this.config.limits.peer_health_timeout_ms,
      this.config.limits.stop_timeout_ms,
    );
    const state: ChannelState = {
      role,
      lane: role === "host" ? "host" : "candidate",
      authenticated: false,
      candidateDeadline: role === "host" ? null : this.clock.now() + candidateBudget,
      candidateTimer: undefined,
    };
    this.#channels.set(channel, state);
    if (role === "supervisor") {
      state.candidateTimer = setTimeout(() => {
        if (state.lane === "candidate") channel.close();
      }, candidateBudget);
    }
    const a = announce(
      this.identity,
      this.config.session_id,
      this.clock,
      this.config.limits.clock_mapping_ttl_ms,
      this.config.supervisor_identity,
      this.model.authorityEpoch,
    );
    const auth = new ConnectionAuthentication(a);
    const observation = new ProtocolObservation(this.observation, a.connection_id);
    observation.attach(channel);
    let peer: P0PeerIdentity | undefined;
    let mapping: P0ClockMapping | undefined;
    let handshaken = false;
    const expiry = setTimeout(() => channel.close(), this.config.limits.clock_mapping_ttl_ms);
    channel.on("readEnded", () => {
      if (role === "host") this.model.disconnect();
    });
    channel.on("closed", () => {
      clearTimeout(expiry);
      clearTimeout(state.candidateTimer);
      this.#channels.delete(channel);
      if (role === "host") this.model.disconnect();
    });
    channel.on("invalid", () => {
      channel.send(protocolFailure(null, -32700));
      channel.end();
    });
    channel.on("message", (raw: unknown) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        channel.send(protocolFailure(null, -32600));
        return;
      }
      const envelope = raw as Record<string, unknown>;
      const id =
        typeof envelope.id === "string" && envelope.id.length > 0 && envelope.id.length <= 256
          ? envelope.id
          : null;
      if (id === null || envelope.jsonrpc !== "2.0" || typeof envelope.method !== "string") {
        channel.send(protocolFailure(id, -32600));
        return;
      }
      if (!commands.commands.some((c) => c.name === envelope.method)) {
        channel.send(protocolFailure(id, -32601));
        return;
      }
      if (!validate("RpcRequest", raw)) {
        channel.send(protocolFailure(id, -32602));
        return;
      }
      const request: RpcRequest = raw;
      const { input, context } = request.params;
      try {
        this.model.tick(false);
        if (
          state.lane === "candidate" &&
          state.candidateDeadline !== null &&
          this.clock.now() >= state.candidateDeadline
        ) {
          channel.close();
          return;
        }
        if (
          context.object_ref.kind !== "Session" ||
          context.object_ref.id !== this.config.session_id
        )
          reject("ROLE_SCOPE_DENIED");
        if (payloadDigest({ method: request.method, input }) !== context.payload_digest)
          reject("OPERATION_PAYLOAD_CONFLICT");
        const currentMapping = "mapping" in input ? input.mapping : mapping;
        if (!currentMapping) reject("CLOCK_MAPPING_INVALID");
        validateMapping(
          currentMapping,
          a,
          context.caller_instance_id,
          this.config.limits,
          this.clock.now(),
        );
        if (mapping && payloadDigest(currentMapping) !== payloadDigest(mapping))
          reject("CLOCK_MAPPING_INVALID");
        checkDeadline(context.deadline, this.clock);
        if (context.deadline.expires_at_ms > currentMapping.target_valid_until_ms)
          reject("CLOCK_MAPPING_INVALID");
        let result: unknown;
        if (request.method === "connection.authenticate") {
          if (
            context.authority_epoch !== a.authority_epoch ||
            a.authority_epoch !== this.model.authorityEpoch
          )
            reject("SCOPED_EPOCH_CONFLICT");
          peer = auth.peer(
            request,
            [role === "host" ? this.config.host_identity : this.config.supervisor_identity],
            this.clock.now(),
          );
          mapping = structuredClone(currentMapping);
          state.authenticated = true;
          if (role === "supervisor") this.model.supervisorSeen();
          result = {
            connection_id: a.connection_id,
            peer_role: peer.role,
            peer_instance_id: peer.instance_id,
            authenticated_at: this.clock.point(),
          };
        } else {
          if (!peer || context.caller_instance_id !== peer.instance_id)
            reject("AUTHENTICATION_REQUIRED");
          const advance =
            role === "supervisor" && ["endpoint.lease", "endpoint.revoke"].includes(request.method);
          if (
            advance
              ? context.authority_epoch < this.model.authorityEpoch
              : context.authority_epoch !== this.model.authorityEpoch
          )
            reject("SCOPED_EPOCH_CONFLICT");
          const allowed =
            role === "host"
              ? [
                  "plugin.handshake",
                  "plugin.describe",
                  "controller.observe_status",
                  "controller.stop",
                  "simulation.execute",
                  "simulation.query",
                  "clock.sample",
                ]
              : [
                  "endpoint.lease",
                  "endpoint.revoke",
                  "simulation.query",
                  "controller.observe_status",
                  "controller.stop",
                  "controller.dispose",
                  "clock.sample",
                  "fault.apply",
                ];
          if (!allowed.includes(request.method)) reject("ROLE_SCOPE_DENIED");
          if (role === "host" && request.method !== "plugin.handshake" && !handshaken)
            reject("CONTROLLER_NOT_READY");
          let lane: "control" | "cancel" | null = null;
          if (role === "supervisor") {
            lane = supervisorCancelMethods.has(request.method)
              ? "cancel"
              : supervisorControlMethods.has(request.method)
                ? "control"
                : null;
            if (!lane || (state.lane !== "candidate" && state.lane !== lane))
              reject("ROLE_SCOPE_DENIED");
            this.#validateSupervisorTarget(request, context, currentMapping);
            if (
              state.lane === "candidate" &&
              [...this.#channels.values()].some((other) => other.lane === lane)
            )
              reject("QUEUE_LIMIT_EXCEEDED");
          }
          this.#validateOriginalBusiness(request, context, currentMapping, role);
          if (request.method === "endpoint.lease")
            this.model.assertLeaseIdentity(request.params.input);
          const safetyAction = [
            "endpoint.revoke",
            "controller.stop",
            "controller.dispose",
          ].includes(request.method);
          const query = [
            "simulation.query",
            "controller.observe_status",
            "clock.sample",
            "plugin.describe",
          ].includes(request.method);
          const category: EndpointLedgerKind = safetyAction
            ? "safety"
            : query
              ? "query"
              : "ordinary";
          const businessDigest = endpointBusinessDigest(
            request.method,
            input as Record<string, unknown>,
            context,
          );
          const identity = {
            peer_role: role,
            peer_instance_id: peer.instance_id,
            session_id: this.config.session_id,
            endpoint_instance_id: this.config.endpoint_instance_id,
            operation_id: context.operation_id,
          };
          const prior = this.#operations.lookup(identity, businessDigest, a.connection_id);
          if (role === "supervisor") {
            if (state.lane === "candidate") {
              state.lane = lane ?? "candidate";
              clearTimeout(state.candidateTimer);
              state.candidateTimer = undefined;
            }
            this.model.supervisorSeen();
          }
          if (prior.found) {
            if (request.method === "endpoint.lease") {
              const fact = this.model.snapshot();
              if (
                this.model.finalDeadline !== null ||
                fact.fence_applied ||
                fact.active_grant_ref !== request.params.input.grant.grant_id ||
                !fact.host_connection_deadline ||
                !fact.lease_deadline ||
                fact.lease_deadline.expires_at_ms <= this.clock.now()
              )
                reject("EXECUTION_GRANT_REVOKED");
            }
            result = prior.result;
          } else {
            if (request.method === "endpoint.lease" || request.method === "endpoint.revoke")
              this.model.observeAuthorityUpdate(request.params.input, context);
            const boundConnection = ["plugin.handshake", "clock.sample"].includes(request.method)
              ? a.connection_id
              : null;
            const reservation = this.#operations.reserve(
              category,
              identity,
              businessDigest,
              boundConnection,
            );
            if (!reservation && !safetyAction) reject("QUEUE_LIMIT_EXCEEDED");
            result = this.#dispatch(request, currentMapping, role, a.connection_id, () => {
              handshaken = true;
            });
            if (!reservation) {
              // A legal safety action fenced first. Its missing registration isolates this instance.
              this.model.disconnect();
              reject("QUEUE_LIMIT_EXCEEDED");
            }
            try {
              validateRpcResponse(request.method, { jsonrpc: "2.0", id, result });
              this.#operations.commit(reservation, result);
            } catch (error) {
              // A post-effect encoding failure cannot return success or roll a safety fence back.
              this.model.disconnect();
              throw error;
            }
          }
        }
        if (request.method === "controller.stop" && this.model.fault() === "cancel_never_returns")
          return;
        const response = { jsonrpc: "2.0", id, result };
        validateRpcResponse(request.method, response);
        channel.send(response);
        if (request.method === "controller.dispose")
          this.#later(() => {
            void this.close();
          }, 20);
      } catch (error) {
        observation.failure("dispatch", observationError(error), request);
        channel.send(
          error instanceof RuntimeRejection
            ? businessFailure(id, context, error.reason)
            : protocolFailure(id, -32603),
        );
        if (error instanceof RuntimeRejection && error.reason === "AUTHENTICATION_REQUIRED")
          channel.end();
      }
    });
    channel.send(announcementEvent(a));
  }
  #validateOriginalBusiness(
    request: RpcRequest,
    context: RpcRequest["params"]["context"],
    mapping: P0ClockMapping,
    role: ChannelRole,
  ): void {
    const now = this.clock.now();
    switch (request.method) {
      case "plugin.handshake": {
        const input = request.params.input;
        if (
          role !== "host" ||
          input.host_instance_id !== this.config.host_identity.instance_id ||
          input.schema_digest !== schemaDigest ||
          payloadDigest(input.protocol_versions) !== payloadDigest(["0.8.0"]) ||
          payloadDigest(input.enabled_phases) !== payloadDigest(["P0"])
        )
          reject("INSTALLATION_IDENTITY_DENIED");
        break;
      }
      case "clock.sample":
        if (request.params.input.source_sent_at.clock_domain !== mapping.source_clock_domain)
          reject("CLOCK_MAPPING_INVALID");
        break;
      case "simulation.query": {
        const input = request.params.input;
        if (
          input.session_id !== this.config.session_id ||
          input.endpoint_instance_id !== this.config.endpoint_instance_id
        )
          reject("ROLE_SCOPE_DENIED");
        break;
      }
      case "controller.observe_status":
      case "controller.dispose":
        if (request.params.input.instance_id !== this.config.endpoint_instance_id)
          reject("ROLE_SCOPE_DENIED");
        break;
      case "controller.stop": {
        const input = request.params.input;
        if (
          payloadDigest(input.object_ref) !== payloadDigest(context.object_ref) ||
          input.cancel_fence.scope_type !== "session" ||
          input.cancel_fence.scope_id !== this.config.session_id ||
          input.cancel_fence.cancel_epoch !== this.model.authorityEpoch
        )
          reject("ROLE_SCOPE_DENIED");
        if (
          input.stop_deadline.clock_domain !== this.clock.domain ||
          input.stop_deadline.monotonic_ms > context.deadline.expires_at_ms
        )
          reject("CLOCK_MAPPING_INVALID");
        if (input.stop_deadline.monotonic_ms <= now) reject("COMMAND_DEADLINE_MISSED");
        break;
      }
      case "endpoint.lease": {
        const input = request.params.input;
        if (
          input.grant.deadline.clock_domain !== mapping.source_clock_domain ||
          input.grant.deadline.expires_at_ms + mapping.offset_lower_ms <= now
        )
          reject("CLOCK_MAPPING_INVALID");
        for (const deadline of [
          input.deadline,
          input.human_lease_deadline,
          input.local_lease_deadline,
        ]) {
          checkDeadline(deadline, this.clock);
          if (deadline.expires_at_ms > mapping.target_valid_until_ms)
            reject("CLOCK_MAPPING_INVALID");
        }
        break;
      }
      case "simulation.execute": {
        const input = request.params.input;
        const registration = input.registration;
        if (
          registration.session_id !== this.config.session_id ||
          registration.endpoint_instance_id !== this.config.endpoint_instance_id ||
          registration.operation_id !== context.operation_id ||
          registration.grant_id !== context.grant_ref
        )
          reject("SIMULATION_SCOPE_DENIED");
        if (
          registration.deadline.clock_domain !== mapping.source_clock_domain ||
          registration.deadline.expires_at_ms + mapping.offset_lower_ms <= now
        )
          reject("COMMAND_DEADLINE_MISSED");
        const fact = this.model.snapshot();
        if (
          fact.fence_applied ||
          fact.active_grant_ref !== registration.grant_id ||
          !fact.lease_deadline ||
          fact.lease_deadline.expires_at_ms <= now
        )
          reject("EXECUTION_GRANT_REVOKED");
        break;
      }
      default:
        break;
    }
  }
  #validateSupervisorTarget(
    request: RpcRequest,
    context: RpcRequest["params"]["context"],
    mapping: P0ClockMapping,
  ): void {
    switch (request.method) {
      case "controller.observe_status":
      case "controller.dispose":
        if (request.params.input.instance_id !== this.config.endpoint_instance_id)
          reject("ROLE_SCOPE_DENIED");
        break;
      case "controller.stop": {
        const input = request.params.input;
        if (
          payloadDigest(input.object_ref) !== payloadDigest(context.object_ref) ||
          input.cancel_fence.scope_type !== "session" ||
          input.cancel_fence.scope_id !== this.config.session_id ||
          input.cancel_fence.cancel_epoch !== this.model.authorityEpoch
        )
          reject("ROLE_SCOPE_DENIED");
        if (
          input.stop_deadline.clock_domain !== this.clock.domain ||
          input.stop_deadline.monotonic_ms > context.deadline.expires_at_ms
        )
          reject("CLOCK_MAPPING_INVALID");
        break;
      }
      case "simulation.query":
        if (
          request.params.input.session_id !== this.config.session_id ||
          request.params.input.endpoint_instance_id !== this.config.endpoint_instance_id
        )
          reject("ROLE_SCOPE_DENIED");
        break;
      case "endpoint.lease": {
        const grant = request.params.input.grant;
        if (
          grant.session_id !== this.config.session_id ||
          grant.endpoint_instance_id !== this.config.endpoint_instance_id ||
          grant.supervisor_instance_id !== this.config.supervisor_identity.instance_id ||
          grant.host_instance_id !== this.config.host_identity.instance_id
        )
          reject("ROLE_SCOPE_DENIED");
        break;
      }
      case "endpoint.revoke": {
        const input = request.params.input;
        if (
          input.session_id !== this.config.session_id ||
          input.endpoint_instance_id !== this.config.endpoint_instance_id ||
          input.supervisor_instance_id !== this.config.supervisor_identity.instance_id ||
          input.fence.scope_type !== "session" ||
          input.fence.scope_id !== this.config.session_id ||
          input.fence.cancel_epoch !== context.authority_epoch
        )
          reject("ROLE_SCOPE_DENIED");
        break;
      }
      case "clock.sample":
        if (request.params.input.source_sent_at.clock_domain !== mapping.source_clock_domain)
          reject("CLOCK_MAPPING_INVALID");
        break;
      case "fault.apply": {
        const input = request.params.input;
        if (
          input.session_id !== this.config.session_id ||
          input.target_instance_id !== this.config.endpoint_instance_id ||
          input.selection.target !== "endpoint"
        )
          reject("ROLE_SCOPE_DENIED");
        checkDeadline(input.deadline, this.clock);
        if (input.deadline.expires_at_ms > context.deadline.expires_at_ms)
          reject("CLOCK_MAPPING_INVALID");
        break;
      }
      default:
        reject("ROLE_SCOPE_DENIED");
    }
  }
  #dispatch(
    request: RpcRequest,
    mapping: P0ClockMapping,
    role: "host" | "supervisor",
    connectionId: string,
    handshaken: () => void,
  ): unknown {
    const { context } = request.params;
    switch (request.method) {
      case "plugin.handshake": {
        const input = request.params.input;
        if (
          role !== "host" ||
          input.host_instance_id !== this.config.host_identity.instance_id ||
          input.schema_digest !== schemaDigest ||
          payloadDigest(input.protocol_versions) !== payloadDigest(["0.8.0"]) ||
          payloadDigest(input.enabled_phases) !== payloadDigest(["P0"])
        )
          reject("INSTALLATION_IDENTITY_DENIED");
        this.model.handshake(mapping);
        handshaken();
        return {
          connection_id: connectionId,
          plugin_instance_id: this.config.endpoint_instance_id,
          protocol_version: "0.8.0",
          schema_digest: schemaDigest,
          manifest: this.config.manifest,
        };
      }
      case "plugin.describe":
        return this.config.manifest;
      case "clock.sample":
        return {
          target_instance_id: this.config.endpoint_instance_id,
          target_received_at: this.clock.point(),
          target_sent_at: this.clock.point(),
          connection_id: connectionId,
        };
      case "simulation.query": {
        const input = request.params.input;
        if (
          input.session_id !== this.config.session_id ||
          input.endpoint_instance_id !== this.config.endpoint_instance_id
        )
          reject("ROLE_SCOPE_DENIED");
        return this.model.snapshot();
      }
      case "endpoint.lease":
        this.model.install(request.params.input, context);
        return this.model.snapshot();
      case "endpoint.revoke":
        this.model.revoke(request.params.input, context);
        return this.model.snapshot();
      case "simulation.execute":
        this.model.execute(request.params.input, context);
        return { operation_id: context.operation_id, endpoint_fact: this.model.snapshot() };
      case "controller.observe_status": {
        if (request.params.input.instance_id !== this.config.endpoint_instance_id)
          reject("ROLE_SCOPE_DENIED");
        const fact = this.model.snapshot();
        return {
          instance_id: fact.endpoint_instance_id,
          activation_id: fact.active_grant_ref,
          state: fact.stopped ? "INACTIVE" : "ACTIVE",
          source_revision: fact.source_revision,
          evidence_refs: fact.cleanup_ref ? [fact.cleanup_ref] : [],
        };
      }
      case "controller.stop": {
        const input = request.params.input;
        if (
          payloadDigest(input.object_ref) !== payloadDigest(context.object_ref) ||
          input.cancel_fence.scope_type !== "session" ||
          input.cancel_fence.scope_id !== this.config.session_id ||
          input.cancel_fence.cancel_epoch !== this.model.authorityEpoch
        )
          reject("ROLE_SCOPE_DENIED");
        if (
          input.stop_deadline.clock_domain !== this.clock.domain ||
          input.stop_deadline.monotonic_ms > context.deadline.expires_at_ms
        )
          reject("CLOCK_MAPPING_INVALID");
        this.model.fence();
        return {
          operation_id: context.operation_id,
          object_ref: context.object_ref,
          accepted: true,
          source_revision: this.model.snapshot().source_revision,
        };
      }
      case "controller.dispose":
        if (request.params.input.instance_id !== this.config.endpoint_instance_id)
          reject("ROLE_SCOPE_DENIED");
        this.model.disconnect();
        return {
          operation_id: context.operation_id,
          object_ref: context.object_ref,
          accepted: true,
          source_revision: this.model.snapshot().source_revision,
        };
      case "fault.apply": {
        const input = request.params.input;
        if (
          role !== "supervisor" ||
          input.session_id !== this.config.session_id ||
          input.target_instance_id !== this.config.endpoint_instance_id ||
          input.selection.target !== "endpoint"
        )
          reject("ROLE_SCOPE_DENIED");
        checkDeadline(input.deadline, this.clock);
        if (input.deadline.expires_at_ms > context.deadline.expires_at_ms)
          reject("CLOCK_MAPPING_INVALID");
        this.model.setFault(input.selection);
        if (input.selection.fault === "event_loop_block")
          this.#later(() => {
            const end = Math.min(
              this.clock.now() + input.selection.duration_ms,
              this.model.absoluteDeadline,
            );
            while (this.clock.now() < end) {
              /* Explicit bounded synchronous fault, never a production wait. */
            }
            this.model.tick(false);
          }, 0);
        if (["process_exit", "disconnect"].includes(input.selection.fault))
          this.#later(() => {
            if (input.selection.fault === "process_exit") process.exit(17);
            this.model.disconnect();
            for (const channel of this.#channels.keys()) channel.close();
          }, 20);
        return {
          fault_id: input.fault_id,
          selection: input.selection,
          accepted_at: this.clock.point(),
        };
      }
      default:
        reject("ROLE_SCOPE_DENIED");
    }
  }
  async start(): Promise<void> {
    const path = this.config.safety_socket_path;
    await controlledPath(path, dirname(path), false);
    const server = createServer((socket) =>
      this.accept(
        new JsonChannel(
          socket,
          socket,
          this.config.limits.max_message_bytes,
          this.config.limits.max_pending_requests + ENDPOINT_WIRE_RESERVE,
        ),
        "supervisor",
      ),
    );
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await this.#owned.remember(path);
    await chmod(path, 0o600);
    server.on("error", () => this.model.disconnect());
    this.accept(
      new JsonChannel(
        process.stdin,
        process.stdout,
        this.config.limits.max_message_bytes,
        this.config.limits.max_pending_requests + ENDPOINT_WIRE_RESERVE,
      ),
      "host",
    );
    this.#observe(this.model.snapshot());
    this.#ticker = setInterval(() => {
      this.model.tick();
      if (this.model.finalDeadline !== null && this.clock.now() >= this.model.finalDeadline)
        void this.close();
    }, 5);
  }
  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    // Install before fence observations or asynchronous filesystem cleanup can start.
    const force = setTimeout(() => this.onExit?.(), 100);
    const until = performance.now() + 100;
    this.model.disconnect();
    if (this.#ticker) clearInterval(this.#ticker);
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    for (const channel of this.#channels.keys()) channel.close();
    // The hard bound also covers filesystem cleanup or stderr backpressure.
    if (this.#server) {
      if (await this.#owned.matches(this.config.safety_socket_path)) this.#server.close();
      else this.#server.unref();
    }
    await this.#owned.cleanup();
    await this.observation.finish(Math.max(0, until - performance.now()));
    clearTimeout(force);
    this.onExit?.();
  }
}

export { legacy as endpointLegacyMethods };
