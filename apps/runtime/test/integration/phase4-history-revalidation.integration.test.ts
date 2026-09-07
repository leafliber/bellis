import type { MemoryProvider } from "@bellis/contracts/memory";
import { createHash, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createPersistenceClient } from "@bellis/persistence";
import type {
  MemoryRecallRequest,
  MemoryRecallVerification,
  MemoryRecallVerifier,
} from "@bellis/contracts";
import { startRuntime, type RuntimeHandle } from "../../src/index.js";
import {
  Phase4MemoryHost,
  type Phase4MemoryOptions,
} from "../../src/application/phase-4/memory-host.js";
import { Phase4HistoryRevalidator } from "../../src/application/phase-4/history-revalidator.js";
import { WORKER_FIXTURE, createTempDataDirectory, cleanupTempDataDirectory } from "../helpers.js";

const scopeKey = createHash("sha256")
    .update(JSON.stringify(["maintenance", "agent", "space", "identity", "space:space"]))
    .digest("hex"),
  identity = { scopeKey, providerId: "iris", agentId: "agent", spaceId: "space" };
const gap = {
  schemaVersion: 1 as const,
  providerId: "iris",
  agentId: "agent",
  gapId: "a".repeat(64),
  cursor: "9",
  reason: "history_unavailable" as const,
};
const result = (requests: readonly MemoryRecallRequest[]): MemoryRecallVerification => ({
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  results: requests.map((r) => ({
    requestId: r.requestId,
    status: r.requestId === "q-1" ? "unavailable" : "valid",
  })),
});
async function fixture(count = 2, withGap = true) {
  const directory = createTempDataDirectory("history-revalidation-");
  const make = () => createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
  const client = make(),
    sessionId = randomUUID();
  await client.migrate();
  await client.ensureSession({ sessionId, createdAtMs: 0, trace: { traceId: "1".repeat(32) } });
  await client.phase4EnsureMemoryPolicy(scopeKey, "1", sessionId);
  for (let i = 0; i < count; i++) {
    const requestId = `q-${i % 17}`;
    await client.phase4RecordRecallRequest({
      policy: { scopeKey, generation: 0 },
      providerId: "iris",
      sessionId,
      request: {
        schemaVersion: 1,
        attemptId: randomUUID(),
        requestId,
        agentId: "agent",
        spaceId: "space",
        body: {
          request_id: requestId,
          scope: { agent_id: "agent", space_id: "space" },
          topic: "original",
        },
      },
    });
  }
  await client.phase4WriteProviderState({
    scopeKey,
    providerId: "iris",
    expectedRevision: 0,
    state: { original: true },
  });
  if (withGap) await client.phase4BeginHistoryGap(scopeKey, gap);
  const input = {
    runId: randomUUID(),
    scopeKey,
    providerId: "iris",
    gapId: gap.gapId,
    generation: 0,
  };
  const f = {
    directory,
    sessionId,
    client,
    input,
    async restart() {
      await f.client.close();
      f.client = make();
      await f.client.migrate();
    },
    async close() {
      await f.client.close();
      cleanupTempDataDirectory(directory);
    },
  };
  return f;
}

it("batches actual stored attempts without duplicate request ids, resumes durable coverage after restart and keeps the gap", async () => {
  const f = await fixture(20);
  const verify = vi.fn(async (requests: readonly MemoryRecallRequest[]) => {
    expect(requests.length).toBeLessThanOrEqual(16);
    expect(new Set(requests.map((r) => r.requestId)).size).toBe(requests.length);
    expect(requests.every((r) => r.body.topic === "original")).toBe(true);
    return result(requests);
  });
  try {
    const coordinator = new Phase4HistoryRevalidator(f.client, { id: "iris", verify }, identity);
    const progress = await coordinator.resume(new AbortController().signal);
    expect(progress.validRequests + progress.unavailableRequests).toBe(20);
    expect(progress.uncheckedItems).toBe(1);
    expect(progress.status).toBe("incomplete");
    expect(verify.mock.calls.length).toBeGreaterThanOrEqual(2);
    coordinator.stop();
    await f.restart();
    verify.mockClear();
    const recovered = new Phase4HistoryRevalidator(f.client, { id: "iris", verify }, identity);
    expect(await recovered.resume(new AbortController().signal)).toEqual(progress);
    expect(verify).not.toHaveBeenCalled();
    expect((await f.client.phase4ReadMemoryPolicy(scopeKey)).historyBlocked).toBe(true);
    recovered.stop();
  } finally {
    await f.close();
  }
});

it("retains cancellation ownership and does not persist late responses or accept mismatched verdicts", async () => {
  const f = await fixture();
  let release!: (value: MemoryRecallVerification) => void;
  const verify = vi.fn((requests: readonly MemoryRecallRequest[]) => {
    expect(requests).toHaveLength(2);
    return new Promise<MemoryRecallVerification>((resolve) => {
      release = resolve;
    });
  });
  const coordinator = new Phase4HistoryRevalidator(f.client, { id: "iris", verify }, identity);
  try {
    const cancel = new AbortController(),
      running = coordinator.run(f.input, cancel.signal);
    await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce());
    cancel.abort(new Error("cancel-run"));
    await expect(running).rejects.toThrow("cancel-run");
    await expect(coordinator.run(f.input, new AbortController().signal)).rejects.toThrow("busy");
    release(result(verify.mock.calls[0]![0]));
    await vi.waitFor(async () =>
      expect(
        (
          await f.client.phase4ReadHistoryVerificationPage({
            runId: f.input.runId,
            after: 0,
            limit: 64,
          })
        ).items.every((item) => item.verification === null),
      ).toBe(true),
    );
    const wrong: MemoryRecallVerifier = {
      id: "iris",
      verify: async () => ({
        schemaVersion: 1,
        checkedAt: new Date().toISOString(),
        results: [{ requestId: "foreign", status: "valid" }],
      }),
    };
    await expect(
      new Phase4HistoryRevalidator(f.client, wrong, identity).run(
        f.input,
        new AbortController().signal,
      ),
    ).rejects.toThrow("mismatch");
    expect((await f.client.phase4ReadMemoryPolicy(scopeKey)).historyBlocked).toBe(true);
    coordinator.stop();
    await expect(coordinator.run(f.input, new AbortController().signal)).rejects.toThrow("stopped");
  } finally {
    coordinator.stop();
    await f.close();
  }
});

it("refuses late response writes after policy changes and does not transmit privacy-blocked or older-generation requests", async () => {
  const f = await fixture();
  const change = (blocked: boolean, generation: number) =>
    f.client.phase4ChangeMemoryPolicy({
      scopeKey,
      expectedGeneration: generation,
      changeId: randomUUID(),
      privacyRevision: String(generation + 2),
      blocked,
      reason: "privacy",
      tombstones: [],
    });
  try {
    const verify = vi.fn(async (requests: readonly MemoryRecallRequest[]) => {
      await change(true, 0);
      return result(requests);
    });
    await expect(
      new Phase4HistoryRevalidator(f.client, { id: "iris", verify }, identity).run(
        f.input,
        new AbortController().signal,
      ),
    ).rejects.toBeDefined();
    const blockedRun = { ...f.input, runId: randomUUID(), generation: 1 };
    verify.mockClear();
    await expect(
      new Phase4HistoryRevalidator(f.client, { id: "iris", verify }, identity).run(
        blockedRun,
        new AbortController().signal,
      ),
    ).rejects.toBeDefined();
    expect(verify).not.toHaveBeenCalled();
    await change(false, 1);
    const next = { ...f.input, runId: randomUUID(), generation: 2 };
    const progress = await new Phase4HistoryRevalidator(
      f.client,
      { id: "iris", verify },
      identity,
    ).run(next, new AbortController().signal);
    expect(progress).toMatchObject({
      validRequests: 0,
      unavailableRequests: 0,
      uncheckedItems: 3,
      status: "incomplete",
    });
    expect(verify).not.toHaveBeenCalled();
    expect((await f.client.phase4ReadMemoryPolicy(scopeKey)).historyBlocked).toBe(true);
  } finally {
    await f.close();
  }
});

it("resumes a committed verification after a lost Worker acknowledgment without repeating remote verification", async () => {
  const f = await fixture();
  const verify = vi.fn(async (requests: readonly MemoryRecallRequest[]) => result(requests));
  try {
    const storage = {
      phase4ReadHistoryRecoveryState: f.client.phase4ReadHistoryRecoveryState,
      phase4BeginHistoryInventory: f.client.phase4BeginHistoryInventory,
      phase4ReadHistoryVerificationPage: f.client.phase4ReadHistoryVerificationPage,
      phase4ReadRevalidationRequest: f.client.phase4ReadRevalidationRequest,
      phase4RecordHistoryVerification: async (
        batch: Parameters<typeof f.client.phase4RecordHistoryVerification>[0],
      ) => {
        await f.client.phase4RecordHistoryVerification(batch);
        throw new Error("lost-verification-ack");
      },
    };
    await expect(
      new Phase4HistoryRevalidator(storage, { id: "iris", verify }, identity).run(
        f.input,
        new AbortController().signal,
      ),
    ).rejects.toThrow("lost-verification-ack");
    expect(verify).toHaveBeenCalledOnce();
    await f.restart();
    const progress = await new Phase4HistoryRevalidator(
      f.client,
      { id: "iris", verify },
      identity,
    ).run(f.input, new AbortController().signal);
    expect(progress).toMatchObject({
      validRequests: 1,
      unavailableRequests: 1,
      uncheckedItems: 1,
      status: "incomplete",
    });
    expect(verify).toHaveBeenCalledOnce();
    expect((await f.client.phase4ReadMemoryPolicy(scopeKey)).historyBlocked).toBe(true);
  } finally {
    await f.close();
  }
});

function maintenanceOptions(): Phase4MemoryOptions {
  const provider = {
    id: "iris",
    capabilities: async () => ({
      schemaVersion: 1 as const,
      providerVersion: "fixture",
      healthy: true,
      categories: [],
      placements: [],
      observe: false,
      usageReport: false,
      persona: true,
    }),
    provideContext: async (): Promise<never> => {
      throw new Error("not used");
    },
    current: async () => ({
      agentId: "agent",
      revision: "1",
      contentHash: "a".repeat(64),
      policyMode: "locked" as const,
      core: {},
      traits: {},
      narrative: {},
      state: null,
      effectiveFrom: 0,
      fetchedAt: 0,
      origin: "live" as const,
    }),
  };
  return {
    appInstanceId: "maintenance",
    agentId: "agent",
    spaceId: "space",
    identityScope: "identity",
    privacyScope: "space:space",
    privacyRevision: "1",
    publicLabels: ["space:space"],
    scope: { kind: "space", acknowledgeCrossSession: true },
    personaSource: provider,
    providers: [{ provider, hashScheme: "sha256-text-v1" }],
    actors: () => [],
    refreshIntervalMs: 60000,
  };
}

function maintenanceHost(client: ReturnType<typeof createPersistenceClient>, sessionId: string) {
  return new Phase4MemoryHost(maintenanceOptions(), sessionId, client);
}

it.each(["privacy", "close"])(
  "cancels host-owned maintenance before %s and retains the gap after a late verdict",
  async (transition) => {
    const f = await fixture(2, false);
    let release!: () => void;
    let verificationSignal: AbortSignal | undefined;
    const verify = vi.fn(async (requests: readonly MemoryRecallRequest[], signal: AbortSignal) => {
      verificationSignal = signal;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return result(requests);
    });
    const memory = maintenanceHost(f.client, f.sessionId);
    try {
      await memory.start();
      await f.client.phase4BeginHistoryGap(scopeKey, gap);
      const coordinator = memory.historyRevalidator({ id: "iris", verify });
      const running = coordinator.resume(new AbortController().signal);
      const rejected = expect(running).rejects.toBeDefined();
      await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce());
      if (transition === "privacy") {
        const changing = memory.changePrivacy({
          changeId: randomUUID(),
          privacyRevision: "2",
          blocked: true,
          reason: "privacy",
          tombstones: [],
        });
        expect(verificationSignal?.aborted).toBe(true);
        await changing;
      } else await memory.stop();
      expect(verificationSignal?.aborted).toBe(true);
      await rejected;
      release();
      // The old caller cannot restart after the host epoch/close boundary.
      await expect(coordinator.resume(new AbortController().signal)).rejects.toBeDefined();
      expect((await f.client.phase4ReadMemoryPolicy(scopeKey)).historyBlocked).toBe(true);
      const state = await f.client.phase4ReadHistoryRecoveryState({ scopeKey, providerId: "iris" });
      expect(state.inventoryStatus).toBe(transition === "privacy" ? "stale" : "current");
      if (transition === "close") {
        expect(
          (
            await f.client.phase4ReadHistoryVerificationPage({
              runId: state.inventory!.runId,
              after: 0,
              limit: 64,
            })
          ).items.every((item) => item.verification === null),
        ).toBe(true);
        expect(() => memory.historyRevalidator({ id: "iris", verify })).toThrow("unavailable");
      }
    } finally {
      release?.();
      await memory.stop();
      await f.close();
    }
  },
);

it("discovers a later gap in the background, retries failures and stale results, and resumes stored coverage after restart", async () => {
  const f = await fixture(2, false);
  let memory = maintenanceHost(f.client, f.sessionId);
  const verify = vi.fn(async (requests: readonly MemoryRecallRequest[]) => result(requests));
  verify.mockRejectedValueOnce(new Error("temporary-unavailable"));
  verify.mockImplementationOnce(async (requests) => {
    await f.client.phase4WriteProviderState({
      scopeKey,
      providerId: "iris",
      expectedRevision: 1,
      state: { changedDuringVerification: true },
    });
    return result(requests);
  });
  const verifier = { id: "iris", verify };
  try {
    const worker = memory.startHistoryRecovery(verifier, { intervalMs: 100, timeoutMs: 5000 });
    expect(memory.startHistoryRecovery(verifier, { intervalMs: 100, timeoutMs: 5000 })).toBe(
      worker,
    );
    expect(() => memory.startHistoryRecovery({ id: "iris", verify }, { intervalMs: 100 })).toThrow(
      "already_registered",
    );
    await vi.waitFor(() => expect(worker.status.outcome).toBe("no_gap"));
    expect(verify).not.toHaveBeenCalled();
    await f.client.phase4BeginHistoryGap(scopeKey, gap);
    await vi.waitFor(
      () =>
        expect(worker.status.lastResult).toMatchObject({
          validRequests: 1,
          unavailableRequests: 1,
          uncheckedItems: 1,
        }),
      { timeout: 5000 },
    );
    const progress = worker.status.lastResult;
    expect(verify).toHaveBeenCalledTimes(3);
    const attempts = worker.status.attempts;
    await vi.waitFor(() => expect(worker.status.attempts).toBeGreaterThan(attempts));
    expect(verify).toHaveBeenCalledTimes(3);
    await memory.stop();
    const stoppedAt = worker.status.attempts;
    await f.restart();
    memory = maintenanceHost(f.client, f.sessionId);
    const restarted = memory.startHistoryRecovery(verifier, { intervalMs: 100, timeoutMs: 5000 });
    await vi.waitFor(() => expect(restarted.status.lastResult).toEqual(progress));
    expect(worker.status).toMatchObject({ stopped: true, attempts: stoppedAt, outcome: "stopped" });
    expect(verify).toHaveBeenCalledTimes(3);
    expect((await f.client.phase4ReadMemoryPolicy(scopeKey)).historyBlocked).toBe(true);
  } finally {
    await memory.stop();
    await f.close();
  }
});

it("retains background capacity after timeout and refuses replacement until cancelled work settles", async () => {
  const f = await fixture();
  const memory = maintenanceHost(f.client, f.sessionId);
  let release!: (value: MemoryRecallVerification) => void;
  const verify = vi.fn((requests: readonly MemoryRecallRequest[]) => {
    expect(requests).toHaveLength(2);
    return new Promise<MemoryRecallVerification>((resolve) => {
      release = resolve;
    });
  });
  const verifier = { id: "iris", verify };
  try {
    const worker = memory.startHistoryRecovery(verifier, { intervalMs: 100, timeoutMs: 1000 });
    await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce());
    await vi.waitFor(
      () =>
        expect(worker.status).toMatchObject({ pending: true, outcome: "unavailable", attempts: 1 }),
      { timeout: 5000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(worker.status.attempts).toBe(1);
    worker.stop();
    expect(() => memory.startHistoryRecovery(verifier, { intervalMs: 100 })).toThrow("busy");
    release(result(verify.mock.calls[0]![0]));
    await vi.waitFor(() => expect(worker.status.pending).toBe(false));
    verify.mockImplementation(async (requests) => result(requests));
    const replacement = memory.startHistoryRecovery(verifier, { intervalMs: 100, timeoutMs: 5000 });
    await vi.waitFor(() =>
      expect(replacement.status.lastResult).toMatchObject({
        validRequests: 1,
        unavailableRequests: 1,
      }),
    );
    expect(verify).toHaveBeenCalledTimes(2);
    expect((await f.client.phase4ReadMemoryPolicy(scopeKey)).historyBlocked).toBe(true);
  } finally {
    release?.(result([]));
    await memory.stop();
    await f.close();
  }
});

it("requires attention instead of indefinitely retrying a non-retryable verifier rejection", async () => {
  const f = await fixture();
  const memory = maintenanceHost(f.client, f.sessionId);
  const verify = vi.fn(async (): Promise<MemoryRecallVerification> => {
    throw Object.assign(new Error("rejected"), {
      retryable: false,
      code: "invalid_revalidation_response",
    });
  });
  try {
    const worker = memory.startHistoryRecovery({ id: "iris", verify }, { intervalMs: 100 });
    await vi.waitFor(() =>
      expect(worker.status).toMatchObject({
        stopped: true,
        pending: false,
        outcome: "attention",
        attempts: 1,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(verify).toHaveBeenCalledOnce();
    expect((await f.client.phase4ReadMemoryPolicy(scopeKey)).historyBlocked).toBe(true);
  } finally {
    await memory.stop();
    await f.close();
  }
});
it.each(["persisted", "startup-discovery", "live-discovery"] as const)(
  "runs Runtime maintenance for %s without reopening ordinary work",
  async (mode) => {
    const f = await fixture(2, mode === "persisted");
    const base = maintenanceOptions();
    let context: Parameters<NonNullable<MemoryProvider["start"]>>[0];
    const start = vi.fn(async (value: typeof context) => {
      context = value;
      if (mode === "startup-discovery") {
        await value.historyUnavailable!(gap, new AbortController().signal);
        throw new Error("provider history unavailable");
      }
    });
    const current = vi.fn(base.personaSource.current.bind(base.personaSource));
    const stop = vi.fn(async () => {});
    const provider = {
      ...base.providers[0]!.provider,
      ...base.personaSource,
      start,
      current,
      stop,
    };
    const verify = vi.fn(async (requests: readonly MemoryRecallRequest[]) => result(requests));
    const verifier = { id: "iris", verify };
    const recovery = { verifiers: [verifier], intervalMs: 100, timeoutMs: 5000 };
    let runtime: RuntimeHandle | undefined;
    const boot = () =>
      startRuntime({
        memory: {
          ...base,
          providers: [{ provider, hashScheme: "sha256-text-v1" }],
          personaSource: provider,
          historyRecovery: recovery,
        },
        persistenceClient: f.client,
        config: {
          dataDirectory: f.directory,
          runtimeVersion: "0.1.0-test",
          port: 0,
          phase2: { enabled: true, sessionId: f.sessionId },
          phase3: { enabled: true, sessionId: f.sessionId },
        },
      });
    try {
      runtime = await boot();
      if (mode === "live-discovery") {
        expect(runtime.status.ready).toBe(true);
        expect(runtime.phase3).not.toBeNull();
        const closeDecision = vi.spyOn(runtime.phase3!, "close");
        await context!.historyUnavailable!(gap, new AbortController().signal);
        expect(closeDecision).toHaveBeenCalledOnce();
      } else expect(runtime.phase3).toBeNull();
      expect(runtime.status.phase).toBe("recovering");
      expect(runtime.status.ready).toBe(false);
      expect(start).toHaveBeenCalledTimes(mode === "persisted" ? 0 : 1);
      expect(current).toHaveBeenCalledTimes(mode === "live-discovery" ? 1 : 0);
      const worker = runtime.memory!.startHistoryRecovery(verifier, recovery);
      await vi.waitFor(() => expect(worker.status.lastResult?.validRequests).toBe(1));
      expect(verify).toHaveBeenCalledOnce();
      const origin = `http://127.0.0.1:${runtime.status.port}`;
      expect((await fetch(`${origin}/api/v1/health/live`, { headers: { origin } })).status).toBe(
        200,
      );
      expect((await fetch(`${origin}/api/v1/health/ready`, { headers: { origin } })).status).toBe(
        503,
      );
      expect(
        (
          await fetch(`${origin}/api/v1/auth/exchange`, {
            method: "POST",
            headers: { origin, "content-type": "application/json" },
            body: JSON.stringify({ startupToken: runtime.issueStartupToken().token }),
          })
        ).status,
      ).toBe(503);
      expect((await f.client.phase4ReadMemoryPolicy(scopeKey)).historyBlocked).toBe(true);
      await runtime.close();
      expect(worker.status.stopped).toBe(true);
      const attempts = worker.status.attempts;
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(worker.status.attempts).toBe(attempts);
      await f.restart();
      start.mockClear();
      current.mockClear();
      runtime = await boot();
      expect(runtime.status.phase).toBe("recovering");
      expect(runtime.phase3).toBeNull();
      const resumed = runtime.memory!.startHistoryRecovery(verifier, recovery);
      await vi.waitFor(() => expect(resumed.status.lastResult?.validRequests).toBe(1));
      expect(start).not.toHaveBeenCalled();
      expect(current).not.toHaveBeenCalled();
      expect(verify).toHaveBeenCalledOnce();
    } finally {
      await runtime?.close();
      await f.close();
    }
  },
);

it("does not turn unrelated Provider startup failure into maintenance success", async () => {
  const f = await fixture(2, false);
  const base = maintenanceOptions();
  const verify = vi.fn(async (requests: readonly MemoryRecallRequest[]) => result(requests));
  const stop = vi.fn(async () => {});
  const provider = {
    ...base.providers[0]!.provider,
    ...base.personaSource,
    start: async () => {
      throw new Error("credentials rejected");
    },
    stop,
  };
  const memory = new Phase4MemoryHost(
    {
      ...base,
      providers: [{ provider, hashScheme: "sha256-text-v1" }],
      personaSource: provider,
      historyRecovery: { verifiers: [{ id: "iris", verify }], intervalMs: 100 },
    },
    f.sessionId,
    f.client,
  );
  try {
    await expect(memory.start()).rejects.toThrow("credentials rejected");
    expect(stop).toHaveBeenCalledOnce();
    expect(verify).not.toHaveBeenCalled();
    await expect(memory.start()).rejects.toThrow("memory_host_closed");
  } finally {
    await memory.stop();
    await f.close();
  }
});

it("closes the DB Worker when recovery configuration is invalid during Runtime assembly", async () => {
  const f = await fixture(2, false);
  const close = vi.spyOn(f.client, "close");
  try {
    await expect(
      startRuntime({
        memory: { ...maintenanceOptions(), historyRecovery: { verifiers: [] } },
        persistenceClient: f.client,
        config: {
          dataDirectory: f.directory,
          runtimeVersion: "0.1.0-test",
          port: 0,
          phase2: { enabled: true, sessionId: f.sessionId },
          phase3: { enabled: true, sessionId: f.sessionId },
        },
      }),
    ).rejects.toThrow("invalid memory history recovery configuration");
    expect(close).toHaveBeenCalledOnce();
    await expect(f.client.phase4ReadMemoryPolicy(scopeKey)).rejects.toBeDefined();
  } finally {
    await f.close();
  }
});

it("keeps Runtime unavailable for a revoked Persona and late/cached responses, then admits a new live revision and tracks privacy", async () => {
  const f = await fixture(0, false);
  const base = maintenanceOptions();
  const original = await base.personaSource.current("agent", new AbortController().signal);
  let listener:
    | ((event: import("@bellis/contracts/memory").PersonaInvalidation) => void)
    | undefined;
  let mode = "initial";
  let release!: () => void;
  const current = vi.fn(async () => {
    if (mode === "deferred") {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return original;
    }
    return mode === "initial"
      ? original
      : {
          ...original,
          revision: "2",
          contentHash: "b".repeat(64),
          origin: mode === "cached" ? ("verified-cache" as const) : ("live" as const),
        };
  });
  const provider = {
    ...base.providers[0]!.provider,
    ...base.personaSource,
    current,
    subscribe: (fn: typeof listener) => {
      listener = fn;
      return {
        dispose: () => {
          listener = undefined;
        },
      };
    },
  };
  let runtime: RuntimeHandle | undefined;
  try {
    runtime = await startRuntime({
      memory: {
        ...base,
        refreshIntervalMs: 100,
        providers: [{ provider, hashScheme: "sha256-text-v1" }],
        personaSource: provider,
      },
      persistenceClient: f.client,
      config: {
        dataDirectory: f.directory,
        runtimeVersion: "0.1.0-test",
        port: 0,
        phase2: { enabled: true, sessionId: f.sessionId },
        phase3: { enabled: true, sessionId: f.sessionId },
      },
    });
    const origin = `http://127.0.0.1:${runtime.status.port}`;
    const ready = () => fetch(`${origin}/api/v1/health/ready`, { headers: { origin } });
    expect((await ready()).status).toBe(200);
    mode = "deferred";
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    listener!({ agentId: "agent", reason: "revoked", revision: "2" });
    expect(runtime.memory!.readiness).toEqual({ ready: false, reason: "persona_unavailable" });
    expect(runtime.status.phase).toBe("unavailable");
    expect((await ready()).status).toBe(503);
    mode = "cached";
    release();
    const calls = current.mock.calls.length;
    await vi.waitFor(() => expect(current.mock.calls.length).toBeGreaterThan(calls + 1));
    expect((await ready()).status).toBe(503);
    mode = "live";
    await vi.waitFor(() => expect(runtime!.status.ready).toBe(true));
    expect((await ready()).status).toBe(200);
    await runtime.memory!.changePrivacy({
      changeId: randomUUID(),
      privacyRevision: "2",
      blocked: true,
      reason: "privacy",
      tombstones: [],
    });
    expect(runtime.memory!.readiness.reason).toBe("privacy_blocked");
    expect((await ready()).status).toBe(503);
    await runtime.memory!.changePrivacy({
      changeId: randomUUID(),
      privacyRevision: "3",
      blocked: false,
      reason: "privacy",
      tombstones: [],
    });
    expect((await ready()).status).toBe(200);
    await runtime.close();
    expect(runtime.memory!.readiness.reason).toBe("closed");
  } finally {
    release?.();
    await runtime?.close();
    await f.close();
  }
});
