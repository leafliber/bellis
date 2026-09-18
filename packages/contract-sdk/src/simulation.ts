import { commands, errors } from "../../../contracts/generated/registries.ts";
import type { ControllerManifest, RpcFailure, RpcRequest } from "./index.ts";
import {
  assertValid,
  parseJson,
  payloadDigest,
  schemaDigest,
  validate,
  validateManifest,
  validateRpcResponse,
} from "./index.ts";

const transportError = (
  id: string | null,
  code: -32700 | -32600 | -32601 | -32602,
  message: string,
) => {
  const response: RpcFailure = { jsonrpc: "2.0", id, error: { code, message, data: null } };
  assertValid("RpcFailure", response);
  return JSON.stringify(response);
};

/** In-memory protocol fixture; never opens devices or executes effectful methods. */
export class SimulationEndpoint {
  #manifest: ControllerManifest;
  #caller: string | null = null;
  #operations = new Map<string, { digest: string; contextDigest: string; result: unknown }>();
  #now: () => number;

  constructor(manifest: ControllerManifest, now: () => number) {
    this.#manifest = structuredClone(validateManifest(manifest));
    if (this.#manifest.execution_mode !== "simulation") throw new Error("SIMULATION_ONLY");
    this.#now = now;
  }

  exchange(wire: string): string {
    let raw: unknown;
    try {
      raw = parseJson(wire);
    } catch {
      return transportError(null, -32700, "Parse error");
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return transportError(null, -32600, "Invalid Request");
    const envelope = raw as Record<string, unknown>;
    const id =
      typeof envelope.id === "string" && envelope.id.length > 0 && envelope.id.length <= 256
        ? envelope.id
        : null;
    if (envelope.jsonrpc !== "2.0" || id === null || typeof envelope.method !== "string")
      return transportError(id, -32600, "Invalid Request");
    const method = commands.commands.find((c) => c.name === envelope.method);
    if (!method) return transportError(id, -32601, "Method not found");
    if (!validate("RpcRequest", raw)) return transportError(id, -32602, "Invalid params");
    const request: RpcRequest = raw;
    const { context, input } = request.params;
    const fail = (reason: (typeof errors.errors)[number]["reason_code"]): string => {
      const entry = errors.errors.find((e) => e.reason_code === reason);
      if (!entry) throw new Error("UNREGISTERED_ERROR");
      const response: RpcFailure = {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: reason,
          data: {
            category: entry.category,
            reason_code: reason,
            object_ref: context.object_ref,
            phase: "simulation",
            operation_id: context.operation_id,
            retry_disposition: entry.retry_disposition,
            safe_message: reason,
            evidence_refs: [],
          },
        },
      };
      validateRpcResponse(request.method, response);
      return JSON.stringify(response);
    };
    const digest = payloadDigest({ method: request.method, input });
    const contextDigest = payloadDigest(context);
    if (context.payload_digest !== digest) return fail("OPERATION_PAYLOAD_CONFLICT");
    const now = this.#now();
    if (context.deadline.clock_domain !== "simulation") return fail("COMMAND_CLOCK_MISMATCH");
    if (
      context.deadline.issued_at_ms > now ||
      context.deadline.expires_at_ms <= context.deadline.issued_at_ms
    )
      return fail("TIMEOUT_INVALID");
    if (context.deadline.expires_at_ms <= now) return fail("COMMAND_DEADLINE_MISSED");
    if (request.method !== "plugin.handshake" && this.#caller === null)
      return fail("AUTHENTICATION_REQUIRED");
    if (this.#caller !== null && context.caller_instance_id !== this.#caller)
      return fail("AUTHENTICATION_REQUIRED");
    const prior = this.#operations.get(context.operation_id);
    if (prior && (prior.digest !== digest || prior.contextDigest !== contextDigest))
      return fail("OPERATION_PAYLOAD_CONFLICT");
    if (prior) return JSON.stringify({ jsonrpc: "2.0", id, result: prior.result });
    if (this.#operations.size >= 128) return fail("QUEUE_LIMIT_EXCEEDED");
    let result: unknown;
    if (request.method === "plugin.handshake") {
      assertValid("HandshakeInput", input);
      if (
        input.host_instance_id !== context.caller_instance_id ||
        input.schema_digest !== schemaDigest
      )
        return fail("CONTRACT_REFERENCE_INVALID");
      this.#caller = input.host_instance_id;
      result = {
        connection_id: "simulation-connection",
        plugin_instance_id: "simulation-plugin",
        protocol_version: "0.8.0",
        schema_digest: schemaDigest,
        manifest: this.#manifest,
      };
    } else if (request.method === "plugin.describe") {
      result = this.#manifest;
    } else if (method.unsupported_reason) {
      return fail(method.unsupported_reason);
    } else {
      return transportError(id, -32601, "Method not available in simulation");
    }
    const response = { jsonrpc: "2.0", id, result };
    validateRpcResponse(request.method, response);
    this.#operations.set(context.operation_id, { digest, contextDigest, result });
    return JSON.stringify(response);
  }
}
