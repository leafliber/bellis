import { createHash, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createPersistenceClient } from "@bellis/persistence";
import { SystemMonotonicClock } from "@bellis/transport";
import { Phase3DecisionHost } from "../../src/application/phase-3/host.js";
import { DemoScriptedProvider } from "../../src/providers/model/demo-scripted.js";
import { WORKER_FIXTURE, createTempDataDirectory, cleanupTempDataDirectory } from "../helpers.js";

it("confirms and dispatches the durable trusted request, retaining it for unknown-outcome recovery", async () => {
  const dataDirectory = createTempDataDirectory("phase4-prepared-host-");
  let persistence = createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
  const clock = new SystemMonotonicClock();
  const provider = new DemoScriptedProvider({ clock });
  const sessionId = randomUUID(),
    toolRunId = randomUUID();
  const actualRequest = {
    actor_id: "trusted-actor",
    scope: "trusted-space",
    claim_id: "resolved-claim",
    expected_revision: 7,
  };
  const prepare = vi.fn(async () => ({
    idempotencyKey: "trusted-original-key",
    request: actualRequest,
    confirmation: { action: "correct", claim: "resolved-claim", revision: 7 },
    resources: [],
  }));
  const confirm = vi.fn(async (request: import("@bellis/tool-runtime").ToolConfirmationRequest) => {
    expect(request.prepared).toEqual(
      await persistence.phase4ReadPreparedTool(sessionId, toolRunId),
    );
    expect(request.prepared?.request).toEqual(actualRequest);
    expect(request.idempotencyKeyHash).toBe(
      createHash("sha256").update("trusted-original-key").digest("hex"),
    );
    expect(request.arguments).toEqual({ target: "tea" });
    return true;
  });
  const handler = vi.fn(
    async (input: Parameters<import("@bellis/tool-runtime").ToolHandler>[0]) => {
      expect(input.prepared).toEqual(
        await persistence.phase4ReadPreparedTool(sessionId, toolRunId),
      );
      expect(input.idempotencyKey).toBe("trusted-original-key");
      expect(Object.isFrozen(input.prepared?.request)).toBe(true);
      throw new Error("lost response after write");
    },
  );
  const host = new Phase3DecisionHost({
    sessionId,
    persistence,
    clock,
    wallClockMs: Date.now,
    provider,
    model: "fixture",
    instructions: "fixture",
    grantedCapabilities: ["memory.write"],
    confirmation: { confirm },
    registerTools: (runtime) =>
      runtime.registerTool(
        {
          name: "prepared_probe",
          version: 1,
          description: "Trusted request fixture",
          inputSchema: {
            type: "object",
            properties: { target: { type: "string" } },
            required: ["target"],
            additionalProperties: false,
          },
          outputMaxBytes: 1024,
          sensitiveOutputFields: [],
          executionMode: "keyed",
          semantic: "idempotent",
          resource: "memory",
          keyArgument: "target",
          timeoutMs: 5000,
          cancellable: true,
          maxConcurrency: 1,
          requiredCapabilities: ["memory.write"],
          requiresConfirmation: true,
          cache: null,
        },
        handler,
        { providerId: "iris", prepare },
      ),
  });
  try {
    await persistence.migrate();
    await persistence.ensureSession({
      sessionId,
      createdAtMs: 1,
      trace: { traceId: "1".repeat(32) },
    });
    provider.setNextScript([
      { type: "started" },
      {
        type: "tool_call_start",
        toolRunId,
        toolName: "prepared_probe",
        idempotencyKey: "model-key",
      },
      { type: "tool_args", toolRunId, delta: '{"target":"tea"}' },
      { type: "tool_call_end", toolRunId },
      { type: "next", next: "after_tools" },
      { type: "final" },
    ]);
    await host.start();
    await host.ingest({
      schemaVersion: 1,
      id: randomUUID(),
      kind: "danmaku",
      source: "trusted-fixture",
      occurredAt: Date.now(),
      priority: 100,
      payload: { userId: "u", text: "correct tea" },
    });
    await vi.waitFor(() => expect(provider.requests).toHaveLength(2), { timeout: 5000 });
    await vi.waitFor(() => expect(host.loop.isIdle()).toBe(true));
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    const prepared = await persistence.phase4ReadPreparedTool(sessionId, toolRunId);
    expect(prepared).toMatchObject({
      request: actualRequest,
      idempotencyKey: "trusted-original-key",
    });
    expect((await host.readDecisionState()).toolRuns[0]).toMatchObject({
      state: "uncertain",
      errorCode: "tool_outcome_unknown",
    });
    await host.close();
    await persistence.close();
    persistence = createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
    await persistence.migrate();
    expect(await persistence.phase4ReadPreparedTool(sessionId, toolRunId)).toEqual(prepared);
    expect(await persistence.phase4ReadToolCall(sessionId, toolRunId)).toMatchObject({
      idempotencyKey: "model-key",
    });
    expect(handler).toHaveBeenCalledTimes(1);
  } finally {
    await host.close();
    await persistence.close();
    cleanupTempDataDirectory(dataDirectory);
  }
});

it("binds an unused bootstrap host, restores the actual Session, and uses that identity for adopted tools", async () => {
  const dataDirectory = createTempDataDirectory("phase4-session-binding-");
  const persistence = createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
  const clock = new SystemMonotonicClock();
  const provider = new DemoScriptedProvider({ clock });
  const bootstrap = randomUUID(),
    sessionId = randomUUID(),
    toolRunId = randomUUID();
  const trace = { traceId: "1".repeat(32) };
  const seen: string[] = [];
  const host = new Phase3DecisionHost({
    sessionId: bootstrap,
    persistence,
    clock,
    wallClockMs: Date.now,
    provider,
    model: "fixture",
    instructions: "fixture",
    registerTools: (runtime) =>
      runtime.registerTool(
        {
          name: "identity_probe",
          version: 1,
          description: "Return the trusted Session identity",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          outputMaxBytes: 1024,
          sensitiveOutputFields: [],
          executionMode: "parallel_read",
          semantic: "pure",
          resource: null,
          keyArgument: null,
          timeoutMs: 1000,
          cancellable: true,
          maxConcurrency: 1,
          requiredCapabilities: [],
          requiresConfirmation: false,
          cache: null,
        },
        async ({ context }) => {
          seen.push(context.sessionId);
          return { value: context.sessionId };
        },
      ),
  });
  try {
    await persistence.migrate();
    for (const id of [bootstrap, sessionId])
      await persistence.ensureSession({ sessionId: id, createdAtMs: 1, trace });
    await persistence.phase3AppendSignal({
      sessionId,
      signal: {
        schemaVersion: 1,
        id: randomUUID(),
        kind: "danmaku",
        source: "recovery-fixture",
        occurredAt: Date.now(),
        priority: 100,
        payload: { userId: "u", text: "restored input" },
      },
      priorityClass: "normal",
      receivedAtMs: Date.now(),
      normalCapacity: 100,
      urgentCapacity: 10,
      trace,
    });
    provider.setNextScript([
      { type: "started" },
      { type: "tool_call_start", toolRunId, toolName: "identity_probe" },
      { type: "tool_args", toolRunId, delta: "{}" },
      { type: "tool_call_end", toolRunId },
      { type: "next", next: "after_tools" },
      { type: "final" },
    ]);
    await host.start();
    host.bindSessionId(sessionId);
    // Read waits for the new Session recovery; no caller timing assumption is required.
    await host.readDecisionState();
    expect(host.recoveryEvidence?.pendingRebuilt).toBe(1);
    await vi.waitFor(() => expect(seen).toEqual([sessionId]), { timeout: 5000 });
    await vi.waitFor(() => expect(host.loop.isIdle()).toBe(true));
    const state = await persistence.phase3ReadDecisionState(sessionId);
    expect(state.toolRuns).toEqual([expect.objectContaining({ toolRunId, state: "succeeded" })]);
    expect(await persistence.phase4ReadToolCall(sessionId, toolRunId)).toMatchObject({
      toolRunId,
      arguments: {},
    });
    expect(await persistence.phase3ReadDecisionState(bootstrap)).toMatchObject({
      consumed: 0n,
      cycles: [],
      toolRuns: [],
    });
    expect(() => host.bindSessionId(randomUUID())).toThrow("already owns work");
    expect(() => host.bindSessionId(sessionId)).not.toThrow();
  } finally {
    await host.close();
    await persistence.close();
    cleanupTempDataDirectory(dataDirectory);
  }
});

it("persists unknown write effects and tells the next Cycle to reconcile the original call", async () => {
  const dataDirectory = createTempDataDirectory("phase4-unknown-tool-");
  const persistence = createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
  const clock = new SystemMonotonicClock();
  const provider = new DemoScriptedProvider({ clock });
  const sessionId = randomUUID(),
    toolRunId = randomUUID();
  let effects = 0;
  const host = new Phase3DecisionHost({
    sessionId,
    persistence,
    clock,
    wallClockMs: Date.now,
    provider,
    model: "fixture",
    instructions: "fixture",
    grantedCapabilities: ["memory.write"],
    registerTools: (runtime) =>
      runtime.registerTool(
        {
          name: "write_probe",
          version: 1,
          description: "Unknown write fixture",
          inputSchema: {
            type: "object",
            properties: { target: { type: "string" } },
            required: ["target"],
            additionalProperties: false,
          },
          outputMaxBytes: 1024,
          sensitiveOutputFields: [],
          executionMode: "keyed",
          semantic: "idempotent",
          resource: "memory",
          keyArgument: "target",
          timeoutMs: 1000,
          cancellable: true,
          maxConcurrency: 1,
          requiredCapabilities: ["memory.write"],
          requiresConfirmation: false,
          cache: null,
        },
        async () => {
          effects++;
          throw new Error("response lost after effect");
        },
      ),
  });
  try {
    await persistence.migrate();
    await persistence.ensureSession({
      sessionId,
      createdAtMs: 1,
      trace: { traceId: "1".repeat(32) },
    });
    provider.setNextScript([
      { type: "started" },
      {
        type: "tool_call_start",
        toolRunId,
        toolName: "write_probe",
        idempotencyKey: "durable-original-key",
      },
      { type: "tool_args", toolRunId, delta: '{"target":"self"}' },
      { type: "tool_call_end", toolRunId },
      { type: "next", next: "after_tools" },
      { type: "final" },
    ]);
    await host.start();
    await host.ingest({
      schemaVersion: 1,
      id: randomUUID(),
      kind: "danmaku",
      source: "trusted-fixture",
      occurredAt: Date.now(),
      priority: 100,
      payload: { userId: "u", text: "write" },
    });
    await vi.waitFor(() => expect(provider.requests).toHaveLength(2), { timeout: 5000 });
    await vi.waitFor(() => expect(host.loop.isIdle()).toBe(true));
    expect(effects).toBe(1);
    expect(provider.requests[1]?.prompt).toContain("远端写入结果未知");
    expect(provider.requests[1]?.prompt).not.toContain("response lost after effect");
    expect((await host.readDecisionState()).toolRuns[0]).toMatchObject({
      state: "uncertain",
      errorCode: "tool_outcome_unknown",
    });
    expect(await persistence.phase4ReadToolCall(sessionId, toolRunId)).toMatchObject({
      arguments: { target: "self" },
      idempotencyKey: "durable-original-key",
    });
  } finally {
    await host.close();
    await persistence.close();
    cleanupTempDataDirectory(dataDirectory);
  }
});

it("confirms a durable concrete call and cancels before effects when the Session closes", async () => {
  const dataDirectory = createTempDataDirectory("phase4-confirmed-tool-");
  const persistence = createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
  const clock = new SystemMonotonicClock();
  const provider = new DemoScriptedProvider({ clock });
  const sessionId = randomUUID(),
    toolRunId = randomUUID();
  let effects = 0;
  let approve: ((value: boolean) => void) | undefined;
  let approvalSignal: AbortSignal | undefined;
  const host = new Phase3DecisionHost({
    sessionId,
    persistence,
    clock,
    wallClockMs: Date.now,
    provider,
    model: "fixture",
    instructions: "fixture",
    grantedCapabilities: ["memory.forget"],
    confirmation: {
      confirm: async (request) => {
        const persisted = await persistence.phase4ReadToolCall(
          request.sessionId,
          request.toolRunId,
        );
        expect(persisted?.arguments).toEqual(request.arguments);
        expect(request).toMatchObject({
          sessionId,
          toolRunId,
          toolName: "forget_probe",
          arguments: { target: "claim" },
        });
        approvalSignal = request.signal;
        return new Promise<boolean>((resolve) => {
          approve = resolve;
        });
      },
    },
    registerTools: (runtime) =>
      runtime.registerTool(
        {
          name: "forget_probe",
          version: 1,
          description: "Confirmation fixture",
          inputSchema: {
            type: "object",
            properties: { target: { type: "string" } },
            required: ["target"],
            additionalProperties: false,
          },
          outputMaxBytes: 1024,
          sensitiveOutputFields: [],
          executionMode: "keyed",
          semantic: "idempotent",
          resource: "memory",
          keyArgument: "target",
          timeoutMs: 5000,
          cancellable: true,
          maxConcurrency: 1,
          requiredCapabilities: ["memory.forget"],
          requiresConfirmation: true,
          cache: null,
        },
        async () => {
          effects++;
          return { value: "deleted" };
        },
      ),
  });
  try {
    await persistence.migrate();
    await persistence.ensureSession({
      sessionId,
      createdAtMs: 1,
      trace: { traceId: "1".repeat(32) },
    });
    provider.setNextScript([
      { type: "started" },
      {
        type: "tool_call_start",
        toolRunId,
        toolName: "forget_probe",
        idempotencyKey: "frozen-forget-key",
      },
      { type: "tool_args", toolRunId, delta: '{"target":"claim"}' },
      { type: "tool_call_end", toolRunId },
      { type: "next", next: "after_tools" },
      { type: "final" },
    ]);
    await host.start();
    await host.ingest({
      schemaVersion: 1,
      id: randomUUID(),
      kind: "danmaku",
      source: "trusted-fixture",
      occurredAt: Date.now(),
      priority: 100,
      payload: { userId: "u", text: "forget" },
    });
    await vi.waitFor(() => expect(approve).toBeTypeOf("function"), { timeout: 5000 });
    expect(effects).toBe(0);
    await host.close();
    expect(approvalSignal?.aborted).toBe(true);
    expect((await persistence.phase3ReadDecisionState(sessionId)).toolRuns[0]).toMatchObject({
      state: "cancelled",
      errorCode: "confirmation_cancelled",
    });
    approve!(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(effects).toBe(0);
    expect(provider.requests).toHaveLength(1);
  } finally {
    approve?.(false);
    await host.close();
    await persistence.close();
    cleanupTempDataDirectory(dataDirectory);
  }
});
