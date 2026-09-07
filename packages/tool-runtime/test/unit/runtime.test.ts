import { describe, expect, it, vi } from "vitest";
import { VirtualClock } from "@bellis/testkit";
import type { ToolCall } from "@bellis/contracts";
import { StandardToolRuntime, ToolRejectedError, type ToolRunEvent } from "../../src/index.js";
import type { ToolDeclaration, ToolExecutionContext, ToolHandler } from "../../src/index.js";

const RUN = (n: number): string =>
  `${(n + 0x10).toString(16).repeat(8).slice(0, 8)}-8888-4888-8888-888888888888`;

function declaration(overrides: Partial<ToolDeclaration> = {}): ToolDeclaration {
  return {
    name: "probe",
    version: 1,
    description: "测试工具",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    outputMaxBytes: 4096,
    sensitiveOutputFields: [],
    executionMode: "parallel_read",
    semantic: "pure",
    resource: null,
    keyArgument: null,
    timeoutMs: 5_000,
    cancellable: true,
    maxConcurrency: 8,
    requiredCapabilities: [],
    requiresConfirmation: false,
    cache: { l1: true, l2: false, ttlMs: 60_000, revision: "v1" },
    ...overrides,
  };
}

function call(
  toolRunId: string,
  toolName = "probe",
  args: Record<string, unknown> = {},
  dependsOn?: string[],
  idempotencyKey?: string,
): ToolCall {
  return {
    schemaVersion: 1,
    toolRunId,
    toolName,
    arguments: args,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(dependsOn === undefined ? {} : { dependsOn }),
  } as ToolCall;
}

function makeRuntime(
  clock: VirtualClock,
  tools: readonly { declaration: ToolDeclaration; handler: ToolHandler }[],
) {
  const runtime = new StandardToolRuntime({
    clock,
    wallClockMs: () => Number(clock.nowUs() / 1000n),
  });
  for (const tool of tools) {
    runtime.registerTool(tool.declaration, tool.handler);
  }
  return runtime;
}

function context(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    traceId: "0123456789abcdef0123456789abcdef",
    sessionId: "11111111-1111-4111-8111-111111111111",
    turnId: "22222222-2222-4222-8222-222222222222",
    cycleId: "33333333-3333-4333-8333-333333333333",
    signal: new AbortController().signal,
    capabilities: new Set<string>(),
    idempotencyKeys: new Map(),
    maxParallelTools: 8,
    ...overrides,
  };
}

const flush = async (ticks = 40): Promise<void> => {
  for (let tick = 0; tick < ticks; tick += 1) {
    await Promise.resolve();
  }
};

describe("StandardToolRuntime", () => {
  it("persists uncertain for a started write with a lost response, and publishes no false no-write claim", async () => {
    const clock = new VirtualClock();
    const events: ToolRunEvent[] = [];
    let effects = 0;
    const runtime = new StandardToolRuntime({
      clock,
      wallClockMs: () => 0,
      persistRunEvent: async (event) => {
        events.push(event);
      },
    });
    runtime.registerTool(declaration({ semantic: "idempotent", cache: null }), async () => {
      effects++;
      throw new Error("lost response containing private text");
    });
    const result = await runtime.executeDag(runtime.compileDag([call(RUN(1))]), context());
    expect(effects).toBe(1);
    expect(result.results[0]).toMatchObject({
      outcome: "failed",
      errorCode: "tool_outcome_unknown",
      value: { remoteOutcome: "unknown" },
    });
    expect(events.at(-1)).toMatchObject({
      transition: "finished",
      state: "uncertain",
      sessionId: context().sessionId,
    });
    expect(JSON.stringify(result)).not.toContain("private text");
    await runtime.close("done");
  });

  it("preserves definite public write rejection without claiming uncertainty", async () => {
    const clock = new VirtualClock();
    const runtime = makeRuntime(clock, [
      {
        declaration: declaration({ semantic: "idempotent", cache: null }),
        handler: async () => {
          throw new ToolRejectedError("revision_conflict");
        },
      },
    ]);
    const result = await runtime.executeDag(runtime.compileDag([call(RUN(1))]), context());
    expect(result.results[0]).toMatchObject({ outcome: "failed", errorCode: "revision_conflict" });
    expect(result.results[0]?.value).toBeUndefined();
    await runtime.close("done");
  });

  it("treats invalid write results as unknown but keeps pure tool failures ordinary", async () => {
    for (const semantic of ["idempotent", "pure"] as const) {
      const clock = new VirtualClock();
      const runtime = makeRuntime(clock, [
        {
          declaration: declaration({ semantic, cache: null }),
          handler: async () => ({ value: { invalid: 1n } }),
        },
      ]);
      const result = await runtime.executeDag(runtime.compileDag([call(RUN(1))]), context());
      expect(result.results[0]?.errorCode).toBe(
        semantic === "pure" ? "result_not_json_safe" : "tool_outcome_unknown",
      );
      await runtime.close("done");
    }
  });
  it("runs independent parallel_read tools with real time overlap", async () => {
    const clock = new VirtualClock();
    const spans: { toolRunId: string; startUs: bigint; endUs: bigint }[] = [];
    const handler: ToolHandler = async (input) => {
      const startUs = clock.nowUs();
      spans.push({ toolRunId: input.arguments.run as string, startUs, endUs: 0n });
      const index = spans.length - 1;
      await clock.sleepUntil(startUs + 100_000n, input.context.signal);
      spans[index]!.endUs = clock.nowUs();
      return { value: { done: input.arguments.run } };
    };
    const runtime = makeRuntime(clock, [{ declaration: declaration(), handler }]);
    const dagPromise = runtime.executeDag(
      runtime.compileDag([
        call(RUN(1), "probe", { run: "a" }),
        call(RUN(2), "probe", { run: "b" }),
      ]),
      context(),
    );
    // 让调度器启动两个节点，然后推进时钟完成。
    await flush();
    clock.advanceBy(100_000n);
    const execution = await dagPromise;
    expect(execution.results).toHaveLength(2);
    expect(execution.results.every((result) => result.outcome === "succeeded")).toBe(true);
    const [a, b] = spans;
    // 真实重叠：a 与 b 的时间区间相交。
    expect(a && b && a.startUs < b.endUs && b.startUs < a.endUs).toBe(true);
  });

  it("serializes exclusive tools on the same resource", async () => {
    const clock = new VirtualClock();
    const spans: { startUs: bigint; endUs: bigint }[] = [];
    const handler: ToolHandler = async (input) => {
      const startUs = clock.nowUs();
      const index = spans.length;
      spans.push({ startUs, endUs: 0n });
      await clock.sleepUntil(startUs + 50_000n, input.context.signal);
      spans[index]!.endUs = clock.nowUs();
      return { value: null };
    };
    const runtime = makeRuntime(clock, [
      {
        declaration: declaration({
          name: "write_state",
          executionMode: "exclusive",
          resource: "state",
          semantic: "idempotent",
        }),
        handler,
      },
    ]);
    const dagPromise = runtime.executeDag(
      runtime.compileDag([
        call(RUN(1), "write_state", { n: 1 }),
        call(RUN(2), "write_state", { n: 2 }),
      ]),
      context(),
    );
    await flush();
    // 第一步：node 1（0→50ms）完成；调度器启动 node 2（100→150ms）。
    clock.advanceBy(100_000n);
    await flush();
    // 第二步：node 2 完成。
    clock.advanceBy(100_000n);
    const execution = await dagPromise;
    expect(execution.results.every((result) => result.outcome === "succeeded")).toBe(true);
    const [first, second] = spans;
    // 不重叠：第一个结束后第二个才开始。
    expect(first && second && first.endUs <= second.startUs).toBe(true);
  });

  it("refuses unsupported dependency plans before any handler executes", async () => {
    const clock = new VirtualClock();
    let calls = 0;
    const runtime = makeRuntime(clock, [
      {
        declaration: declaration(),
        handler: async () => {
          calls += 1;
          return { value: null };
        },
      },
    ]);
    const plan = runtime.compileDag([call(RUN(1)), call(RUN(2), "probe", {}, [RUN(1)])]);
    await expect(runtime.executeDag(plan, context())).rejects.toThrow(/independent/);
    expect(calls).toBe(0);
  });

  it("denies capability-missing, unconfirmed and unkeyed non-idempotent tools (fail closed)", async () => {
    const clock = new VirtualClock();
    const runtime = makeRuntime(clock, [
      {
        declaration: declaration({ name: "needs_cap", requiredCapabilities: ["memory"] }),
        handler: async () => ({ value: 1 }),
      },
      {
        declaration: declaration({
          name: "confirm_tool",
          requiresConfirmation: true,
          semantic: "idempotent",
          cache: null,
        }),
        handler: async () => ({ value: 1 }),
      },
      {
        declaration: declaration({
          name: "gift_api",
          executionMode: "exclusive",
          resource: "gift",
          semantic: "non_idempotent",
          cache: null,
        }),
        handler: async () => ({ value: 1 }),
      },
    ]);
    const execution = await runtime.executeDag(
      runtime.compileDag([
        call(RUN(1), "needs_cap"),
        call(RUN(2), "confirm_tool"),
        call(RUN(3), "gift_api"),
      ]),
      context(),
    );
    expect(execution.results.map((result) => result.outcome)).toEqual([
      "denied",
      "denied",
      "denied",
    ]);
    expect(execution.results.map((result) => result.errorCode)).toEqual([
      "capability_missing",
      "confirmation_unavailable",
      "idempotency_key_required",
    ]);
  });

  it("times out handlers that exceed their deadline (real Abort)", async () => {
    const clock = new VirtualClock();
    const runtime = makeRuntime(clock, [
      {
        declaration: declaration({
          name: "slow",
          timeoutMs: 100,
          cache: null,
          semantic: "idempotent",
        }),
        handler: async (input) => {
          await clock.sleepUntil(clock.nowUs() + 1_000_000_000n, input.context.signal);
          return { value: null };
        },
      },
    ]);
    const dagPromise = runtime.executeDag(runtime.compileDag([call(RUN(1), "slow")]), context());
    await flush();
    clock.advanceBy(200_000n);
    const execution = await dagPromise;
    expect(execution.results[0]?.outcome).toBe("timeout");
    expect(execution.results[0]?.errorCode).toBe("tool_outcome_unknown");
    expect(execution.results[0]?.value).toEqual({ remoteOutcome: "unknown" });
  });

  it("cancels waiting and running nodes on parent abort", async () => {
    const clock = new VirtualClock();
    const parent = new AbortController();
    const runtime = makeRuntime(clock, [
      {
        declaration: declaration({
          name: "chained_a",
          maxConcurrency: 1,
          cache: null,
          semantic: "idempotent",
        }),
        handler: async (input) => {
          await clock.sleepUntil(clock.nowUs() + 100_000n, input.context.signal);
          return { value: null };
        },
      },
    ]);
    const dagPromise = runtime.executeDag(
      runtime.compileDag([call(RUN(1), "chained_a"), call(RUN(2), "chained_a")]),
      context({ signal: parent.signal }),
    );
    await flush();
    parent.abort(new Error("interrupt"));
    const execution = await dagPromise;
    expect(execution.results[0]?.outcome).toBe("cancelled");
    expect(execution.results[1]?.outcome).toBe("cancelled");
    expect(execution.results[0]?.errorCode).toBe("tool_outcome_unknown");
    expect(execution.results[1]?.errorCode).not.toBe("tool_outcome_unknown");
  });

  it("serves repeat invocations from L0/L1 caches with audit-visible source", async () => {
    const clock = new VirtualClock();
    let executions = 0;
    const runtime = makeRuntime(clock, [
      {
        declaration: declaration({ name: "cached_probe" }),
        handler: async () => {
          executions += 1;
          return { value: { n: executions } };
        },
      },
    ]);
    // 同一 DAG 内两次相同调用：第二次命中 L0。
    const first = await runtime.executeDag(
      runtime.compileDag([
        call(RUN(1), "cached_probe", { q: "x" }),
        call(RUN(2), "cached_probe", { q: "x" }),
      ]),
      context(),
    );
    expect(executions).toBe(1);
    expect(first.results[0]?.cacheSource).toBeUndefined();
    expect(first.results[1]?.cacheSource).toBe("l0");
    // 新 DAG 相同输入：命中 L1。
    const second = await runtime.executeDag(
      runtime.compileDag([call(RUN(3), "cached_probe", { q: "x" })]),
      context(),
    );
    expect(executions).toBe(1);
    expect(second.results[0]?.cacheSource).toBe("l1");
  });

  it("truncates oversized results and redacts sensitive fields", async () => {
    const clock = new VirtualClock();
    const runtime = makeRuntime(clock, [
      {
        declaration: declaration({
          name: "big",
          outputMaxBytes: 64,
          cache: null,
          semantic: "idempotent",
        }),
        handler: async () => ({ value: { blob: "x".repeat(4096) } }),
      },
      {
        declaration: declaration({
          name: "secret",
          sensitiveOutputFields: ["token"],
          cache: null,
          semantic: "idempotent",
        }),
        handler: async () => ({ value: { token: "sk-live", public: "ok" } }),
      },
    ]);
    const execution = await runtime.executeDag(
      runtime.compileDag([call(RUN(1), "big"), call(RUN(2), "secret")]),
      context(),
    );
    const big = execution.results[0]!;
    expect(big.truncated).toBe(true);
    expect(big.value).toMatchObject({ truncated: true });
    const secret = execution.results[1]!;
    expect(JSON.stringify(secret.value)).not.toContain("sk-live");
    expect(secret.value).toMatchObject({ token: "[redacted]", public: "ok" });
  });

  it("background tools do not block foreground completion", async () => {
    const clock = new VirtualClock();
    const runtime = makeRuntime(clock, [
      {
        declaration: declaration({ name: "fg", cache: null, semantic: "idempotent" }),
        handler: async () => ({ value: "fg" }),
      },
      {
        declaration: declaration({
          name: "bg",
          executionMode: "background",
          cache: null,
          semantic: "idempotent",
        }),
        handler: async (input) => {
          await clock.sleepUntil(clock.nowUs() + 500_000n, input.context.signal);
          return { value: "bg" };
        },
      },
    ]);
    const dagPromise = runtime.executeDag(
      runtime.compileDag([call(RUN(1), "fg"), call(RUN(2), "bg")]),
      context(),
    );
    await flush();
    // 前台立即完成（未推进时钟）。
    const execution = await dagPromise;
    expect(execution.results.map((result) => result.toolName)).toEqual(["fg"]);
    expect(execution.background).toHaveLength(1);
    // 推进时钟后后台任务结算。
    clock.advanceBy(500_000n);
    const backgroundResult = await execution.background[0]!;
    expect(backgroundResult.outcome).toBe("succeeded");
    await runtime.close("test");
  });
});

describe("task lifetime and durable facts", () => {
  it("continues queued background work after returning foreground results", async () => {
    const clock = new VirtualClock();
    const calls: string[] = [];
    const runtime = makeRuntime(clock, [
      {
        declaration: declaration({
          executionMode: "background",
          semantic: "idempotent",
          cache: null,
          maxConcurrency: 1,
        }),
        handler: async (input) => {
          calls.push(input.context.cycleId);
          await clock.sleepUntil(clock.nowUs() + 10_000n, input.context.signal);
          return { value: null };
        },
      },
    ]);
    const execution = await runtime.executeDag(
      runtime.compileDag([call(RUN(1)), call(RUN(2))]),
      context(),
    );
    await flush();
    expect(calls).toHaveLength(1);
    clock.advanceBy(10_000n);
    await flush();
    expect(calls).toHaveLength(2);
    clock.advanceBy(10_000n);
    expect((await Promise.all(execution.background)).map((result) => result.outcome)).toEqual([
      "succeeded",
      "succeeded",
    ]);
    await runtime.close("test");
  });

  it("close cancels both running and queued background tasks", async () => {
    const clock = new VirtualClock();
    let calls = 0;
    const runtime = makeRuntime(clock, [
      {
        declaration: declaration({
          executionMode: "background",
          semantic: "idempotent",
          cache: null,
          maxConcurrency: 1,
        }),
        handler: async (input) => {
          calls += 1;
          await clock.sleepUntil(1_000_000n, input.context.signal);
          return { value: null };
        },
      },
    ]);
    const execution = await runtime.executeDag(
      runtime.compileDag([call(RUN(1)), call(RUN(2))]),
      context(),
    );
    await flush();
    await runtime.close("shutdown");
    expect(calls).toBe(1);
    expect(
      (await Promise.all(execution.background)).every((result) => result.outcome === "cancelled"),
    ).toBe(true);
    expect(clock.pendingCount()).toBe(0);
  });

  it.each(["started", "finished"] as const)(
    "does not hide a failed %s fact",
    async (transition) => {
      const clock = new VirtualClock();
      let effects = 0;
      const observed: string[] = [];
      const runtime = new StandardToolRuntime({
        clock,
        wallClockMs: () => 0,
        persistRunEvent: async (event) => {
          if (event.transition === transition) throw new Error("db_unavailable");
        },
        onRunEvent: (event) => observed.push(event.transition),
      });
      runtime.registerTool(declaration({ cache: null }), async () => {
        effects += 1;
        return { value: true };
      });
      await expect(
        runtime.executeDag(runtime.compileDag([call(RUN(1))]), context()),
      ).rejects.toThrow("db_unavailable");
      expect(effects).toBe(transition === "started" ? 0 : 1);
      expect(observed).not.toContain("finished");
      await runtime.close("test");
    },
  );
});

describe("concrete bounded confirmation", () => {
  it("freezes the registered declaration and compiled arguments before presenting approval", async () => {
    const clock = new VirtualClock();
    const seen: import("../../src/index.js").ToolConfirmationRequest[] = [];
    const observed: unknown[] = [];
    const runtime = new StandardToolRuntime({
      clock,
      wallClockMs: () => 0,
      confirmation: {
        confirm: async (request) => {
          seen.push(request);
          expect(Object.isFrozen(request.arguments)).toBe(true);
          expect(() => {
            (request.arguments as Record<string, unknown>).target = "changed-by-confirmation";
          }).toThrow();
          return true;
        },
      },
    });
    const spec = declaration({ semantic: "idempotent", requiresConfirmation: true, cache: null });
    runtime.registerTool(spec, async (input) => {
      observed.push(input.arguments);
      return { value: null };
    });
    (spec as { requiresConfirmation: boolean }).requiresConfirmation = false;
    expect(runtime.listDeclarations()[0]?.requiresConfirmation).toBe(true);
    const args = { target: "original", nested: { value: "frozen" } };
    const dag = runtime.compileDag([
      call(RUN(1), "probe", args, undefined, "private-business-key"),
    ]);
    args.target = "changed-after-compile";
    args.nested.value = "changed";
    const result = await runtime.executeDag(dag, context());
    expect(result.results[0]?.outcome).toBe("succeeded");
    expect(observed).toEqual([{ target: "original", nested: { value: "frozen" } }]);
    expect(seen[0]).toMatchObject({
      toolVersion: 1,
      sessionId: context().sessionId,
      turnId: context().turnId,
      cycleId: context().cycleId,
    });
    expect(seen[0]?.requestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(seen[0]?.idempotencyKeyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      JSON.stringify(seen[0], (_, value) => (typeof value === "bigint" ? String(value) : value)),
    ).not.toContain("private-business-key");
    await runtime.close("done");
  });

  it("times out a hanging confirmation, retains its permit, and ignores late approval", async () => {
    const clock = new VirtualClock();
    let approve!: (value: boolean) => void;
    let signal: AbortSignal | undefined;
    const confirm = vi.fn(async (request: import("../../src/index.js").ToolConfirmationRequest) => {
      signal = request.signal;
      return new Promise<boolean>((resolve) => {
        approve = resolve;
      });
    });
    const handler = vi.fn(async () => ({ value: null }));
    const runtime = new StandardToolRuntime({
      clock,
      wallClockMs: () => 0,
      confirmation: { confirm },
    });
    runtime.registerTool(
      declaration({
        semantic: "idempotent",
        requiresConfirmation: true,
        cache: null,
        timeoutMs: 100,
      }),
      handler,
    );
    const execution = runtime.executeDag(runtime.compileDag([call(RUN(1))]), context());
    await flush();
    clock.advanceBy(100_000n);
    expect((await execution).results[0]).toMatchObject({
      outcome: "timeout",
      errorCode: "confirmation_timeout",
    });
    expect(signal?.aborted).toBe(true);
    expect(
      (await runtime.executeDag(runtime.compileDag([call(RUN(2))]), context())).results[0],
    ).toMatchObject({ outcome: "denied", errorCode: "confirmation_busy" });
    expect(confirm).toHaveBeenCalledTimes(1);
    approve(true);
    await flush();
    expect(handler).not.toHaveBeenCalled();
    confirm.mockResolvedValue(false);
    expect(
      (await runtime.executeDag(runtime.compileDag([call(RUN(3))]), context())).results[0]
        ?.errorCode,
    ).toBe("confirmation_rejected");
    await runtime.close("done");
    expect(clock.pendingCount()).toBe(0);
  });

  it("closes while confirmation ignores cancellation, without allowing its late approval to write", async () => {
    const clock = new VirtualClock();
    let approve!: (value: boolean) => void;
    let signal: AbortSignal | undefined;
    const handler = vi.fn(async () => ({ value: null }));
    const runtime = new StandardToolRuntime({
      clock,
      wallClockMs: () => 0,
      confirmation: {
        confirm: async (request) => {
          signal = request.signal;
          return new Promise((resolve) => {
            approve = resolve;
          });
        },
      },
    });
    runtime.registerTool(
      declaration({ semantic: "idempotent", requiresConfirmation: true, cache: null }),
      handler,
    );
    const execution = runtime.executeDag(runtime.compileDag([call(RUN(1))]), context());
    await flush();
    await runtime.close("session closed");
    expect((await execution).results[0]).toMatchObject({
      outcome: "cancelled",
      errorCode: "confirmation_cancelled",
    });
    expect(signal?.aborted).toBe(true);
    approve(true);
    await flush();
    expect(handler).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(0);
  });

  it("shares the tool deadline between confirmation and execution", async () => {
    const clock = new VirtualClock();
    const runtime = new StandardToolRuntime({
      clock,
      wallClockMs: () => 0,
      confirmation: {
        confirm: async (request) => {
          await clock.sleepUntil(clock.nowUs() + 80_000n, request.signal);
          return true;
        },
      },
    });
    runtime.registerTool(
      declaration({
        semantic: "idempotent",
        requiresConfirmation: true,
        cache: null,
        timeoutMs: 100,
      }),
      async (input) => {
        expect(input.deadlineUs).toBe(100_000n);
        await clock.sleepUntil(clock.nowUs() + 40_000n, input.context.signal);
        return { value: "too late" };
      },
    );
    const execution = runtime.executeDag(runtime.compileDag([call(RUN(1))]), context());
    await flush();
    clock.advanceBy(80_000n);
    await flush();
    clock.advanceBy(20_000n);
    expect((await execution).results[0]).toMatchObject({
      outcome: "timeout",
      errorCode: "tool_outcome_unknown",
    });
    await runtime.close("done");
    expect(clock.pendingCount()).toBe(0);
  });

  it("rechecks revoked capabilities and requires separate confirmation even for cached identical calls", async () => {
    const clock = new VirtualClock();
    const capabilities = new Set(["memory.write"]);
    const handler = vi.fn(async () => ({ value: "written" }));
    const confirm = vi.fn(async () => true);
    const runtime = new StandardToolRuntime({
      clock,
      wallClockMs: () => 0,
      confirmation: { confirm },
    });
    runtime.registerTool(
      declaration({
        semantic: "idempotent",
        requiresConfirmation: true,
        requiredCapabilities: ["memory.write"],
      }),
      handler,
    );
    confirm.mockImplementationOnce(async () => {
      capabilities.clear();
      return true;
    });
    expect(
      (await runtime.executeDag(runtime.compileDag([call(RUN(1))]), context({ capabilities })))
        .results[0]?.errorCode,
    ).toBe("capability_missing");
    expect(handler).not.toHaveBeenCalled();
    capabilities.add("memory.write");
    confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const results = await runtime.executeDag(
      runtime.compileDag([call(RUN(2)), call(RUN(3))]),
      context({ capabilities, maxParallelTools: 1 }),
    );
    expect(results.results.map((result) => result.outcome)).toEqual(["succeeded", "denied"]);
    expect(confirm).toHaveBeenCalledTimes(3);
    expect(handler).toHaveBeenCalledTimes(1);
    await runtime.close("done");
  });
});
