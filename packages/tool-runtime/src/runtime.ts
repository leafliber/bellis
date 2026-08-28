import type { MonotonicClock, ToolResult } from "@bellis/contracts";
import type {
  DagCompileResult,
  DagNodePlan,
  ToolDagExecution,
  ToolExecutionContext,
  ToolHandler,
} from "./port.js";
import type { ToolRuntime } from "./port.js";
import type { ToolDeclaration } from "./registry/definition.js";
import { ToolRegistry } from "./registry/registry.js";
import { compileDag } from "./dag/compiler.js";
import { checkPermission, hashIdempotencyKey, type ConfirmationPort } from "./permissions/gate.js";
import { ToolCache, type ToolCacheStore, stableStringify } from "./cache/tool-cache.js";
import type { LoggerPort, MetricsPort } from "@bellis/observability";
import type { JsonValue, ToolCall } from "@bellis/contracts";
import { createRequire } from "node:module";

/**
 * 标准 Tool Runtime（phase-3-development-guide.md §8.3）。
 *
 * - 无依赖 parallel_read 并行；exclusive 同资源串行；keyed 同归一化键串行；
 * - Runtime 总并发、每 Tool 并发、锁等待全部有界（Deadline/Abort 控制，
 *   取消后立即从队列移除——不是裸 Promise race，失败分支真正 Abort）；
 * - 返回前做 JSON-safe、大小、敏感字段处理；超限结构化截断；
 * - background 不阻塞下一 Cycle（结果经 background Promise 交付）。
 */

/** ajv 的 CJS 默认导出在 nodenext 下的最小本地接口（同 contracts 测试）。 */
interface AjvLike {
  compile(schema: object): (data: unknown) => boolean;
}
const require = createRequire(import.meta.url);
const AjvCtor = require("ajv") as unknown as new () => AjvLike;

export interface ToolRunEvent {
  readonly toolRunId: string;
  readonly cycleId: string;
  readonly toolName: string;
  readonly transition: "planned" | "started" | "finished";
  readonly state?:
    | "succeeded"
    | "failed"
    | "timeout"
    | "cancelled"
    | "denied"
    | "dependency_failed";
  readonly durationMs?: number;
  readonly errorCode?: string;
  readonly idempotencyKeyHash?: string;
}

export interface StandardToolRuntimeOptions {
  readonly clock: MonotonicClock;
  readonly wallClockMs: () => number;
  readonly registry?: ToolRegistry;
  readonly cache?: ToolCache;
  readonly cacheStore?: ToolCacheStore | null;
  readonly confirmation?: ConfirmationPort | null;
  readonly logger?: LoggerPort;
  readonly metrics?: MetricsPort;
  readonly onRunEvent?: (event: ToolRunEvent) => void;
}

type NodeState = "pending" | "running" | "done";

export class StandardToolRuntime implements ToolRuntime {
  readonly #options: StandardToolRuntimeOptions;
  readonly #registry: ToolRegistry;
  readonly #cache: ToolCache;
  readonly #ajv: AjvLike;
  readonly #validators = new Map<string, (data: unknown) => boolean>();
  #closed = false;
  #inFlight = new Set<Promise<unknown>>();

  constructor(options: StandardToolRuntimeOptions) {
    this.#options = options;
    this.#registry = options.registry ?? new ToolRegistry();
    this.#cache =
      options.cache ??
      new ToolCache({ wallClockMs: options.wallClockMs, l2: options.cacheStore ?? null });
    this.#ajv = new AjvCtor();
  }

  registerTool(declaration: ToolDeclaration, handler: ToolHandler): void {
    this.#registry.register(declaration, handler);
    this.#validators.delete(declaration.name);
  }

  hasTool(name: string): boolean {
    return this.#registry.has(name);
  }

  listDeclarations(): readonly ToolDeclaration[] {
    return this.#registry.list();
  }

  validateArguments(
    toolName: string,
    args: Record<string, unknown>,
  ): { readonly ok: true } | { readonly ok: false; readonly error: string } {
    const tool = this.#registry.get(toolName);
    if (tool === null) {
      return { ok: false, error: `unknown tool ${toolName}` };
    }
    let validate = this.#validators.get(toolName);
    if (validate === undefined) {
      validate = this.#ajv.compile(tool.declaration.inputSchema as object);
      this.#validators.set(toolName, validate);
    }
    if (!validate(args)) {
      return { ok: false, error: `arguments do not match schema for ${toolName}` };
    }
    return { ok: true };
  }

  compileDag(calls: readonly ToolCall[]): DagCompileResult {
    return compileDag(this.#registry, calls);
  }

  async close(reason: string): Promise<void> {
    this.#closed = true;
    await Promise.allSettled(this.#inFlight);
    void reason;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  async executeDag(
    dag: DagCompileResult,
    context: ToolExecutionContext,
  ): Promise<ToolDagExecution> {
    if (!dag.ok) {
      throw new Error("executeDag requires a compiled DAG (compileDag ok)");
    }
    if (this.#closed) {
      throw new Error("tool runtime is closed");
    }
    const l0 = new Map<string, JsonValue>();
    const states = new Map<string, NodeState>();
    const results = new Map<string, ToolResult>();
    const heldLocks = new Set<string>();
    const toolRunning = new Map<string, number>();
    const startedAtUs = new Map<string, bigint>();
    const pending: DagNodePlan[] = [...dag.nodes];
    for (const node of dag.nodes) {
      states.set(node.call.toolRunId, "pending");
      this.#options.onRunEvent?.({
        toolRunId: node.call.toolRunId,
        cycleId: context.cycleId,
        toolName: node.call.toolName,
        transition: "planned",
      });
    }

    const backgroundWaiters = new Map<string, (() => void)[]>();
    const notifyBackground = (toolRunId: string): void => {
      const waiters = backgroundWaiters.get(toolRunId);
      if (waiters !== undefined) {
        backgroundWaiters.delete(toolRunId);
        for (const waiter of waiters) {
          waiter();
        }
      }
    };

    const nodeFlights = new Map<string, Promise<ToolResult>>();
    const startNode = async (node: DagNodePlan): Promise<void> => {
      // L0 single-flight：同 Cycle 内相同归一化输入的并行节点共享一次
      // 执行与结果处理（结果按各自 toolRunId 复制）。
      const dedupeKey = ToolCache.cacheable(node.declaration)
        ? ToolCache.keyOf(node.declaration, node.call.arguments as Record<string, unknown>)
        : null;
      if (dedupeKey !== null) {
        const existing = nodeFlights.get(dedupeKey);
        if (existing !== undefined) {
          const shared = await existing;
          const result: ToolResult = {
            schemaVersion: 1,
            toolRunId: node.call.toolRunId,
            toolName: shared.toolName,
            outcome: shared.outcome,
            truncated: shared.truncated,
            ...(shared.value === undefined ? {} : { value: shared.value }),
            ...(shared.errorCode === undefined ? {} : { errorCode: shared.errorCode }),
            ...(shared.outcome === "succeeded" ? { cacheSource: "l0" as const } : {}),
          };
          states.set(node.call.toolRunId, "done");
          results.set(node.call.toolRunId, result);
          notifyBackground(node.call.toolRunId);
          return;
        }
      }
      states.set(node.call.toolRunId, "running");
      startedAtUs.set(node.call.toolRunId, this.#options.clock.nowUs());
      if (node.lockKey !== null) {
        heldLocks.add(node.lockKey);
      }
      toolRunning.set(node.call.toolName, (toolRunning.get(node.call.toolName) ?? 0) + 1);
      this.#options.onRunEvent?.({
        toolRunId: node.call.toolRunId,
        cycleId: context.cycleId,
        toolName: node.call.toolName,
        transition: "started",
      });
      const run = this.#runNode(node, context, l0);
      if (dedupeKey !== null) {
        nodeFlights.set(dedupeKey, run);
        void run.finally(() => nodeFlights.delete(dedupeKey)).catch(() => undefined);
      }
      const result = await run;
      const startedUs = startedAtUs.get(node.call.toolRunId) ?? 0n;
      const durationMs = Number((this.#options.clock.nowUs() - startedUs) / 1000n);
      if (node.lockKey !== null) {
        heldLocks.delete(node.lockKey);
      }
      toolRunning.set(
        node.call.toolName,
        Math.max(0, (toolRunning.get(node.call.toolName) ?? 1) - 1),
      );
      states.set(node.call.toolRunId, "done");
      results.set(node.call.toolRunId, result);
      notifyBackground(node.call.toolRunId);
      this.#options.metrics
        ?.counter("bellis_tool_runs_total", {
          tool: node.declaration.name,
          result: result.outcome,
          cache: result.cacheSource === undefined ? "miss" : result.cacheSource,
        })
        .inc();
      this.#options.metrics
        ?.histogram("bellis_tool_duration_ms", {
          tool: node.declaration.name,
          result: result.outcome,
        })
        .observe(durationMs);
      this.#options.onRunEvent?.({
        toolRunId: node.call.toolRunId,
        cycleId: context.cycleId,
        toolName: node.call.toolName,
        transition: "finished",
        ...(result.outcome === "succeeded"
          ? { state: "succeeded" as const }
          : { state: result.outcome as "failed" | "timeout" | "cancelled" | "denied" }),
        durationMs,
        ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
        ...(node.call.idempotencyKey === undefined
          ? {}
          : { idempotencyKeyHash: hashIdempotencyKey(node.call.idempotencyKey) }),
      });
    };

    const pump = (): void => {
      if (context.signal.aborted) {
        // 取消优先：未启动节点一律 cancelled（不给依赖失败结算）。
        for (const node of pending) {
          states.set(node.call.toolRunId, "done");
          results.set(node.call.toolRunId, {
            schemaVersion: 1,
            toolRunId: node.call.toolRunId,
            toolName: node.call.toolName,
            outcome: "cancelled",
            truncated: false,
          });
          notifyBackground(node.call.toolRunId);
        }
        pending.length = 0;
        return;
      }
      for (const node of pending.slice()) {
        if (states.get(node.call.toolRunId) !== "pending") {
          continue;
        }
        // 依赖失败（或依赖结果非 succeeded）→ dependency_failed，不读取不存在结果。
        const dependencies = node.dependsOn
          .map((id) => results.get(id))
          .filter((value): value is ToolResult => value !== undefined);
        const allResolved = node.dependsOn.every((id) => results.has(id));
        if (allResolved && dependencies.some((dep) => dep.outcome !== "succeeded")) {
          pending.splice(pending.indexOf(node), 1);
          states.set(node.call.toolRunId, "done");
          const failed: ToolResult = {
            schemaVersion: 1,
            toolRunId: node.call.toolRunId,
            toolName: node.call.toolName,
            outcome: "dependency_failed",
            errorCode: "dependency_failed",
            truncated: false,
          };
          results.set(node.call.toolRunId, failed);
          notifyBackground(node.call.toolRunId);
          this.#options.onRunEvent?.({
            toolRunId: node.call.toolRunId,
            cycleId: context.cycleId,
            toolName: node.call.toolName,
            transition: "finished",
            state: "dependency_failed",
          });
          continue;
        }
        if (!allResolved) {
          continue;
        }
        const total = [...states.values()].filter((state) => state === "running").length;
        if (total >= context.maxParallelTools) {
          break;
        }
        const toolCount = toolRunning.get(node.call.toolName) ?? 0;
        if (toolCount >= node.declaration.maxConcurrency) {
          continue;
        }
        if (node.lockKey !== null && heldLocks.has(node.lockKey)) {
          continue;
        }
        pending.splice(pending.indexOf(node), 1);
        const run = startNode(node);
        this.#inFlight.add(run);
        void run.finally(() => this.#inFlight.delete(run)).catch(() => undefined);
      }
    };

    const foregroundDone = (): boolean =>
      dag.nodes
        .filter((node) => node.declaration.executionMode !== "background")
        .every((node) => states.get(node.call.toolRunId) === "done");

    pump();
    while (!foregroundDone()) {
      if (context.signal.aborted) {
        // 取消：未启动节点立即 cancelled，运行中的由各自 Abort 域结算。
        for (const node of pending) {
          states.set(node.call.toolRunId, "done");
          results.set(node.call.toolRunId, {
            schemaVersion: 1,
            toolRunId: node.call.toolRunId,
            toolName: node.call.toolName,
            outcome: "cancelled",
            truncated: false,
          });
          notifyBackground(node.call.toolRunId);
        }
        pending.length = 0;
      }
      if (this.#inFlight.size === 0) {
        // 无可推进且无在途：死锁防御（理论不可达——环已在编译期拒绝）。
        for (const node of pending) {
          states.set(node.call.toolRunId, "done");
          results.set(node.call.toolRunId, {
            schemaVersion: 1,
            toolRunId: node.call.toolRunId,
            toolName: node.call.toolName,
            outcome: "failed",
            errorCode: "scheduler_stalled",
            truncated: false,
          });
          notifyBackground(node.call.toolRunId);
        }
        pending.length = 0;
        break;
      }
      // 等待任一在途节点结算后再推进（真实等待，非忙等）。
      await Promise.race(this.#inFlight);
      pump();
    }

    const foreground = dag.nodes
      .filter((node) => node.declaration.executionMode !== "background")
      .map((node) => results.get(node.call.toolRunId))
      .filter((value): value is ToolResult => value !== undefined);
    const background = dag.nodes
      .filter((node) => node.declaration.executionMode === "background")
      .map(
        (node) =>
          new Promise<ToolResult>((resolve) => {
            const settled = results.get(node.call.toolRunId);
            if (settled !== undefined) {
              resolve(settled);
              return;
            }
            const waiters = backgroundWaiters.get(node.call.toolRunId) ?? [];
            waiters.push(() => {
              const result = results.get(node.call.toolRunId);
              if (result !== undefined) {
                resolve(result);
              }
            });
            backgroundWaiters.set(node.call.toolRunId, waiters);
          }),
      );
    return { results: foreground, background };
  }

  async #runNode(
    node: DagNodePlan,
    context: ToolExecutionContext,
    l0: Map<string, JsonValue>,
  ): Promise<ToolResult> {
    const declaration = node.declaration;
    const call = node.call;
    const permission = checkPermission(
      declaration,
      context,
      call.idempotencyKey,
      this.#options.confirmation ?? null,
    );
    if (!permission.allowed) {
      this.#options.logger?.log("warn", "tool_permission_denied", {
        toolRunId: call.toolRunId,
        tool: declaration.name,
        code: permission.errorCode,
      });
      return {
        schemaVersion: 1,
        toolRunId: call.toolRunId,
        toolName: call.toolName,
        outcome: "denied",
        errorCode: permission.errorCode,
        truncated: false,
      };
    }
    const argsCheck = this.validateArguments(
      call.toolName,
      call.arguments as Record<string, unknown>,
    );
    if (!argsCheck.ok) {
      return {
        schemaVersion: 1,
        toolRunId: call.toolRunId,
        toolName: call.toolName,
        outcome: "failed",
        errorCode: "arguments_invalid",
        truncated: false,
      };
    }
    const confirmation = this.#options.confirmation ?? null;
    if (declaration.requiresConfirmation && confirmation !== null) {
      const confirmed = await confirmation.confirm({
        toolName: declaration.name,
        toolRunId: call.toolRunId,
        cycleId: context.cycleId,
      });
      if (!confirmed) {
        return {
          schemaVersion: 1,
          toolRunId: call.toolRunId,
          toolName: call.toolName,
          outcome: "denied",
          errorCode: "confirmation_rejected",
          truncated: false,
        };
      }
    }
    const args = call.arguments as Record<string, unknown>;
    const cached = await this.#cache.lookup(declaration, args, { l0 });
    if (cached !== null) {
      return {
        schemaVersion: 1,
        toolRunId: call.toolRunId,
        toolName: call.toolName,
        outcome: "succeeded",
        value: cached.value,
        truncated: false,
        cacheSource: cached.source,
      };
    }
    // 执行域：节点 Abort = 父域 + 超时；失败分支真正 Abort handler。
    const nodeAbort = new AbortController();
    const onParentAbort = () => nodeAbort.abort(context.signal.reason);
    if (context.signal.aborted) {
      onParentAbort();
    } else {
      context.signal.addEventListener("abort", onParentAbort, { once: true });
    }
    const timeoutAbort = new AbortController();
    const onNodeAbort = () => timeoutAbort.abort(nodeAbort.signal.reason);
    nodeAbort.signal.addEventListener("abort", onNodeAbort, { once: true });
    const deadlineUs = this.#options.clock.nowUs() + BigInt(declaration.timeoutMs) * 1_000n;
    const timeoutPromise = this.#options.clock
      .sleepUntil(deadlineUs, timeoutAbort.signal)
      .then(() => "timeout" as const)
      .catch(() => "aborted" as const);
    const registered = this.#registry.get(call.toolName);
    if (registered === null) {
      // 编译期已拒绝未知工具；此处为防御（fail closed，不猜测）。
      return {
        schemaVersion: 1,
        toolRunId: call.toolRunId,
        toolName: call.toolName,
        outcome: "failed",
        errorCode: "unknown_tool",
        truncated: false,
      };
    }
    const handlerPromise: Promise<{ readonly value: unknown }> = registered.handler({
      arguments: args,
      context: { ...context, signal: nodeAbort.signal },
      deadlineUs,
      idempotencyKey: permission.idempotencyKey,
    });
    const guardedHandler = handlerPromise.catch((error: unknown) => ({
      thrown: error instanceof Error ? error.message : "tool handler failed",
    }));
    const winner = await Promise.race([guardedHandler.then(() => "done" as const), timeoutPromise]);
    let outcome: ToolResult;
    if (winner === "timeout") {
      // 失败分支真正 Abort handler；不等待可能不守约的 handler 收尾。
      nodeAbort.abort(new Error("tool_timeout"));
      outcome = {
        schemaVersion: 1,
        toolRunId: call.toolRunId,
        toolName: call.toolName,
        outcome: "timeout",
        errorCode: "tool_timeout",
        truncated: false,
      };
    } else if (nodeAbort.signal.aborted) {
      outcome = {
        schemaVersion: 1,
        toolRunId: call.toolRunId,
        toolName: call.toolName,
        outcome: "cancelled",
        errorCode: "aborted",
        truncated: false,
      };
    } else {
      timeoutAbort.abort(new Error("tool_completed"));
      const raw = await guardedHandler;
      if ("thrown" in raw) {
        outcome = {
          schemaVersion: 1,
          toolRunId: call.toolRunId,
          toolName: call.toolName,
          outcome: nodeAbort.signal.aborted ? "cancelled" : "failed",
          errorCode: nodeAbort.signal.aborted ? "aborted" : "tool_failed",
          truncated: false,
        };
      } else {
        outcome = this.#processResult(node, raw.value);
        if (outcome.outcome === "succeeded") {
          await this.#cache.store(declaration, args, outcome.value ?? null, { l0 });
        }
      }
    }
    nodeAbort.signal.removeEventListener("abort", onNodeAbort);
    context.signal.removeEventListener("abort", onParentAbort);
    return outcome;
  }

  /** JSON-safe、大小与敏感字段处理；超限结构化截断。 */
  #processResult(node: DagNodePlan, value: unknown): ToolResult {
    let jsonSafe: JsonValue;
    try {
      const serialized = JSON.stringify(value ?? null);
      if (serialized === undefined) {
        return {
          schemaVersion: 1,
          toolRunId: node.call.toolRunId,
          toolName: node.call.toolName,
          outcome: "failed",
          errorCode: "result_not_json_safe",
          truncated: false,
        };
      }
      jsonSafe = JSON.parse(serialized) as JsonValue;
    } catch {
      return {
        schemaVersion: 1,
        toolRunId: node.call.toolRunId,
        toolName: node.call.toolName,
        outcome: "failed",
        errorCode: "result_not_json_safe",
        truncated: false,
      };
    }
    if (node.declaration.sensitiveOutputFields.length > 0) {
      jsonSafe = redactPaths(jsonSafe, node.declaration.sensitiveOutputFields) as JsonValue;
    }
    const serialized = JSON.stringify(jsonSafe) ?? "null";
    if (Buffer.byteLength(serialized, "utf8") > node.declaration.outputMaxBytes) {
      return {
        schemaVersion: 1,
        toolRunId: node.call.toolRunId,
        toolName: node.call.toolName,
        outcome: "succeeded",
        value: {
          truncated: true,
          preview: serialized.slice(0, Math.min(512, node.declaration.outputMaxBytes)),
        },
        truncated: true,
      };
    }
    return {
      schemaVersion: 1,
      toolRunId: node.call.toolRunId,
      toolName: node.call.toolName,
      outcome: "succeeded",
      value: jsonSafe,
      truncated: false,
    };
  }
}

/** 递归脱敏单条点路径（数组逐项下钻）。 */
function redactSegments(current: unknown, segments: readonly string[]): unknown {
  if (segments.length === 0 || typeof current !== "object" || current === null) {
    return current;
  }
  const [head, ...rest] = segments;
  if (Array.isArray(current)) {
    return current.map((item) => redactSegments(item, segments));
  }
  const record = { ...(current as Record<string, unknown>) };
  for (const key of Object.keys(record)) {
    if (key === head) {
      record[key] = rest.length === 0 ? "[redacted]" : redactSegments(record[key], rest);
    }
  }
  return record;
}

/** 按点路径脱敏（敏感字段策略）。 */
function redactPaths(value: unknown, paths: readonly string[]): unknown {
  let result = value;
  for (const path of paths) {
    result = redactSegments(result, path.split("."));
  }
  return result;
}

export { stableStringify };
