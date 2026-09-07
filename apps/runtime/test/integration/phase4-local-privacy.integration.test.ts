import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createPersistenceClient } from "@bellis/persistence";
import { SystemMonotonicClock } from "@bellis/transport";
import type { ModelRequest } from "@bellis/decision-loop";
import { Phase3DecisionHost } from "../../src/application/phase-3/host.js";
import { Phase4MemoryHost } from "../../src/application/phase-4/memory-host.js";
import { WORKER_FIXTURE, createTempDataDirectory, cleanupTempDataDirectory } from "../helpers.js";

const input = (id: string, text: string) => ({
  schemaVersion: 1 as const,
  id,
  kind: "danmaku",
  source: "trusted",
  priority: 100,
  occurredAt: 1,
  payload: { userId: "viewer", text },
});

it("filters restored old Signals and post-change tool data in real Decision Host requests and durable manifests", async () => {
  const dataDirectory = createTempDataDirectory("phase4-local-privacy-");
  const persistence = createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
  const clock = new SystemMonotonicClock(),
    sessionId = randomUUID(),
    toolRunId = randomUUID();
  const requests: ModelRequest[] = [];
  const memory = new Phase4MemoryHost(
    {
      appInstanceId: "privacy-integration",
      agentId: "agent",
      spaceId: "space",
      identityScope: "self",
      privacyScope: "space",
      privacyRevision: "1",
      publicLabels: ["space"],
      scope: { kind: "space", acknowledgeCrossSession: true },
      personaSource: {
        id: "fixture",
        current: async () => ({
          agentId: "agent",
          revision: "1",
          contentHash: "a".repeat(64),
          policyMode: "locked",
          core: {},
          traits: {},
          narrative: {},
          state: null,
          effectiveFrom: 1,
          fetchedAt: 1,
          origin: "live",
        }),
      },
      providers: [],
      actors: () => [],
    },
    sessionId,
    persistence,
  );
  const host = new Phase3DecisionHost({
    sessionId,
    persistence,
    clock,
    wallClockMs: Date.now,
    model: "fixture",
    instructions: "fixture",
    contextBuilder: memory,
    provider: {
      name: "fixture",
      async *streamDecision(request) {
        requests.push(request);
        yield { type: "started" };
        if (requests.length === 1) {
          yield { type: "tool_call_start", toolRunId, toolName: "privacy_probe" };
          yield { type: "tool_args", toolRunId, delta: "{}" };
          yield { type: "tool_call_end", toolRunId };
          yield { type: "next", next: "after_tools" };
        } else yield { type: "next", next: "finish" };
        yield { type: "final" };
      },
    },
    registerTools: (runtime) =>
      runtime.registerTool(
        {
          name: "privacy_probe",
          version: 1,
          description: "Privacy transition fixture",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          outputMaxBytes: 1024,
          sensitiveOutputFields: [],
          executionMode: "parallel_read",
          semantic: "pure",
          resource: null,
          keyArgument: null,
          timeoutMs: 5000,
          cancellable: true,
          maxConcurrency: 1,
          requiredCapabilities: [],
          requiresConfirmation: false,
          cache: null,
        },
        async () => {
          await memory.changePrivacy({
            changeId: randomUUID(),
            privacyRevision: "3",
            blocked: false,
            reason: "privacy",
            tombstones: [],
          });
          return { value: "PRIVATE_TOOL_FROM_OLD_GENERATION" };
        },
      ),
  });
  const oldId = randomUUID(),
    newId = randomUUID();

  try {
    await persistence.migrate();
    await persistence.ensureSession({
      sessionId,
      createdAtMs: 1,
      trace: { traceId: "1".repeat(32) },
    });
    await memory.start();
    await persistence.phase3AppendSignal({
      sessionId,
      signal: input(oldId, "PRIVATE_RESTORED_SIGNAL"),
      policy: memory.policyStamp!,
      priorityClass: "normal",
      receivedAtMs: 1,
      normalCapacity: 256,
      urgentCapacity: 32,
      trace: { traceId: "1".repeat(32) },
    });
    await memory.changePrivacy({
      changeId: randomUUID(),
      privacyRevision: "2",
      blocked: false,
      reason: "privacy",
      tombstones: [],
    });
    await host.start();
    await host.ingest(input(newId, "ALLOWED_CURRENT_SIGNAL"));
    await vi.waitFor(() => expect(requests).toHaveLength(2), { timeout: 5000 });
    await vi.waitFor(() => expect(host.loop.isIdle()).toBe(true));
    expect(requests[0]?.prompt).toContain("ALLOWED_CURRENT_SIGNAL");
    expect(requests.every((request) => !request.prompt.includes("PRIVATE"))).toBe(true);
    expect(requests[1]?.prompt).toContain("failed");
    const first = await persistence.phase4ReadContextManifest(sessionId, requests[0]!.cycleId);
    const second = await persistence.phase4ReadContextManifest(sessionId, requests[1]!.cycleId);
    expect(first?.manifest.localInputs?.signals).toEqual(
      expect.arrayContaining([
        { signalId: oldId, result: "stale_policy" },
        { signalId: newId, result: "included" },
      ]),
    );
    expect(second?.manifest.localInputs?.tools).toEqual([{ toolRunId, result: "stale_policy" }]);
    expect(second?.manifest.policy?.generation).toBe(2);
    expect((await host.readDecisionState()).toolRuns[0]?.state).toBe("succeeded");
  } finally {
    await host.close();
    await memory.stop();
    await persistence.close();
    clock.close();
    cleanupTempDataDirectory(dataDirectory);
  }
});
