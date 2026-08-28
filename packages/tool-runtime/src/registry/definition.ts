import type { JsonValue, ToolExecutionMode, ToolSemantic } from "@bellis/contracts";

/**
 * Tool 声明：注册期冻结的静态形态（phase-3-development-guide.md §8.1 /
 * P0 冻结语义 6）。同名冲突、非法 Schema、无界 Timeout 或声明矛盾
 * 必须在注册期失败——不等模型调用后才猜测。
 *
 * 声明矛盾（注册期全部拒绝）：
 * - pure 只能 parallel_read / keyed，且不得要求确认（只读无副作用）；
 * - non_idempotent 不得声明缓存（缓存只允许 pure / idempotent）；
 * - background 不得要求确认（无人等待确认结果）；
 * - exclusive 必须声明 resource；keyed 必须声明 keyArgument；
 *   parallel_read 不得声明 resource/keyArgument（无资源冲突）。
 */

/** Tool 名称目录：^[a-z][a-z0-9_]{0,63}$（模型可见、日志 label 安全）。 */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** Timeout 与输出预算的注册期上限（无界声明直接拒绝）。 */
export const TOOL_MAX_TIMEOUT_MS = 120_000;
export const TOOL_MAX_OUTPUT_BYTES = 1_000_000;

/** 缓存策略：L1 Runtime LRU / L2 SQLite TTL；revision 参与 L2 缓存键。 */
export interface ToolCachePolicy {
  readonly l1: boolean;
  readonly l2: boolean;
  readonly ttlMs: number;
  /** 配置/实现修订号：过期或 revision 不符立即失效。 */
  readonly revision: string;
}

export interface ToolDeclaration {
  readonly name: string;
  /** 递增版本号；语义变化必须升版（缓存键包含版本）。 */
  readonly version: number;
  /** 模型可见说明（1–1024 字符）。 */
  readonly description: string;
  /** JSON Schema Draft 7 输入 Schema（对象形态）。 */
  readonly inputSchema: JsonValue;
  readonly outputMaxBytes: number;
  /** 敏感输出字段路径：进入模型/日志前脱敏。 */
  readonly sensitiveOutputFields: readonly string[];
  readonly executionMode: ToolExecutionMode;
  readonly semantic: ToolSemantic;
  /** exclusive 模式的资源名；其它模式为 null。 */
  readonly resource: string | null;
  /** keyed 模式的归一化键参数名；其它模式为 null。 */
  readonly keyArgument: string | null;
  readonly timeoutMs: number;
  readonly cancellable: boolean;
  readonly maxConcurrency: number;
  readonly requiredCapabilities: readonly string[];
  readonly requiresConfirmation: boolean;
  readonly cache: ToolCachePolicy | null;
}

export type ToolDeclarationIssue =
  | "name_invalid"
  | "version_invalid"
  | "description_invalid"
  | "input_schema_invalid"
  | "output_budget_invalid"
  | "execution_mode_conflict"
  | "semantic_conflict"
  | "cache_conflict"
  | "timeout_invalid"
  | "concurrency_invalid"
  | "capabilities_invalid"
  | "sensitive_fields_invalid";

export interface ToolDeclarationCheck {
  readonly ok: boolean;
  readonly issues: readonly ToolDeclarationIssue[];
}

export function checkToolDeclaration(declaration: ToolDeclaration): ToolDeclarationCheck {
  const issues: ToolDeclarationIssue[] = [];
  if (!TOOL_NAME_PATTERN.test(declaration.name)) {
    issues.push("name_invalid");
  }
  if (!Number.isInteger(declaration.version) || declaration.version < 1) {
    issues.push("version_invalid");
  }
  if (
    typeof declaration.description !== "string" ||
    declaration.description.length < 1 ||
    declaration.description.length > 1024
  ) {
    issues.push("description_invalid");
  }
  if (
    typeof declaration.inputSchema !== "object" ||
    declaration.inputSchema === null ||
    Array.isArray(declaration.inputSchema)
  ) {
    issues.push("input_schema_invalid");
  }
  if (
    !Number.isInteger(declaration.outputMaxBytes) ||
    declaration.outputMaxBytes < 1 ||
    declaration.outputMaxBytes > TOOL_MAX_OUTPUT_BYTES
  ) {
    issues.push("output_budget_invalid");
  }
  if (declaration.sensitiveOutputFields.some((field) => field.length === 0 || field.length > 128)) {
    issues.push("sensitive_fields_invalid");
  }
  switch (declaration.executionMode) {
    case "exclusive":
      if (declaration.resource === null || declaration.resource.length === 0) {
        issues.push("execution_mode_conflict");
      }
      break;
    case "keyed":
      if (declaration.keyArgument === null || declaration.keyArgument.length === 0) {
        issues.push("execution_mode_conflict");
      }
      break;
    case "parallel_read":
      if (declaration.resource !== null || declaration.keyArgument !== null) {
        issues.push("execution_mode_conflict");
      }
      break;
    case "background":
      if (declaration.resource !== null || declaration.keyArgument !== null) {
        issues.push("execution_mode_conflict");
      }
      if (declaration.requiresConfirmation) {
        issues.push("execution_mode_conflict");
      }
      break;
  }
  if (declaration.semantic === "pure") {
    if (declaration.executionMode !== "parallel_read" && declaration.executionMode !== "keyed") {
      issues.push("semantic_conflict");
    }
    if (declaration.requiresConfirmation) {
      issues.push("semantic_conflict");
    }
  }
  if (declaration.semantic === "non_idempotent" && declaration.cache !== null) {
    issues.push("cache_conflict");
  }
  if (declaration.cache !== null) {
    if (
      !Number.isInteger(declaration.cache.ttlMs) ||
      declaration.cache.ttlMs < 1 ||
      declaration.cache.revision.length === 0
    ) {
      issues.push("cache_conflict");
    }
    if (!declaration.cache.l1 && !declaration.cache.l2) {
      issues.push("cache_conflict");
    }
  }
  if (
    !Number.isInteger(declaration.timeoutMs) ||
    declaration.timeoutMs < 1 ||
    declaration.timeoutMs > TOOL_MAX_TIMEOUT_MS
  ) {
    issues.push("timeout_invalid");
  }
  if (
    !Number.isInteger(declaration.maxConcurrency) ||
    declaration.maxConcurrency < 1 ||
    declaration.maxConcurrency > 64
  ) {
    issues.push("concurrency_invalid");
  }
  if (
    declaration.requiredCapabilities.some(
      (capability) => capability.length === 0 || capability.length > 64,
    )
  ) {
    issues.push("capabilities_invalid");
  }
  return { ok: issues.length === 0, issues };
}
