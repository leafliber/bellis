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
export type {
  DagCompileIssue,
  DagCompileResult,
  DagIssueCode,
  DagNodePlan,
  ToolDagExecution,
  ToolExecutionContext,
  ToolHandler,
  ToolRuntime,
} from "./port.js";
