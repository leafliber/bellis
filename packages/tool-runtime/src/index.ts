/**
 * @bellis/tool-runtime — Tool Registry、DAG 编译、并行调度、资源锁、
 * 权限与缓存（Phase 3 / P3）。
 *
 * 公开导出只从本包根暴露；不依赖 Decision Loop 状态机、Scene Runtime
 * 或 Runtime Route。
 */
export {
  TOOL_MAX_OUTPUT_BYTES,
  TOOL_MAX_TIMEOUT_MS,
  TOOL_NAME_PATTERN,
  checkToolDeclaration,
} from "./registry/definition.js";
export type {
  ToolCachePolicy,
  ToolDeclaration,
  ToolDeclarationCheck,
  ToolDeclarationIssue,
} from "./registry/definition.js";
export { buildToolModelSpec } from "./registry/model-spec.js";
export type { ToolModelSpec } from "./registry/model-spec.js";
export { ToolRegistry } from "./registry/registry.js";
export type { RegisteredTool } from "./registry/registry.js";
export { MAX_DAG_DEPTH, MAX_DAG_NODES, compileDag } from "./dag/compiler.js";
export { checkPermission, hashIdempotencyKey } from "./permissions/gate.js";
export type {
  ConfirmationPort,
  ToolConfirmationRequest,
  PermissionVerdict,
} from "./permissions/gate.js";
export { ToolCache, stableStringify } from "./cache/tool-cache.js";
export type { ToolCacheStore } from "./cache/tool-cache.js";
export { StandardToolRuntime } from "./runtime.js";
export type { StandardToolRuntimeOptions, ToolRunEvent } from "./runtime.js";
export type {
  DagCompileIssue,
  DagCompileResult,
  DagIssueCode,
  DagNodePlan,
  ToolDagExecution,
  ToolExecutionContext,
  ToolHandler,
  ToolPreparationHook,
  ToolPreparationStore,
  ToolRuntime,
} from "./port.js";

export { ToolRejectedError } from "./permissions/rejection.js";
