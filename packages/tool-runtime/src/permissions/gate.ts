import { createHash } from "node:crypto";
import type { ToolDeclaration } from "../registry/definition.js";
import type { ToolExecutionContext } from "../port.js";

/**
 * 权限与副作用门（phase-3-development-guide.md §8.4）。
 * 模型选择 Tool 不等于获得权限：每次运行重新检查 Capability；
 * confirm 型工具在没有 Confirmation Port 装配时 fail closed；
 * 非幂等工具必须携带幂等键；结果校验失败不能声称成功。
 */
export type PermissionVerdict =
  | { readonly allowed: true; readonly idempotencyKey: string | null }
  | { readonly allowed: false; readonly errorCode: string; readonly detail: string };

/** 确认 Port：Phase 3 无交互装配时确认型工具必须拒绝。 */
export interface ConfirmationPort {
  confirm(request: {
    readonly toolName: string;
    readonly toolRunId: string;
    readonly cycleId: string;
  }): Promise<boolean>;
}

export function checkPermission(
  declaration: ToolDeclaration,
  context: ToolExecutionContext,
  idempotencyKeyFromCall: string | undefined,
  confirmation: ConfirmationPort | null,
): PermissionVerdict {
  for (const capability of declaration.requiredCapabilities) {
    if (!context.capabilities.has(capability)) {
      return {
        allowed: false,
        errorCode: "capability_missing",
        detail: capability,
      };
    }
  }
  if (declaration.requiresConfirmation && confirmation === null) {
    return {
      allowed: false,
      errorCode: "confirmation_unavailable",
      detail: "no confirmation port assembled; confirm tools fail closed",
    };
  }
  if (declaration.semantic === "non_idempotent") {
    if (idempotencyKeyFromCall === undefined || idempotencyKeyFromCall.length === 0) {
      return {
        allowed: false,
        errorCode: "idempotency_key_required",
        detail: "non-idempotent tools must declare an idempotencyKey",
      };
    }
    return {
      allowed: true,
      idempotencyKey: idempotencyKeyFromCall,
    };
  }
  return {
    allowed: true,
    idempotencyKey: idempotencyKeyFromCall ?? null,
  };
}

/** 幂等键摘要（审计只存 SHA-256，不存键本身）。 */
export function hashIdempotencyKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
