import { expect, it, vi } from "vitest";
import { VirtualClock } from "@bellis/testkit";
import {
  StandardToolRuntime,
  type ToolDeclaration,
  type ToolExecutionContext,
  type ToolPreparationStore,
  type ToolPreparationHook,
} from "../../src/index.js";
import type { PreparedToolCall, ToolCall } from "@bellis/contracts";
const call: ToolCall = {
  schemaVersion: 1,
  toolRunId: "88888888-8888-4888-8888-888888888888",
  toolName: "remember",
  arguments: { text: "model text" },
  idempotencyKey: "model-key",
};
const declaration: ToolDeclaration = {
  name: "remember",
  version: 1,
  description: "Prepared write",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  outputMaxBytes: 1024,
  sensitiveOutputFields: [],
  executionMode: "parallel_read",
  semantic: "idempotent",
  resource: null,
  keyArgument: null,
  timeoutMs: 100,
  cancellable: true,
  maxConcurrency: 1,
  requiredCapabilities: ["memory.write"],
  requiresConfirmation: true,
  cache: null,
};
const context = (): ToolExecutionContext => ({
  sessionId: "11111111-1111-4111-8111-111111111111",
  turnId: "22222222-2222-4222-8222-222222222222",
  cycleId: "33333333-3333-4333-8333-333333333333",
  traceId: "1".repeat(32),
  capabilities: new Set(["memory.write"]),
  signal: new AbortController().signal,
  idempotencyKeys: new Map(),
  maxParallelTools: 1,
});
const material = () => ({
  idempotencyKey: "host-business-key",
  request: {
    agent_id: "trusted-agent",
    space_id: "trusted-space",
    value: "model text",
    expected_revision: 3,
  },
  confirmation: { action: "remember", subject: "trusted subject" },
  resources: [],
});
const hook = (): ToolPreparationHook => ({
  providerId: "iris",
  prepare: vi.fn(async () => material()),
});
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

it("requires durable preparation storage before presenting confirmation or invoking a prepared tool", async () => {
  const clock = new VirtualClock();
  const prepare = hook();
  const handler = vi.fn(async () => ({ value: null }));
  const confirm = vi.fn(async () => true);
  const runtime = new StandardToolRuntime({
    clock,
    wallClockMs: () => 0,
    confirmation: { confirm },
  });
  runtime.registerTool(declaration, handler, prepare);
  expect(
    (await runtime.executeDag(runtime.compileDag([call]), context())).results[0]?.errorCode,
  ).toBe("preparation_store_unavailable");
  expect(prepare.prepare).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
  expect(handler).not.toHaveBeenCalled();
  await runtime.close("done");
});

it("recovers the frozen actual request and effective key without resolving new parameters", async () => {
  const clock = new VirtualClock();
  let saved: PreparedToolCall | null = null;
  const store: ToolPreparationStore = {
    load: async () => saved,
    save: async (value) => {
      saved = value;
    },
  };
  const first = hook();
  const replacement = {
    providerId: "iris",
    prepare: vi.fn(async () => {
      throw new Error("must not resolve again");
    }),
  };
  for (const prepare of [first, replacement]) {
    const handler = vi.fn(
      async (input: Parameters<import("../../src/index.js").ToolHandler>[0]) => {
        expect(input.idempotencyKey).toBe("host-business-key");
        expect(input.prepared?.request).toEqual(material().request);
        expect(Object.isFrozen(input.prepared?.request)).toBe(true);
        return { value: "accepted" };
      },
    );
    const runtime = new StandardToolRuntime({
      clock,
      wallClockMs: () => 0,
      preparationStore: store,
      confirmation: {
        confirm: async (request) => {
          expect(saved).toBe(request.prepared);
          expect(request.prepared?.confirmation).toEqual(material().confirmation);
          return true;
        },
      },
    });
    runtime.registerTool(declaration, handler, prepare);
    expect(
      (await runtime.executeDag(runtime.compileDag([call]), context())).results[0]?.outcome,
    ).toBe("succeeded");
    expect(handler).toHaveBeenCalledTimes(1);
    await runtime.close("done");
  }
  expect(first.prepare).toHaveBeenCalledTimes(1);
  expect(replacement.prepare).not.toHaveBeenCalled();
});

it("does not confirm or dispatch after a lost save ACK, then recovers the saved original request", async () => {
  const clock = new VirtualClock();
  let saved: PreparedToolCall | null = null;
  let lose = true;
  const store: ToolPreparationStore = {
    load: async () => saved,
    save: async (value) => {
      saved = value;
      if (lose) {
        lose = false;
        throw new Error("lost ACK");
      }
    },
  };
  const prepare = hook();
  const handler = vi.fn(async () => ({ value: "done" }));
  const confirm = vi.fn(async () => true);
  const runtime = new StandardToolRuntime({
    clock,
    wallClockMs: () => 0,
    preparationStore: store,
    confirmation: { confirm },
  });
  runtime.registerTool(declaration, handler, prepare);
  expect(
    (await runtime.executeDag(runtime.compileDag([call]), context())).results[0]?.errorCode,
  ).toBe("preparation_failed");
  expect(handler).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
  expect(
    (await runtime.executeDag(runtime.compileDag([call]), context())).results[0]?.outcome,
  ).toBe("succeeded");
  expect(prepare.prepare).toHaveBeenCalledTimes(1);
  expect(handler).toHaveBeenCalledTimes(1);
  await runtime.close("done");
});

it("revalidates the persisted request after approval and rejects a changed policy before dispatch", async () => {
  const clock = new VirtualClock();
  let revoked = false;
  const handler = vi.fn(async () => ({ value: "must not run" }));
  const store: ToolPreparationStore = {
    load: async () => null,
    save: async () => {
      if (revoked) throw new Error("policy revoked");
    },
  };
  const runtime = new StandardToolRuntime({
    clock,
    wallClockMs: () => 0,
    preparationStore: store,
    confirmation: {
      confirm: async () => {
        revoked = true;
        return true;
      },
    },
  });
  runtime.registerTool(declaration, handler, hook());
  expect(
    (await runtime.executeDag(runtime.compileDag([call]), context())).results[0]?.errorCode,
  ).toBe("preparation_failed");
  expect(handler).not.toHaveBeenCalled();
  await runtime.close("done");
});

it("cancels late preparation without saving or executing it", async () => {
  const clock = new VirtualClock();
  let finish!: (value: ReturnType<typeof material>) => void;
  const save = vi.fn(async () => undefined);
  const handler = vi.fn(async () => ({ value: null }));
  const confirm = vi.fn(async () => true);
  const runtime = new StandardToolRuntime({
    clock,
    wallClockMs: () => 0,
    preparationStore: { load: async () => null, save },
    confirmation: { confirm },
  });
  runtime.registerTool(declaration, handler, {
    providerId: "iris",
    prepare: async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const execution = runtime.executeDag(runtime.compileDag([call]), context());
  await flush();
  clock.advanceBy(100_000n);
  expect((await execution).results[0]?.errorCode).toBe("preparation_timeout");
  finish(material());
  await flush();
  expect(save).not.toHaveBeenCalled();
  expect(handler).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
  await runtime.close("done");
  expect(clock.pendingCount()).toBe(0);
});

it("rechecks capability changes during the post-confirmation persistence barrier", async () => {
  const clock = new VirtualClock();
  const executionContext = context();
  const capabilities = new Set(["memory.write"]);
  let saves = 0;
  const handler = vi.fn(async () => ({ value: null }));
  const runtime = new StandardToolRuntime({
    clock,
    wallClockMs: () => 0,
    preparationStore: {
      load: async () => null,
      save: async () => {
        if (++saves === 2) capabilities.clear();
      },
    },
    confirmation: { confirm: async () => true },
  });
  runtime.registerTool(declaration, handler, hook());
  expect(
    (await runtime.executeDag(runtime.compileDag([call]), { ...executionContext, capabilities }))
      .results[0]?.errorCode,
  ).toBe("capability_missing");
  expect(saves).toBe(2);
  expect(handler).not.toHaveBeenCalled();
  await runtime.close("done");
});
