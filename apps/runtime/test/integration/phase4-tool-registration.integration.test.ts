import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { RuntimeHandle, RuntimeOptions } from "../../src/index.js";
import { DemoScriptedProvider } from "../../src/providers/model/demo-scripted.js";
import { createTempDataDirectory, cleanupTempDataDirectory, startTestRuntime } from "../helpers.js";

it("assembles trusted tool capabilities, preparation and confirmation through the application lifecycle", async () => {
  const directory = createTempDataDirectory("phase4-tool-registration-");
  let handle: RuntimeHandle | undefined;
  const confirm = vi.fn(async (request: import("@bellis/tool-runtime").ToolConfirmationRequest) => {
    expect(request.prepared?.request).toEqual({ agent: "trusted-agent", value: "tea" });
    return true;
  });
  const handler = vi.fn(async ({ idempotencyKey }: { idempotencyKey: string | null }) => {
    expect(idempotencyKey).toBe("trusted-key");
    return { value: "done" };
  });
  try {
    handle = await startTestRuntime({
      dataDirectory: directory,
      phase2: { enabled: true },
      phase3: { enabled: true, model: { paceMs: 1 } },
      tools: {
        grantedCapabilities: ["memory.write"],
        confirmation: { confirm },
        register: (runtime, context) => {
          expect(context.memory).toBeNull();
          runtime.registerTool(
            {
              name: "remember",
              version: 1,
              description: "Lifecycle fixture",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
              outputMaxBytes: 1024,
              sensitiveOutputFields: [],
              executionMode: "parallel_read",
              semantic: "idempotent",
              resource: null,
              keyArgument: null,
              timeoutMs: 5000,
              cancellable: true,
              maxConcurrency: 1,
              requiredCapabilities: ["memory.write"],
              requiresConfirmation: true,
              cache: null,
            },
            handler,
            {
              providerId: "iris",
              prepare: async () => ({
                idempotencyKey: "trusted-key",
                request: { agent: "trusted-agent", value: "tea" },
                confirmation: { action: "remember" },
                resources: [],
              }),
            },
          );
        },
      },
    });
    const host = handle.phase3!;
    expect(host.toolRuntime.listDeclarations().map((item) => item.name)).toEqual(["remember"]);
    const toolRunId = randomUUID();
    const provider = host.modelProvider as DemoScriptedProvider;
    provider.setNextScript([
      { type: "started" },
      { type: "tool_call_start", toolRunId, toolName: "remember" },
      { type: "tool_args", toolRunId, delta: "{}" },
      { type: "tool_call_end", toolRunId },
      { type: "next", next: "after_tools" },
      { type: "final" },
    ]);
    await host.ingest({
      schemaVersion: 1,
      id: randomUUID(),
      kind: "danmaku",
      source: "trusted-fixture",
      occurredAt: Date.now(),
      priority: 100,
      payload: { userId: "user", text: "remember tea" },
    });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await vi.waitFor(() => expect(host.loop.isIdle()).toBe(true));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect((await host.readDecisionState()).toolRuns[0]).toMatchObject({ state: "succeeded" });
  } finally {
    await handle?.close();
    cleanupTempDataDirectory(directory);
  }
});

it("rejects disabled hosts and cleans up storage after registration failure", async () => {
  const directory = createTempDataDirectory("phase4-tool-registration-failure-");
  const tools: NonNullable<RuntimeOptions["tools"]> = {
    grantedCapabilities: [],
    register: () => {
      throw new Error("registration rejected");
    },
  };
  try {
    await expect(startTestRuntime({ dataDirectory: directory, tools })).rejects.toThrow(
      "tool integration requires",
    );
    await expect(
      startTestRuntime({
        dataDirectory: directory,
        phase2: { enabled: true },
        phase3: { enabled: true },
        tools,
      }),
    ).rejects.toThrow("registration rejected");
    const recovered = await startTestRuntime({ dataDirectory: directory });
    expect(recovered.status.ready).toBe(true);
    await recovered.close();
  } finally {
    cleanupTempDataDirectory(directory);
  }
});
