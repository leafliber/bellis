import { errors } from "../../../contracts/generated/registries.ts";
import {
  assertValid,
  type CommandContext,
  type ReasonCode,
  type RpcFailure,
} from "../../contract-sdk/src/index.ts";

export class RuntimeRejection extends Error {
  readonly reason: ReasonCode;
  constructor(reason: ReasonCode) {
    super(reason);
    this.reason = reason;
  }
}

export function reject(reason: ReasonCode): never {
  throw new RuntimeRejection(reason);
}

export function businessFailure(
  id: string,
  context: CommandContext,
  reason: ReasonCode,
): RpcFailure {
  const entry = errors.errors.find((item) => item.reason_code === reason);
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
        phase: "P0",
        operation_id: context.operation_id,
        retry_disposition: entry.retry_disposition,
        safe_message: reason,
        evidence_refs: [],
      },
    },
  };
  assertValid("RpcFailure", response);
  return response;
}

export function protocolFailure(
  id: string | null,
  code: -32700 | -32600 | -32601 | -32602 | -32603,
): RpcFailure {
  const message = {
    [-32700]: "Parse error",
    [-32600]: "Invalid Request",
    [-32601]: "Method not found",
    [-32602]: "Invalid params",
    [-32603]: "Internal error",
  }[code];
  return { jsonrpc: "2.0", id, error: { code, message, data: null } };
}
