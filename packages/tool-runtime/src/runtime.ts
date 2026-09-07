import { BoundedToolPreparation, ToolPreparationError } from "./permissions/preparation.js";
import type { PreparedToolCall } from "@bellis/contracts";
import type { ToolPreparationHook, ToolPreparationStore } from "./port.js";
import { createHash } from "node:crypto";
import { BoundedToolConfirmation } from "./permissions/confirmation.js";
import { ToolRejectedError } from "./permissions/rejection.js";
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
  readonly sessionId: string;
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
    | "dependency_failed"
    | "uncertain";
  readonly durationMs?: number;
  readonly errorCode?: string;
  readonly idempotencyKeyHash?: string;
  /** 命中来源（审计事实：命中缓存仍生成 Tool Run 并标记来源）。 */
  readonly cacheSource?: "l0" | "l1" | "l2";
}

export interface StandardToolRuntimeOptions {
  readonly clock: MonotonicClock;
  readonly wallClockMs: () => number;
  readonly registry?: ToolRegistry;
  readonly cache?: ToolCache;
  readonly cacheStore?: ToolCacheStore | null;
  readonly confirmation?: ConfirmationPort | null;
  readonly preparationStore?: ToolPreparationStore;
  readonly logger?: LoggerPort;
  readonly metrics?: MetricsPort;
  /** Recovery facts: awaited before handler invocation and before result publication. */
  readonly persistRunEvent?: (
    event: ToolRunEvent & { transition: "started" | "finished" },
  ) => Promise<void>;
  /** Optional, best-effort observer; never owns execution state. */
  readonly onRunEvent?: (event: ToolRunEvent) => void;
}

const basicResult = (node: DagNodePlan, outcome: "cancelled" | "failed"): ToolResult => ({
  schemaVersion: 1,
  toolRunId: node.call.toolRunId,
  toolName: node.call.toolName,
  outcome,
  truncated: false,
});

export class StandardToolRuntime implements ToolRuntime {
  readonly #options: StandardToolRuntimeOptions;
  readonly #registry: ToolRegistry;
  readonly #confirmation: BoundedToolConfirmation | null;
  readonly #preparation: BoundedToolPreparation | null;
  readonly #cache: ToolCache;
  readonly #ajv: AjvLike;
  readonly #validators = new Map<string, (data: unknown) => boolean>();
  #closed = false;
  #inFlight = new Set<Promise<unknown>>();
  readonly #controllers = new Set<AbortController>();
  readonly #wakeSchedulers = new Set<() => void>();
  readonly #heldLocks = new Set<string>();
  readonly #toolRunning = new Map<string, number>();
  #runningCount = 0;

  constructor(options: StandardToolRuntimeOptions) {
    this.#options = options;
    this.#confirmation =
      options.confirmation == null
        ? null
        : new BoundedToolConfirmation(options.confirmation, options.clock);
    this.#preparation =
      options.preparationStore === undefined
        ? null
        : new BoundedToolPreparation(options.clock, options.preparationStore);
    this.#registry = options.registry ?? new ToolRegistry();
    this.#cache =
      options.cache ??
      new ToolCache({ wallClockMs: options.wallClockMs, l2: options.cacheStore ?? null });
    this.#ajv = new AjvCtor();
  }

  registerTool(
    declaration: ToolDeclaration,
    handler: ToolHandler,
    preparation?: ToolPreparationHook,
  ): void {
    this.#registry.register(declaration, handler, preparation);
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
    for (const controller of this.#controllers) controller.abort(new Error(reason));
    for (const wake of this.#wakeSchedulers) wake();
    await Promise.allSettled(this.#inFlight);
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  /** 缓存统计（审计/测试视图）。 */
  get cacheStats(): { hits: number; misses: number; l1Size: number } {
    return this.#cache.stats;
  }

  async executeDag(
    dag: DagCompileResult,
    context: ToolExecutionContext,
  ): Promise<ToolDagExecution> {
    if (!dag.ok || dag.nodes.some((node) => node.dependsOn.length > 0)) {
      throw new Error("executeDag requires an independent call plan");
    }
    if (this.#closed) throw new Error("tool runtime is closed");
    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal]);
    const executionContext = { ...context, signal };
    this.#controllers.add(controller);
    const l0 = new Map<string, JsonValue>();
    const shared = new Map<string, Promise<ToolResult>>();
    const pending = [...dag.nodes];
    const running = new Set<Promise<void>>();
    const slots = dag.nodes.map(() => {
      let resolve!: (value: ToolResult) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<ToolResult>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      return { promise, resolve, reject };
    });
    const byId = new Map(dag.nodes.map((node, index) => [node.call.toolRunId, slots[index]!]));
    // Background rejection can occur before the caller receives its handles.
    for (const slot of slots) void slot.promise.catch(() => undefined);
    let wake: (() => void) | null = null;
    const notify = () => {
      wake?.();
      wake = null;
    };
    this.#wakeSchedulers.add(notify);
    signal.addEventListener("abort", notify);
    const run = async (node: DagNodePlan): Promise<void> => {
      const base = {
        sessionId: context.sessionId,
        toolRunId: node.call.toolRunId,
        cycleId: context.cycleId,
        toolName: node.call.toolName,
      };
      const startedUs = this.#options.clock.nowUs();
      const slot = byId.get(node.call.toolRunId)!;
      try {
        this.#observe({ ...base, transition: "planned" });
        let result: ToolResult;
        if (signal.aborted) {
          result = basicResult(node, "cancelled");
        } else {
          const started = { ...base, transition: "started" as const };
          await this.#options.persistRunEvent?.(started);
          this.#observe(started);
          if (signal.aborted) {
            result = basicResult(node, "cancelled");
          } else {
            const key =
              ToolCache.cacheable(node.declaration) && !node.declaration.requiresConfirmation
                ? ToolCache.keyOf(node.declaration, node.call.arguments as Record<string, unknown>)
                : null;
            const existing = key === null ? undefined : shared.get(key);
            if (existing !== undefined) {
              const value = await existing;
              result = {
                schemaVersion: 1,
                toolRunId: node.call.toolRunId,
                toolName: node.call.toolName,
                outcome: value.outcome,
                truncated: value.truncated,
                ...(value.value === undefined ? {} : { value: value.value }),
                ...(value.errorCode === undefined ? {} : { errorCode: value.errorCode }),
                ...(value.outcome === "succeeded" ? { cacheSource: "l0" as const } : {}),
              };
            } else {
              const operation = this.#runNode(node, executionContext, l0);
              if (key !== null) shared.set(key, operation);
              result = await operation;
            }
          }
        }
        const durationMs = Number((this.#options.clock.nowUs() - startedUs) / 1000n);
        const finished = {
          ...base,
          transition: "finished" as const,
          state:
            result.errorCode === "tool_outcome_unknown" ? ("uncertain" as const) : result.outcome,
          durationMs,
          ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
          ...(result.cacheSource === undefined ? {} : { cacheSource: result.cacheSource }),
          ...(node.call.idempotencyKey === undefined
            ? {}
            : { idempotencyKeyHash: hashIdempotencyKey(node.call.idempotencyKey) }),
        };
        await this.#options.persistRunEvent?.(finished);
        this.#observe(finished);
        this.#options.metrics
          ?.counter("bellis_tool_runs_total", {
            tool: node.call.toolName,
            result: result.outcome,
            cache: result.cacheSource ?? "miss",
          })
          .inc();
        this.#options.metrics
          ?.histogram("bellis_tool_duration_ms", {
            tool: node.call.toolName,
            result: result.outcome,
          })
          .observe(durationMs);
        slot.resolve(result);
      } catch (error) {
        // No success escapes an unconfirmed lifecycle write. Other pending work stops.
        this.#options.logger?.log("error", "tool_execution_fact_failed", {
          ...base,
          error: error instanceof Error ? error.message : "unknown",
        });
        controller.abort(error);
        slot.reject(error);
      }
    };
    const drive = async (): Promise<void> => {
      try {
        while (pending.length > 0 || running.size > 0) {
          for (const node of pending.slice()) {
            const count = this.#toolRunning.get(node.call.toolName) ?? 0;
            if (
              !signal.aborted &&
              (this.#runningCount >= context.maxParallelTools ||
                count >= node.declaration.maxConcurrency ||
                (node.lockKey !== null && this.#heldLocks.has(node.lockKey)))
            )
              continue;
            pending.splice(pending.indexOf(node), 1);
            const acquired = !signal.aborted;
            this.#runningCount += 1;
            this.#toolRunning.set(node.call.toolName, count + 1);
            if (acquired && node.lockKey !== null) this.#heldLocks.add(node.lockKey);
            const task = run(node).finally(() => {
              this.#runningCount -= 1;
              this.#toolRunning.set(
                node.call.toolName,
                (this.#toolRunning.get(node.call.toolName) ?? 1) - 1,
              );
              if (acquired && node.lockKey !== null) this.#heldLocks.delete(node.lockKey);
              running.delete(task);
              for (const awaken of this.#wakeSchedulers) awaken();
            });
            running.add(task);
          }
          if (pending.length > 0 || running.size > 0)
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
        }
      } finally {
        signal.removeEventListener("abort", notify);
        this.#wakeSchedulers.delete(notify);
        this.#controllers.delete(controller);
      }
    };
    const driver = drive();
    this.#inFlight.add(driver);
    void driver.finally(() => this.#inFlight.delete(driver)).catch(() => undefined);
    const foreground = dag.nodes.flatMap((node, index) =>
      node.declaration.executionMode === "background" ? [] : [slots[index]!.promise],
    );
    const background = dag.nodes.flatMap((node, index) =>
      node.declaration.executionMode === "background" ? [slots[index]!.promise] : [],
    );
    return { results: await Promise.all(foreground), background };
  }

  #observe(event: ToolRunEvent): void {
    try {
      this.#options.onRunEvent?.(event);
    } catch {
      this.#options.logger?.log("warn", "tool_observer_failed", { toolRunId: event.toolRunId });
    }
  }

  async #runNode(
    node: DagNodePlan,
    context: ToolExecutionContext,
    l0: Map<string, JsonValue>,
  ): Promise<ToolResult> {
    const declaration = node.declaration;
    const call = node.call;
    const deadlineUs = this.#options.clock.nowUs() + BigInt(declaration.timeoutMs) * 1_000n;
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
    let prepared: PreparedToolCall | undefined;
    const preparation = this.#registry.get(call.toolName)?.preparation;
    if (preparation !== undefined) {
      if (this.#preparation === null)
        return {
          schemaVersion: 1,
          toolRunId: call.toolRunId,
          toolName: call.toolName,
          outcome: "denied",
          errorCode: "preparation_store_unavailable",
          truncated: false,
        };
      try {
        prepared = await this.#preparation.run(node, preparation, context, deadlineUs);
      } catch (error) {
        return this.#preparationFailure(node, error);
      }
    }
    const effectiveKey =
      prepared === undefined ? permission.idempotencyKey : prepared.idempotencyKey;
    if (declaration.requiresConfirmation && this.#confirmation !== null) {
      const concrete = {
        ...(prepared === undefined ? {} : { prepared }),
        toolName: declaration.name,
        toolVersion: declaration.version,
        toolRunId: call.toolRunId,
        sessionId: context.sessionId,
        turnId: context.turnId,
        cycleId: context.cycleId,
        arguments: call.arguments,
        idempotencyKeyHash: effectiveKey === null ? null : hashIdempotencyKey(effectiveKey),
      };
      const confirmed = await this.#confirmation.confirm(
        {
          ...concrete,
          requestDigest: createHash("sha256").update(stableStringify(concrete)).digest("hex"),
          deadlineUs,
        },
        context.signal,
      );
      if (confirmed !== "approved") {
        return {
          schemaVersion: 1,
          toolRunId: call.toolRunId,
          toolName: call.toolName,
          outcome:
            confirmed === "cancelled"
              ? "cancelled"
              : confirmed === "timeout"
                ? "timeout"
                : "denied",
          errorCode: `confirmation_${confirmed}`,
          truncated: false,
        };
      }
      // Capability changes while a human is deciding must take effect before execution/cache use.
      const current = checkPermission(
        declaration,
        context,
        call.idempotencyKey,
        this.#options.confirmation ?? null,
      );
      if (!current.allowed)
        return {
          schemaVersion: 1,
          toolRunId: call.toolRunId,
          toolName: call.toolName,
          outcome: "denied",
          errorCode: current.errorCode,
          truncated: false,
        };
    }
    const args = call.arguments as Record<string, unknown>;
    const cached = await this.#cache.lookup(declaration, args, { l0 });
    if (context.signal.aborted) {
      return {
        schemaVersion: 1,
        toolRunId: call.toolRunId,
        toolName: call.toolName,
        outcome: "cancelled",
        errorCode: "aborted",
        truncated: false,
      };
    }
    if (this.#options.clock.nowUs() >= deadlineUs)
      return {
        schemaVersion: 1,
        toolRunId: call.toolRunId,
        toolName: call.toolName,
        outcome: "timeout",
        errorCode: "tool_timeout",
        truncated: false,
      };
    const latest = checkPermission(
      declaration,
      context,
      call.idempotencyKey,
      this.#options.confirmation ?? null,
    );
    if (!latest.allowed)
      return {
        schemaVersion: 1,
        toolRunId: call.toolRunId,
        toolName: call.toolName,
        outcome: "denied",
        errorCode: latest.errorCode,
        truncated: false,
      };
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
    if (prepared !== undefined && preparation !== undefined && this.#preparation !== null) {
      try {
        prepared = await this.#preparation.run(node, preparation, context, deadlineUs, prepared);
      } catch (error) {
        return this.#preparationFailure(node, error);
      }
      const current = checkPermission(
        declaration,
        context,
        effectiveKey ?? undefined,
        this.#options.confirmation ?? null,
      );
      if (!current.allowed)
        return {
          schemaVersion: 1,
          toolRunId: call.toolRunId,
          toolName: call.toolName,
          outcome: "denied",
          errorCode: current.errorCode,
          truncated: false,
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
    let handlerStarted = false;
    const handlerPromise: Promise<{ readonly value: unknown }> = Promise.resolve().then(() => {
      nodeAbort.signal.throwIfAborted();
      handlerStarted = true;
      return registered.handler({
        ...(prepared === undefined ? {} : { prepared }),
        arguments: args,
        context: { ...context, signal: nodeAbort.signal },
        deadlineUs,
        idempotencyKey: effectiveKey,
      });
    });
    const guardedHandler = handlerPromise.catch((error: unknown) => ({
      failure: error,
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
      if ("failure" in raw) {
        outcome = {
          schemaVersion: 1,
          toolRunId: call.toolRunId,
          toolName: call.toolName,
          outcome: nodeAbort.signal.aborted ? "cancelled" : "failed",
          errorCode:
            raw.failure instanceof ToolRejectedError
              ? raw.failure.code
              : declaration.semantic !== "pure" && handlerStarted
                ? "tool_outcome_unknown"
                : "tool_failed",
          truncated: false,
        };
      } else {
        outcome = this.#processResult(node, raw.value);
        if (outcome.outcome === "succeeded") {
          await this.#cache.store(declaration, args, outcome.value ?? null, { l0 });
        }
      }
    }
    // Cancellation, lost response, or invalid result cannot prove a started write was absent.
    // Preserve the observable execution outcome, but publish unknown remote effect explicitly.
    if (
      declaration.semantic !== "pure" &&
      handlerStarted &&
      (outcome.outcome === "timeout" ||
        outcome.outcome === "cancelled" ||
        outcome.errorCode === "tool_outcome_unknown" ||
        outcome.errorCode === "result_not_json_safe")
    ) {
      outcome = {
        schemaVersion: 1,
        toolRunId: call.toolRunId,
        toolName: call.toolName,
        outcome: outcome.outcome,
        truncated: false,
        errorCode: "tool_outcome_unknown",
        value: { remoteOutcome: "unknown" },
      };
    }
    nodeAbort.signal.removeEventListener("abort", onNodeAbort);
    context.signal.removeEventListener("abort", onParentAbort);
    return outcome;
  }

  #preparationFailure(node: DagNodePlan, error: unknown): ToolResult {
    const code = error instanceof ToolPreparationError ? error.code : "preparation_failed";
    return {
      schemaVersion: 1,
      toolRunId: node.call.toolRunId,
      toolName: node.call.toolName,
      outcome:
        code === "preparation_cancelled"
          ? "cancelled"
          : code === "preparation_timeout"
            ? "timeout"
            : "failed",
      errorCode: code,
      truncated: false,
    };
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
