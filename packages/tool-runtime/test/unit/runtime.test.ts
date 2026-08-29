import { describe, expect, it } from "vitest";
import { VirtualClock } from "@bellis/testkit";
import type { ToolCall } from "@bellis/contracts";
import { StandardToolRuntime } from "../../src/index.js";
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

  it("runs dependent tools in order and propagates dependency failure", async () => {
    const clock = new VirtualClock();
    const order: string[] = [];
    const okHandler: ToolHandler = async (input) => {
      order.push(`ok:${String(input.arguments.step)}`);
      return { value: { step: input.arguments.step } };
    };
    const boomMessage = "tool exploded";
    const failHandler: ToolHandler = async () => {
      throw new Error(boomMessage);
    };
    const runtime = makeRuntime(clock, [
      { declaration: declaration(), handler: okHandler },
      {
        declaration: declaration({ name: "broken", cache: null, semantic: "idempotent" }),
        handler: failHandler,
      },
    ]);
    const chained = await runtime.executeDag(
      runtime.compileDag([call(RUN(1), "broken"), call(RUN(2), "probe", { step: 1 }, [RUN(1)])]),
      context(),
    );
    expect(chained.results[0]?.outcome).toBe("failed");
    expect(chained.results[1]?.outcome).toBe("dependency_failed");
    expect(order).toEqual([]);

    const ordered = await runtime.executeDag(
      runtime.compileDag([
        call(RUN(1), "probe", { step: "a" }),
        call(RUN(2), "probe", { step: "b" }, [RUN(1)]),
      ]),
      context(),
    );
    expect(ordered.results.every((result) => result.outcome === "succeeded")).toBe(true);
    expect(order).toEqual(["ok:a", "ok:b"]);
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
    expect(execution.results[0]?.errorCode).toBe("tool_timeout");
  });

  it("cancels waiting and running nodes on parent abort", async () => {
    const clock = new VirtualClock();
    const parent = new AbortController();
    const runtime = makeRuntime(clock, [
      {
        declaration: declaration({ name: "chained_a", cache: null, semantic: "idempotent" }),
        handler: async (input) => {
          await clock.sleepUntil(clock.nowUs() + 100_000n, input.context.signal);
          return { value: null };
        },
      },
    ]);
    const dagPromise = runtime.executeDag(
      runtime.compileDag([call(RUN(1), "chained_a"), call(RUN(2), "chained_a", {}, [RUN(1)])]),
      context({ signal: parent.signal }),
    );
    await flush();
    parent.abort(new Error("interrupt"));
    const execution = await dagPromise;
    expect(execution.results[0]?.outcome).toBe("cancelled");
    expect(execution.results[1]?.outcome).toBe("cancelled");
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
