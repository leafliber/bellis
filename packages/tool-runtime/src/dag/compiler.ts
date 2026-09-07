import type { ToolCall } from "@bellis/contracts";
import type { ToolRegistry } from "../registry/registry.js";
import type { DagCompileIssue, DagCompileResult, DagIssueCode, DagNodePlan } from "../port.js";
import { frozenJsonCopy } from "../registry/frozen-json.js";

/** Independent call-plan validation. Legacy DAG API names remain for source compatibility.
 * Explicit dependencies are rejected; dependent work belongs to the next Cycle.
 */
export const MAX_DAG_NODES = 8;
/** @deprecated Only independent calls are supported. */
export const MAX_DAG_DEPTH = 1;

export function compileDag(registry: ToolRegistry, calls: readonly ToolCall[]): DagCompileResult {
  const issues: DagCompileIssue[] = [];
  const nodes: DagNodePlan[] = [];
  const byRunId = new Map<string, DagNodePlan>();

  if (calls.length > MAX_DAG_NODES) {
    issues.push({
      code: "too_many_nodes",
      toolRunId: calls[MAX_DAG_NODES]?.toolRunId ?? "?",
      detail: `${calls.length} > ${MAX_DAG_NODES}`,
    });
  }

  for (const input of calls) {
    let call: ToolCall;
    try {
      call = frozenJsonCopy(input);
    } catch {
      issues.push({ code: "arguments_invalid", toolRunId: input.toolRunId });
      continue;
    }
    const registered = registry.get(call.toolName);
    if (registered === null) {
      issues.push({ code: "unknown_tool", toolRunId: call.toolRunId, detail: call.toolName });
      continue;
    }
    if (byRunId.has(call.toolRunId)) {
      issues.push({ code: "duplicate_tool_run_id", toolRunId: call.toolRunId });
      continue;
    }
    const dependencies = (call as { dependsOn?: unknown }).dependsOn;
    if (dependencies !== undefined && (!Array.isArray(dependencies) || dependencies.length > 0)) {
      issues.push({
        code: "dependencies_unsupported",
        toolRunId: call.toolRunId,
        detail: "Use the next decision cycle for dependent tool calls",
      });
    }
    const declaration = registered.declaration;
    let lockKey: string | null = null;
    if (declaration.executionMode === "exclusive") {
      lockKey = `exclusive:${declaration.resource}`;
    } else if (declaration.executionMode === "keyed") {
      const rawKey = (call.arguments as Record<string, unknown>)[declaration.keyArgument ?? ""];
      if (rawKey === undefined || typeof rawKey === "object" || rawKey === null) {
        issues.push({
          code: "keyed_argument_invalid",
          toolRunId: call.toolRunId,
          detail: `missing key argument ${declaration.keyArgument}`,
        });
        continue;
      }
      lockKey = `keyed:${declaration.name}:${String(rawKey).normalize("NFKC").toLowerCase()}`;
    }
    const node: DagNodePlan = Object.freeze({
      call,
      declaration,
      lockKey,
      dependsOn: Object.freeze([]),
    });
    nodes.push(node);
    byRunId.set(call.toolRunId, node);
  }

  Object.freeze(nodes);
  return Object.freeze({
    ok: issues.length === 0,
    issues: Object.freeze(issues),
    layers: Object.freeze(issues.length === 0 && nodes.length > 0 ? [nodes] : []),
    nodes: issues.length === 0 ? nodes : [],
  });
}

export type { DagIssueCode };
