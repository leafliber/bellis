import { createHash } from "node:crypto";
import {
  PreparedToolCallSchema,
  ToolCallSchema,
  type MonotonicClock,
  type PreparedToolCall,
} from "@bellis/contracts";
import type {
  DagNodePlan,
  ToolExecutionContext,
  ToolPreparationHook,
  ToolPreparationStore,
} from "../port.js";
import { frozenJsonCopy } from "../registry/frozen-json.js";

export class ToolPreparationError extends Error {
  constructor(
    readonly code:
      | "preparation_timeout"
      | "preparation_cancelled"
      | "preparation_busy"
      | "preparation_failed",
  ) {
    super(code);
  }
}

/** Preparation is read-only externally. Persistence must finish before confirmation or execution. */
export class BoundedToolPreparation {
  #pending = 0;
  constructor(
    readonly clock: MonotonicClock,
    readonly store: ToolPreparationStore,
  ) {}

  async run(
    node: DagNodePlan,
    hook: ToolPreparationHook,
    context: ToolExecutionContext,
    deadlineUs: bigint,
    saved?: PreparedToolCall,
  ): Promise<PreparedToolCall> {
    if (context.signal.aborted) throw new ToolPreparationError("preparation_cancelled");
    if (this.clock.nowUs() >= deadlineUs) throw new ToolPreparationError("preparation_timeout");
    if (this.#pending >= 8) throw new ToolPreparationError("preparation_busy");
    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal]);
    const identity = {
      schemaVersion: 1 as const,
      sessionId: context.sessionId,
      turnId: context.turnId,
      cycleId: context.cycleId,
      toolRunId: node.call.toolRunId,
      toolName: node.call.toolName,
      toolVersion: node.declaration.version,
      providerId: hook.providerId,
      originalCallDigest: createHash("sha256")
        .update(JSON.stringify(ToolCallSchema.parse(node.call)))
        .digest("hex"),
    };
    this.#pending++;
    const operation = Promise.resolve().then(async () => {
      signal.throwIfAborted();
      let result = saved ?? (await this.store.load(context.sessionId, node.call.toolRunId));
      signal.throwIfAborted();
      if (result === null) {
        const material = await hook.prepare({
          call: node.call,
          context: { ...context, signal },
          deadlineUs,
        });
        signal.throwIfAborted();
        // Adapter output cannot override trusted execution identity.
        result = PreparedToolCallSchema.parse({ ...material, ...identity });
      }
      result = frozenJsonCopy(PreparedToolCallSchema.parse(result));
      for (const key of Object.keys(identity) as (keyof typeof identity)[]) {
        if (result[key] !== identity[key]) throw new ToolPreparationError("preparation_failed");
      }
      if (node.declaration.semantic !== "pure" && result.idempotencyKey === null)
        throw new ToolPreparationError("preparation_failed");
      if (Buffer.byteLength(JSON.stringify(result)) > 65_536)
        throw new ToolPreparationError("preparation_failed");
      signal.throwIfAborted();
      // Exact replay revalidates current policy in the same DB transaction.
      await this.store.save(result);
      signal.throwIfAborted();
      return result;
    });
    void operation.finally(() => this.#pending--).catch(() => undefined);
    const waiting = this.clock.sleepUntil(deadlineUs, signal).then(
      () => {
        throw new ToolPreparationError("preparation_timeout");
      },
      () => {
        throw new ToolPreparationError("preparation_cancelled");
      },
    );
    try {
      const result = await Promise.race([operation, waiting]);
      if (context.signal.aborted) throw new ToolPreparationError("preparation_cancelled");
      if (this.clock.nowUs() >= deadlineUs) throw new ToolPreparationError("preparation_timeout");
      return result;
    } catch (error) {
      if (context.signal.aborted) throw new ToolPreparationError("preparation_cancelled");
      if (error instanceof ToolPreparationError) throw error;
      throw new ToolPreparationError("preparation_failed");
    } finally {
      controller.abort(new Error("preparation_finished"));
    }
  }
}
