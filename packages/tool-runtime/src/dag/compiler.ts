import type { ToolCall } from "@bellis/contracts";
import type { ToolRegistry } from "../registry/registry.js";
import type { DagCompileIssue, DagCompileResult, DagIssueCode, DagNodePlan } from "../port.js";

/**
 * DAG 编译（phase-3-development-guide.md §8.2）。
 *
 * - 依赖经 ToolCall 扩展键 dependsOn: string[]（toolRunId 列表）表达；
 * - 拒绝：未知工具、重复 toolRunId、缺失依赖、环、依赖 background 节点、
 *   超 8 节点、深度超限（4）、非法 keyed 键参数、参数不过 Draft 7 Schema；
 * - 排序确定性：层内保持模型给出的顺序（输入序），层为拓扑层级；
 * - 依赖失败的节点在调度期得到 dependency_failed（这里只做结构校验）。
 */
export const MAX_DAG_NODES = 8;
export const MAX_DAG_DEPTH = 4;

function readDependsOn(call: ToolCall): string[] {
  const value = (call as { dependsOn?: unknown }).dependsOn;
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return [];
  }
  return value as string[];
}

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

  for (const call of calls) {
    const registered = registry.get(call.toolName);
    if (registered === null) {
      issues.push({ code: "unknown_tool", toolRunId: call.toolRunId, detail: call.toolName });
      continue;
    }
    if (byRunId.has(call.toolRunId)) {
      issues.push({ code: "duplicate_tool_run_id", toolRunId: call.toolRunId });
      continue;
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
    const node: DagNodePlan = {
      call,
      declaration,
      lockKey,
      dependsOn: readDependsOn(call),
    };
    nodes.push(node);
    byRunId.set(call.toolRunId, node);
  }

  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      const target = byRunId.get(dependency);
      if (target === undefined) {
        issues.push({
          code: "dependency_unknown",
          toolRunId: node.call.toolRunId,
          detail: dependency,
        });
      } else if (target.declaration.executionMode === "background") {
        issues.push({
          code: "dependency_on_background",
          toolRunId: node.call.toolRunId,
          detail: dependency,
        });
      }
    }
  }

  // 环检测 + 深度：DFS（确定性，按输入序）。
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const computeDepth = (node: DagNodePlan): number => {
    const memo = depth.get(node.call.toolRunId);
    if (memo !== undefined) {
      return memo;
    }
    if (visiting.has(node.call.toolRunId)) {
      issues.push({
        code: "dependency_cycle",
        toolRunId: node.call.toolRunId,
        detail: [...visiting].join("→"),
      });
      depth.set(node.call.toolRunId, 0);
      return 0;
    }
    visiting.add(node.call.toolRunId);
    let level = 0;
    for (const dependency of node.dependsOn) {
      const target = byRunId.get(dependency);
      if (target !== undefined) {
        level = Math.max(level, computeDepth(target) + 1);
      }
    }
    visiting.delete(node.call.toolRunId);
    depth.set(node.call.toolRunId, level);
    return level;
  };
  for (const node of nodes) {
    const level = computeDepth(node);
    if (level >= MAX_DAG_DEPTH) {
      issues.push({
        code: "depth_exceeded",
        toolRunId: node.call.toolRunId,
        detail: `depth ${level + 1} > ${MAX_DAG_DEPTH}`,
      });
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues, layers: [], nodes: [] };
  }
  const layers: DagNodePlan[][] = [];
  for (const node of nodes) {
    const level = depth.get(node.call.toolRunId) ?? 0;
    while (layers.length <= level) {
      layers.push([]);
    }
    layers[level]?.push(node);
  }
  return { ok: true, issues: [], layers, nodes };
}

export type { DagIssueCode };
