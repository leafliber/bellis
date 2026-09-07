import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createPersistenceClient } from "@bellis/persistence";
import {
  Phase4MemoryHost,
  type Phase4MemoryOptions,
} from "../../src/application/phase-4/memory-host.js";
import { WORKER_FIXTURE, createTempDataDirectory, cleanupTempDataDirectory } from "../helpers.js";

it("restores the Session scope before provider startup, rejects retargeting, and preserves a pending privacy barrier", async () => {
  const dataDirectory = createTempDataDirectory("phase4-scope-");
  let persistence = createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
  const sessionId = randomUUID();
  let starts = 0;
  const options: Phase4MemoryOptions = {
    appInstanceId: "scope-integration",
    agentId: "agent",
    spaceId: "space",
    scope: { kind: "space", acknowledgeCrossSession: true },
    identityScope: "self",
    privacyScope: "space",
    privacyRevision: "1",
    publicLabels: ["space"],
    personaSource: {
      id: "fixture",
      start: async () => {
        starts++;
      },
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
  };
  const hosts: Phase4MemoryHost[] = [];
  const makeHost = (overrides: Partial<Phase4MemoryOptions> = {}, localSession = sessionId) => {
    const memory = new Phase4MemoryHost({ ...options, ...overrides }, localSession, persistence);
    hosts.push(memory);
    return memory;
  };
  try {
    await persistence.migrate();
    await persistence.ensureSession({
      sessionId,
      createdAtMs: 0,
      trace: { traceId: "1".repeat(32) },
    });
    const initial = makeHost();
    await initial.start();
    const stamp = initial.policyStamp!;
    expect(starts).toBe(1);
    await initial.stop();
    // No Signal or adoption has occurred: startup alone must persist the binding.
    expect((await persistence.phase3ReadDecisionState(sessionId)).consumed).toBe(0n);
    await persistence.close();
    persistence = createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
    await persistence.migrate();
    for (const change of [
      { appInstanceId: "other-app" },
      { agentId: "other-agent" },
      { spaceId: "other-space" },
      { identityScope: "other-identity" },
      { privacyScope: "other-privacy" },
      { privacyRevision: "2" },
    ]) {
      await expect(makeHost(change).start()).rejects.toMatchObject({ code: "invalid_request" });
      expect(starts).toBe(1);
    }
    const restored = makeHost();
    await restored.start();
    expect(restored.policyStamp).toEqual(stamp);
    await restored.stop();
    // Explicit space mode accepts a different local Session sharing the same scope.
    const nextSession = randomUUID();
    await persistence.ensureSession({
      sessionId: nextSession,
      createdAtMs: 0,
      trace: { traceId: "2".repeat(32) },
    });
    const next = makeHost({}, nextSession);
    await next.start();
    expect(next.policyStamp).toEqual(stamp);
    await next.stop();
    await persistence.phase4ChangeMemoryPolicy({
      scopeKey: stamp.scopeKey,
      expectedGeneration: stamp.generation,
      changeId: randomUUID(),
      privacyRevision: "1",
      blocked: true,
      reason: "resource-invalidated",
      tombstones: [],
    });
    const blocked = makeHost();
    await blocked.start();
    expect(blocked.policyStamp?.generation).toBe(stamp.generation + 1);
    expect((await persistence.phase4ReadMemoryPolicy(stamp.scopeKey)).blocked).toBe(true);
    // Failed binding never leaves behind a new policy row (same transaction).
    const rejectedScope = "f".repeat(64);
    await expect(
      persistence.phase4EnsureMemoryPolicy(rejectedScope, "1", sessionId),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(persistence.phase4ReadMemoryPolicy(rejectedScope)).rejects.toMatchObject({
      code: "invalid_request",
    });
  } finally {
    for (const memory of hosts) await memory.stop();
    await persistence.close();
    cleanupTempDataDirectory(dataDirectory);
  }
});
