import type { ToolCall, ToolResult, PreparedToolCall } from "@bellis/contracts";
import type { ToolDeclaration } from "./registry/definition.js";

/**
 * Tool Runtime 公开 Port（P0 草案；P3 实现并冻结行为）。
 *
 * 边界（phase-3-development-guide.md §4 / §8）：
 * - 不拥有 Turn/Cycle 状态机，不提交 Scene，不推进水位；
 * - 只读 Tool 统一在 Cycle adoption 成功后启动（Phase 3 初始实现）；
 * - 可变/非幂等 Tool 的执行前提（adoption 已完成）由调用方保证，
 *   Runtime 侧仍独立执行权限与确认检查（fail closed）。
 */

/** Tool 执行上下文：一次 DAG 执行的共享事实与取消域。 */
export interface ToolExecutionContext {
  /** 跨异步边界显式传播的 Trace 根（TraceContext 的 traceId）。 */
  readonly traceId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly cycleId: string;
  /** 父取消域：Turn/Cycle 取消立即传播到等待锁与运行中的 Tool。 */
  readonly signal: AbortSignal;
  /** Session/Profile 当前 Capability 集合（每次运行重新检查）。 */
  readonly capabilities: ReadonlySet<string>;
  /** Cycle 内已分配的幂等键（toolRunId → 调用方声明的 key）。 */
  readonly idempotencyKeys: ReadonlyMap<string, string>;
  /** Runtime 单次 DAG 执行的总并发上限（与注册声明独立）。 */
  readonly maxParallelTools: number;
}

/** Tool 执行器：由装配层注册，与声明分离（声明可序列化，执行器不可）。 */
export type ToolHandler = (input: {
  readonly prepared?: PreparedToolCall;
  readonly arguments: Record<string, unknown>;
  readonly context: ToolExecutionContext;
  readonly deadlineUs: bigint;
  /** 单次调用的幂等键（声明为高风险 Tool 时存在）。 */
  readonly idempotencyKey: string | null;
}) => Promise<{ readonly value: unknown }>;

export interface ToolPreparationHook {
  readonly providerId: string;
  /** Read-only externally: resolve trusted scope/evidence/revision, never dispatch the write. */
  prepare(input: {
    readonly call: ToolCall;
    readonly context: ToolExecutionContext;
    readonly deadlineUs: bigint;
  }): Promise<
    Pick<PreparedToolCall, "idempotencyKey" | "request" | "confirmation" | "policy" | "resources">
  >;
}
export interface ToolPreparationStore {
  load(sessionId: string, toolRunId: string): Promise<PreparedToolCall | null>;
  /** Write once; exact replay also revalidates the current persisted policy. */
  save(value: PreparedToolCall): Promise<void>;
}

export type DagIssueCode =
  | "dependencies_unsupported"
  | "unknown_tool"
  | "duplicate_tool_run_id"
  | "dependency_unknown"
  | "dependency_cycle"
  | "dependency_on_background"
  | "too_many_nodes"
  | "depth_exceeded"
  | "keyed_argument_invalid"
  | "arguments_invalid";

export interface DagCompileIssue {
  readonly code: DagIssueCode;
  readonly toolRunId: string;
  readonly detail?: string;
}

export interface DagNodePlan {
  readonly call: ToolCall;
  readonly declaration: ToolDeclaration;
  /** 归一化资源键：exclusive → resource；keyed → resource:key 值。 */
  readonly lockKey: string | null;
  readonly dependsOn: readonly string[];
}

export interface DagCompileResult {
  readonly ok: boolean;
  readonly issues: readonly DagCompileIssue[];
  /** 兼容旧调用方的单层视图；当前计划无显式依赖。 */
  readonly layers: readonly (readonly DagNodePlan[])[];
  readonly nodes: readonly DagNodePlan[];
}

/** 一次独立调用列表执行的结果：每个 toolRunId 至多一条 ToolResult。 */
export interface ToolDagExecution {
  readonly results: readonly ToolResult[];
  /** background 任务的 done（不阻塞下一 Cycle；Session 关闭时等待）。 */
  readonly background: readonly Promise<ToolResult>[];
}

/**
 * Tool Runtime 主 Port。实现必须保证：
 * - registerTool 在声明矛盾时抛错（注册期失败，不延迟到调用期）；
 * - execute 只在调用方（Decision Loop）确认 adoption 成功后调用；
 * - 返回的 results 顺序确定性（按 DAG 拓扑序）。
 */
export interface ToolRuntime {
  registerTool(
    declaration: ToolDeclaration,
    handler: ToolHandler,
    preparation?: ToolPreparationHook,
  ): void;
  hasTool(name: string): boolean;
  listDeclarations(): readonly ToolDeclaration[];
  /**
   * Draft 7 Schema 校验（Stream Assembler 的候选调用门槛）：
   * 名称不存在 → ok:false（unknown_tool 由调用方区分）。
   */
  validateArguments(
    toolName: string,
    args: Record<string, unknown>,
  ): { readonly ok: true } | { readonly ok: false; readonly error: string };
  compileDag(calls: readonly ToolCall[]): DagCompileResult;
  executeDag(dag: DagCompileResult, context: ToolExecutionContext): Promise<ToolDagExecution>;
  close(reason: string): Promise<void>;
}
