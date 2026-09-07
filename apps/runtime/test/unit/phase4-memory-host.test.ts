import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  ContextBlock,
  MemoryProvider,
  MemoryQuery,
  PersonaSnapshot,
  PersonaSource,
  PersonaInvalidation,
} from "@bellis/contracts/memory";
import { ContextBlockSchema } from "@bellis/contracts/memory";
import { JsonValueSchema } from "@bellis/contracts";
import type {
  MemoryPolicySnapshot,
  PreparedToolCall,
  MemoryForgetOperation,
  MemoryForgetReceipt,
} from "@bellis/contracts";
import type { RequestAssemblyInput } from "@bellis/decision-loop";
import {
  Phase4MemoryHost,
  type Phase4MemoryOptions,
} from "../../src/application/phase-4/memory-host.js";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const block = (id: string, text = "记得喝水"): ContextBlock => ({
  id,
  text,
  revision: "1",
  contentHash: digest(text),
  category: "fact",
  placement: "memory",
  priority: 1,
  tokenEstimate: 1,
  privacyScope: "space:one",
  privacyLabels: ["space:one"],
  sourceRefs: [`fixture:${id}`],
});
const persona: PersonaSnapshot = {
  agentId: "agent",
  revision: "1",
  contentHash: "a".repeat(64),
  policyMode: "locked",
  core: { name: "Iris", tools: "FORBIDDEN_PERSONA_TOOL" },
  traits: {},
  narrative: {},
  state: null,
  effectiveFrom: 1,
  fetchedAt: 2,
  origin: "live",
};

class Provider implements MemoryProvider, PersonaSource {
  readonly id = "fixture";
  context: import("@bellis/contracts/memory").MemoryProviderContext | undefined;
  starts = 0;
  stops = 0;
  queries = 0;
  blocks = [block("one")];
  persona = structuredClone(persona);
  async start(context: import("@bellis/contracts/memory").MemoryProviderContext) {
    this.context = context;
    this.starts++;
  }
  async stop() {
    this.stops++;
  }
  async capabilities() {
    return {
      schemaVersion: 1 as const,
      providerVersion: "1",
      healthy: true,
      categories: ["fact" as const],
      placements: ["memory" as const],
      observe: true,
      usageReport: true,
      persona: true,
    };
  }
  listener: ((event: PersonaInvalidation) => void) | undefined;
  subscribe(listener: (event: PersonaInvalidation) => void) {
    this.listener = listener;
    return {
      dispose: () => {
        this.listener = undefined;
      },
    };
  }
  async current() {
    return this.persona;
  }
  async reportUsage() {}
  async observe() {}
  async provideContext(query: MemoryQuery) {
    this.queries++;
    return {
      schemaVersion: 1 as const,
      providerId: this.id,
      requestId: query.queryId,
      personaRevision: "7",
      returnedBlockIds: [...this.blocks.map((item) => item.id), "provider-filtered"],
      blocks: this.blocks,
    };
  }
}

function input(): RequestAssemblyInput {
  return {
    requestId: randomUUID(),
    model: "fixture",
    provider: "model",
    instructions: "Safety rules",
    tools: [],
    snapshot: {
      schemaVersion: 1,
      turnId: randomUUID(),
      cycleId: randomUUID(),
      cycleIndex: 0,
      maxCyclesPerTurn: 4,
      batch: {
        schemaVersion: 1,
        id: randomUUID(),
        windowStartUs: "0",
        windowEndUs: "1",
        watermarkFrom: "1",
        watermarkTo: "1",
        totalMessages: 1,
        uniqueUsers: 1,
        tokenEstimate: 2,
        highlights: [{ signalId: randomUUID(), userId: "viewer", text: "你好" }],
        topics: [],
        urgentSignals: [],
        droppedMessages: 0,
        truncated: false,
      },
      pendingToolResults: [],
      recentSpeech: [
        { schemaVersion: 1, cycleId: randomUUID(), text: "UNCONFIRMED_SPEECH", purpose: "answer" },
      ],
      toolResultsTruncated: false,
    },
  };
}

function host(
  provider: Provider,
  overrides: Partial<Phase4MemoryOptions> = {},
  history?: ConstructorParameters<typeof Phase4MemoryHost>[2],
  onPrivacyBarrier?: () => Promise<void>,
) {
  return new Phase4MemoryHost(
    {
      appInstanceId: "app",
      agentId: "agent",
      spaceId: "one",
      identityScope: "profile:one",
      privacyScope: "space:one",
      privacyRevision: "1",
      publicLabels: ["space:one"],
      scope: { kind: "space", acknowledgeCrossSession: true },
      personaSource: provider,
      providers: [{ provider, hashScheme: "sha256-text-v1" }],
      actors: () => [{ provider: "trusted", externalId: "one" }],
      nowMs: () => 100,
      ...overrides,
    },
    randomUUID(),
    history,
    onPrivacyBarrier,
  );
}

describe("Phase 4 context host", () => {
  it("cancels the disk preflight before starting a provider query", async () => {
    const provider = new Provider();
    let checkedSignal: AbortSignal | undefined;
    const memory = host(
      provider,
      {},
      {
        phase4ReadConfirmedSpeech: async () => [],
        readDiskStatus: async (signal) => {
          checkedSignal = signal;
          return new Promise((_resolve, reject) =>
            signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }),
          );
        },
      },
    );
    await memory.start();
    const cancelled = new AbortController();
    const pending = memory.build(input(), cancelled.signal);
    cancelled.abort(new Error("disk_preflight_cancelled"));
    await expect(pending).rejects.toThrow("disk_preflight_cancelled");
    expect(checkedSignal?.aborted).toBe(true);
    expect(provider.queries).toBe(0);
    await memory.stop();
  });

  it.each([
    { scope: { kind: "space" } },
    { scope: undefined },
    { scope: { kind: "space", acknowledgeCrossSession: false } },
    { scope: { kind: "session", coreSessionId: "unverified" } },
    { scope: { kind: "space", acknowledgeCrossSession: true, sessionId: "unverified" } },
    { coreSessionId: "unverified" },
    { spaceGroupId: "unverified" },
  ])(
    "rejects implicit or unverified scope configuration %j before starting providers",
    (invalid) => {
      const provider = new Provider();
      expect(() => host(provider, invalid as unknown as Partial<Phase4MemoryOptions>)).toThrow(
        "memory_scope_requires_explicit_space_configuration",
      );
      expect(provider.starts).toBe(0);
    },
  );

  it("uses a snapshot of the provider registry and output policy for space-scoped effects", () => {
    const provider = new Provider();
    const providers = [{ provider, hashScheme: "sha256-text-v1" as const }];
    const observeOutput = { privacyLabels: ["space:one"] };
    const memory = host(provider, { providers, observeOutput });
    providers.length = 0;
    observeOutput.privacyLabels[0] = "other-space";
    expect(memory.outputObservations()).toEqual([
      {
        providerId: "fixture",
        agentId: "agent",
        spaceId: "one",
        sourceStream: "bellis:app:output",
        privacyLabels: ["space:one"],
      },
    ]);
  });

  it("does not treat a late startup binding ACK as proof for a newly selected Session", async () => {
    const provider = new Provider();
    let complete!: () => void;
    const memory = host(
      provider,
      {},
      {
        phase4ReadConfirmedSpeech: async () => [],
        phase4EnsureMemoryPolicy: (scopeKey, privacyRevision) =>
          new Promise((resolve) => {
            complete = () =>
              resolve({ scopeKey, privacyRevision, generation: 0, blocked: false, tombstones: [] });
          }),
      },
    );
    const starting = memory.start();
    memory.bindSessionId(randomUUID());
    complete();
    await expect(starting).rejects.toThrow("memory_session_changed");
    expect(provider.starts).toBe(0);
  });

  it("does not open a provider when the durable startup Session scope is rejected", async () => {
    const provider = new Provider();
    let checkedSession: string | undefined;
    const memory = host(
      provider,
      {},
      {
        phase4ReadConfirmedSpeech: async () => [],
        phase4EnsureMemoryPolicy: async (_scopeKey, _revision, sessionId) => {
          checkedSession = sessionId;
          throw new Error("restored_scope_conflict");
        },
      },
    );
    await expect(memory.start()).rejects.toThrow("restored_scope_conflict");
    expect(checkedSession).toMatch(/^[0-9a-f-]{36}$/);
    expect(provider.starts).toBe(0);
  });

  it("keeps Forget locally blocked across lost begin/complete ACKs and permits only the original transition retry", async () => {
    const provider = new Provider();
    const sessionId = randomUUID();
    let policy!: MemoryPolicySnapshot;
    let prepared!: PreparedToolCall;
    let operation!: MemoryForgetOperation;
    let begins = 0,
      completions = 0;
    const receipt: MemoryForgetReceipt = {
      requestId: "forget",
      targetCount: 1,
      erasedCount: 1,
      heldSkipped: 0,
      protectedSkipped: 0,
    };
    const memory = host(
      provider,
      {},
      {
        phase4ReadConfirmedSpeech: async () => [],
        phase4ReadLocalVisibility: async ({ signalIds, toolRuns }) => ({
          signals: signalIds.map((signalId) => ({ signalId, result: "unbound" })),
          tools: toolRuns.map(({ toolRunId }) => ({ toolRunId, result: "unbound" })),
        }),
        phase4EnsureMemoryPolicy: async (scopeKey, privacyRevision) =>
          (policy = { scopeKey, privacyRevision, generation: 0, blocked: false, tombstones: [] }),
        phase4ReadMemoryPolicy: async () => structuredClone(policy),
        phase4ReadPreparedTool: async () => structuredClone(prepared),
        phase4BeginMemoryForget: async () => {
          policy = { ...policy, generation: 1, blocked: true };
          operation = {
            sessionId,
            toolRunId: prepared.toolRunId,
            scopeKey: policy.scopeKey,
            preparedDigest: "b".repeat(64),
            barrierGeneration: 1,
            state: "blocked",
            receipt: null,
          };
          if (++begins === 1) throw new Error("begin ACK lost");
          return { operation, policy };
        },
        phase4CompleteMemoryForget: async () => {
          policy = {
            ...policy,
            generation: 2,
            blocked: false,
            tombstones: [
              { providerId: "fixture", resourceRef: "fixture:one", throughRevision: null },
            ],
          };
          operation = { ...operation, state: "resolved", receipt };
          if (++completions === 1) throw new Error("complete ACK lost");
          return { operation, policy };
        },
      },
    );
    memory.bindSessionId(sessionId);
    await memory.start();
    prepared = {
      schemaVersion: 1,
      sessionId,
      turnId: randomUUID(),
      cycleId: randomUUID(),
      toolRunId: randomUUID(),
      toolName: "forget",
      toolVersion: 1,
      originalCallDigest: "a".repeat(64),
      providerId: "fixture",
      idempotencyKey: "saved-key",
      request: { target: "one" },
      confirmation: { target: "one" },
      policy: memory.policyStamp!,
      resources: [{ ref: "fixture:one", revision: "1" }],
    };
    try {
      await expect(
        memory.beginForget({ ...prepared, request: { target: "other" } }),
      ).rejects.toThrow("memory_forget_request_changed");
      expect(begins).toBe(0);
      await expect(memory.beginForget(prepared)).rejects.toThrow("begin ACK lost");
      await expect(memory.build(input(), new AbortController().signal)).rejects.toThrow(
        "memory_privacy_blocked",
      );
      await expect(memory.completeForget(prepared, receipt)).rejects.toThrow(
        "memory_forget_pending",
      );
      expect((await memory.beginForget(prepared)).state).toBe("blocked");
      await expect(memory.completeForget(prepared, receipt)).rejects.toThrow("complete ACK lost");
      await expect(memory.build(input(), new AbortController().signal)).rejects.toThrow(
        "memory_privacy_blocked",
      );
      await expect(
        memory.completeForget(prepared, { ...receipt, requestId: "changed" }),
      ).rejects.toThrow("memory_forget_pending");
      expect((await memory.completeForget(prepared, receipt)).state).toBe("resolved");
      const built = await memory.build(input(), new AbortController().signal);
      expect(built.request.prompt).not.toContain("记得喝水");
      built.dispose?.();
      expect([begins, completions]).toEqual([2, 2]);
    } finally {
      await memory.stop();
    }
  });

  it("retries an unknown policy write with its original generation even after a newer policy read", async () => {
    const provider = new Provider();
    let policy!: MemoryPolicySnapshot;
    const generations: number[] = [];
    const memory = host(
      provider,
      {},
      {
        phase4ReadConfirmedSpeech: async () => [],
        phase4ReadLocalVisibility: async ({ signalIds, toolRuns }) => ({
          signals: signalIds.map((signalId) => ({ signalId, result: "unbound" })),
          tools: toolRuns.map(({ toolRunId }) => ({ toolRunId, result: "unbound" })),
        }),
        phase4EnsureMemoryPolicy: async (scopeKey, privacyRevision) =>
          (policy = { scopeKey, privacyRevision, generation: 0, blocked: false, tombstones: [] }),
        phase4ReadMemoryPolicy: async () => structuredClone(policy),
        phase4ChangeMemoryPolicy: async (change) => {
          generations.push(change.expectedGeneration);
          if (generations.length === 1) {
            policy = { ...policy, generation: 1 };
            throw new Error("lost acknowledgment");
          }
          return structuredClone(policy);
        },
      },
    );
    await memory.start();
    const change = {
      changeId: randomUUID(),
      privacyRevision: "1",
      blocked: false,
      reason: "forget" as const,
      tombstones: [],
    };
    try {
      await expect(memory.changePrivacy(change)).rejects.toThrow("lost acknowledgment");
      await expect(memory.build(input(), new AbortController().signal)).rejects.toThrow(
        "memory_privacy_blocked",
      );
      await memory.changePrivacy(change);
      expect(generations).toEqual([0, 0]);
      const built = await memory.build(input(), new AbortController().signal);
      expect(built.adoption?.manifest.policy?.generation).toBe(1);
      built.dispose?.();
    } finally {
      await memory.stop();
    }
  });

  it("invalidates frozen work, filters tombstones and rejects historical Usage after a durable policy change", async () => {
    const provider = new Provider();
    let policy!: MemoryPolicySnapshot;
    let reports = 0;
    provider.reportUsage = async () => {
      reports++;
    };
    const memory = host(
      provider,
      {},
      {
        phase4ReadConfirmedSpeech: async () => [],
        phase4ReadLocalVisibility: async ({ signalIds, toolRuns }) => ({
          signals: signalIds.map((signalId) => ({ signalId, result: "unbound" })),
          tools: toolRuns.map(({ toolRunId }) => ({ toolRunId, result: "unbound" })),
        }),
        phase4EnsureMemoryPolicy: async (scopeKey, privacyRevision) =>
          (policy = { scopeKey, privacyRevision, generation: 0, blocked: false, tombstones: [] }),
        phase4ReadMemoryPolicy: async () => structuredClone(policy),
        phase4ChangeMemoryPolicy: async (change) =>
          (policy = {
            ...policy,
            generation: policy.generation + 1,
            blocked: change.blocked,
            privacyRevision: change.privacyRevision,
            tombstones: [...policy.tombstones, ...change.tombstones],
          }),
      },
    );
    await memory.start();
    try {
      const first = await memory.build(input(), new AbortController().signal);
      expect(first.adoption?.manifest.policy?.generation).toBe(0);
      const encoded = JSON.stringify(first.adoption);
      await memory.changePrivacy({
        changeId: randomUUID(),
        privacyRevision: "1",
        blocked: false,
        reason: "forget",
        tombstones: [
          { providerId: provider.id, resourceRef: "fixture:one", throughRevision: null },
        ],
      });
      expect(first.signal?.aborted).toBe(true);
      expect(() => first.assertCurrent?.()).toThrow(/invalidated/);
      expect(JSON.stringify(first.adoption)).toBe(encoded);
      const delivery = first.adoption!.usage[0]!;
      expect(
        await memory.publish(
          {
            schemaVersion: 1,
            outboxId: delivery.report.outboxId,
            topic: "memory.usage.v1",
            partitionKey: provider.id,
            createdAtMs: 1,
            payload: {
              providerId: provider.id,
              report: delivery.report,
              policy: first.adoption!.manifest.policy!,
            },
          },
          new AbortController().signal,
        ),
      ).toEqual({ ok: false, errorCode: "privacy_revoked", retryable: false });
      expect(reports).toBe(0);
      const next = await memory.build(input(), new AbortController().signal);
      expect(next.adoption?.manifest.policy?.generation).toBe(1);
      expect(next.adoption?.manifest.blocks[0]?.result).toBe("tombstone");
      expect(next.adoption?.usage[0]?.report.modelVisibleBlockIds).toEqual([]);
      expect(memory.outputSourceStream).toBe("bellis:app:output:policy:1");
      first.dispose?.();
      next.dispose?.();
      await memory.changePrivacy({
        changeId: randomUUID(),
        privacyRevision: "2",
        blocked: true,
        reason: "privacy",
        tombstones: [],
      });
      await expect(memory.build(input(), new AbortController().signal)).rejects.toThrow(
        "memory_privacy_blocked",
      );
    } finally {
      await memory.stop();
    }
  });

  it("cancels an already in-flight delivery before persisting a privacy transition", async () => {
    const provider = new Provider();
    let policy!: MemoryPolicySnapshot;
    let release!: () => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    provider.reportUsage = () => {
      began();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const memory = host(
      provider,
      {},
      {
        phase4ReadConfirmedSpeech: async () => [],
        phase4ReadLocalVisibility: async ({ signalIds, toolRuns }) => ({
          signals: signalIds.map((signalId) => ({ signalId, result: "unbound" })),
          tools: toolRuns.map(({ toolRunId }) => ({ toolRunId, result: "unbound" })),
        }),
        phase4EnsureMemoryPolicy: async (scopeKey, privacyRevision) =>
          (policy = { scopeKey, privacyRevision, generation: 0, blocked: false, tombstones: [] }),
        phase4ReadMemoryPolicy: async () => structuredClone(policy),
        phase4ChangeMemoryPolicy: async (change) =>
          (policy = { ...policy, generation: policy.generation + 1, blocked: change.blocked }),
      },
    );
    await memory.start();
    try {
      const built = await memory.build(input(), new AbortController().signal);
      const delivery = built.adoption!.usage[0]!;
      const publishing = memory.publish(
        {
          schemaVersion: 1,
          outboxId: delivery.report.outboxId,
          topic: "memory.usage.v1",
          partitionKey: provider.id,
          createdAtMs: 1,
          payload: {
            providerId: provider.id,
            report: delivery.report,
            policy: memory.policyStamp!,
          },
        },
        new AbortController().signal,
      );
      await started;
      await memory.changePrivacy({
        changeId: randomUUID(),
        privacyRevision: "1",
        blocked: true,
        reason: "forget",
        tombstones: [],
      });
      expect(await publishing).toMatchObject({ ok: false });
      expect(built.signal?.aborted).toBe(true);
      release();
      built.dispose?.();
    } finally {
      release?.();
      await memory.stop();
    }
  });

  it.each([
    { sessionId: "unverified-session" },
    { spaceGroupId: "unverified-group" },
    { agentId: "other-agent" },
    { spaceId: "other-space" },
    { spaceId: undefined },
  ])("does not publish or retarget restored Observe with incompatible scope %j", async (scope) => {
    const provider = new Provider();
    let calls = 0;
    provider.observe = async () => {
      calls++;
    };
    const memory = host(provider);
    await memory.start();
    const event = {
      schemaVersion: 1,
      eventId: randomUUID(),
      outboxId: randomUUID(),
      agentId: "agent",
      spaceId: "one",
      role: "user",
      kind: "message.text",
      occurredAtMs: 1,
      committedAtMs: 1,
      effectState: "committed",
      content: "original",
      ...scope,
    };
    const wireEvent = JsonValueSchema.parse(JSON.parse(JSON.stringify(event)));
    const before = structuredClone(wireEvent);
    try {
      expect(
        await memory.publish(
          {
            schemaVersion: 1,
            outboxId: event.outboxId,
            topic: "memory.observe.v1",
            partitionKey: "fixture",
            createdAtMs: 1,
            payload: { providerId: "fixture", event: wireEvent },
          },
          new AbortController().signal,
        ),
      ).toEqual({
        ok: false,
        errorCode: "memory_observation_scope_mismatch",
        retryable: false,
      });
      expect(calls).toBe(0);
      expect(wireEvent).toEqual(before);
    } finally {
      await memory.stop();
    }
  });

  it("retains the delivery permit after cancellation until the provider actually settles", async () => {
    const provider = new Provider();
    let finish!: () => void;
    let calls = 0;
    provider.observe = () => {
      calls++;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    };
    const memory = host(provider);
    await memory.start();
    const message = {
      schemaVersion: 1 as const,
      outboxId: randomUUID(),
      topic: "memory.observe.v1",
      partitionKey: "fixture",
      createdAtMs: 1,
      payload: {
        providerId: "fixture",
        event: {
          schemaVersion: 1,
          eventId: randomUUID(),
          outboxId: randomUUID(),
          agentId: "agent",
          spaceId: "one",
          role: "user",
          kind: "message.text",
          occurredAtMs: 1,
          committedAtMs: 1,
          effectState: "committed",
          content: "accepted input",
        },
      },
    };
    try {
      const cancelled = new AbortController();
      const first = memory.publish(message, cancelled.signal);
      await Promise.resolve();
      expect(calls).toBe(1);
      cancelled.abort();
      expect(await first).toMatchObject({ ok: false, retryable: true });
      for (const topic of ["memory.observe.v1", "memory.usage.v1"]) {
        expect(await memory.publish({ ...message, topic }, new AbortController().signal)).toEqual({
          ok: false,
          errorCode: "memory_provider_busy",
          retryable: true,
        });
      }
      expect(calls).toBe(1);
      finish();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      provider.observe = async () => {
        calls++;
      };
      expect(await memory.publish(message, new AbortController().signal)).toEqual({ ok: true });
      expect(calls).toBe(2);
    } finally {
      finish?.();
      await memory.stop();
    }
  });

  it("reads independently confirmed fragments into the budgeted request and excludes planned speech", async () => {
    const provider = new Provider();
    const memory = host(
      provider,
      {},
      {
        phase4ReadConfirmedSpeech: async () => [
          {
            cycleId: randomUUID(),
            receiptId: randomUUID(),
            text: "ACTUAL_CONFIRMED_FRAGMENT",
            start: 4,
            end: 29,
            confirmedAtMs: 10,
          },
        ],
      },
    );
    await memory.start();
    try {
      const prepared = await memory.build(input(), new AbortController().signal);
      expect(prepared.request.prompt).toContain("ACTUAL_CONFIRMED_FRAGMENT");
      expect(prepared.request.prompt).not.toContain("UNCONFIRMED_SPEECH");
      expect(prepared.adoption!.manifest.budget.estimatedInputTokens).toBeLessThanOrEqual(
        prepared.adoption!.manifest.budget.maxInputTokens,
      );
      prepared.dispose?.();
    } finally {
      await memory.stop();
    }
  });

  it("aborts old Persona requests immediately on revision events before background refresh completes", async () => {
    const provider = new Provider();
    const memory = host(provider);
    await memory.start();
    try {
      const old = await memory.build(input(), new AbortController().signal);
      provider.persona = { ...provider.persona, revision: "2", contentHash: "b".repeat(64) };
      provider.listener?.({ agentId: "agent", reason: "revised", revision: "2" });
      expect(old.signal?.aborted).toBe(true);
      expect(() => old.assertCurrent?.()).toThrow();
      await Promise.resolve();
      await Promise.resolve();
      const next = await memory.build(input(), new AbortController().signal);
      expect(next.adoption?.manifest.persona.revision).toBe("2");
      expect(next.request.metadata?.promptEpoch).not.toBe(old.request.metadata?.promptEpoch);
      next.dispose?.();
      old.dispose?.();
    } finally {
      await memory.stop();
    }
  });
  it("only observes identities selected by a trusted ingress mapping, with stable independent streams", async () => {
    const provider = new Provider();
    const signal = {
      schemaVersion: 1 as const,
      id: randomUUID(),
      source: "trusted",
      kind: "chat",
      occurredAt: 1,
      priority: 0,
      payload: { actorExternalIdentityId: "forged", text: "actual" },
    };
    expect(host(provider).inputObservations(signal)).toEqual([]);
    const memory = host(provider, {
      observeInput: (value) =>
        value.source === "trusted"
          ? {
              actorExternalIdentityId: "resolved-identity",
              role: "user",
              content: "accepted text",
              privacyLabels: ["actor:resolved-identity:private"],
            }
          : null,
    });
    const first = memory.inputObservations(signal);
    expect(first[0]).toMatchObject({
      actorExternalIdentityId: "resolved-identity",
      content: "accepted text",
      role: "user",
      privacyLabels: ["actor:resolved-identity:private"],
    });
    expect(memory.inputObservations({ ...signal, id: randomUUID() })[0]?.sourceStream).toBe(
      first[0]?.sourceStream,
    );
    expect(memory.inputObservations({ ...signal, source: "untrusted" })).toEqual([]);
    memory.bindSessionId(randomUUID());
    expect(memory.inputObservations(signal)[0]?.sourceStream).not.toBe(first[0]?.sourceStream);
  });
  it("uses one lifecycle, preserves all Recall lineage, and excludes unconfirmed speech", async () => {
    const provider = new Provider();
    const memory = host(provider);
    await memory.start();
    try {
      const built = await memory.build(input(), new AbortController().signal);
      expect(provider.starts).toBe(1);
      expect(built.request.instructions).not.toContain("FORBIDDEN_PERSONA_TOOL");
      expect(built.request.prompt).not.toContain("UNCONFIRMED_SPEECH");
      expect(built.request.prompt).toContain("记得喝水");
      expect(Object.isFrozen(built.request)).toBe(true);
      expect(Object.isFrozen(built.adoption?.manifest.providers)).toBe(true);
      expect(built.adoption?.usage[0]?.report).toMatchObject({
        personaRevision: "7",
        returnedBlockIds: ["one", "provider-filtered"],
        hostSelectedBlockIds: ["one"],
        modelVisibleBlockIds: ["one"],
      });
      expect(built.adoption?.manifest.persona.revision).toBe("1");
      expect(built.adoption?.manifest.blocks[0]?.textHash).toBe(digest("记得喝水"));
      built.dispose?.();
    } finally {
      await memory.stop();
    }
    expect(provider.stops).toBe(1);
  });

  it("filters private/cross-domain/expired/invalid/duplicate blocks before model visibility", async () => {
    const provider = new Provider();
    provider.blocks = [
      block("one"),
      block("duplicate"),
      { ...block("private"), privacyLabels: ["entity:x:private"] },
      { ...block("cross"), privacyScope: "space:other" },
      { ...block("expired"), expiresAt: 99 },
      { ...block("invalid"), contentHash: "bad" },
    ].map((value) => ContextBlockSchema.parse(value));
    const memory = host(provider);
    await memory.start();
    try {
      const built = await memory.build(input(), new AbortController().signal);
      expect(built.adoption?.manifest.blocks.map((item) => item.result).toSorted()).toEqual([
        "duplicate",
        "expired",
        "included",
        "invalid",
        "privacy",
        "privacy",
      ]);
      expect(built.adoption?.usage[0]?.report.modelVisibleBlockIds).toHaveLength(1);
      built.dispose?.();
    } finally {
      await memory.stop();
    }
  });

  it("does no Recall without a trusted actor and rejects insufficient stable-prefix budgets", async () => {
    const provider = new Provider();
    const memory = host(provider, { actors: () => [] });
    await memory.start();
    try {
      const built = await memory.build(input(), new AbortController().signal);
      expect(provider.queries).toBe(0);
      expect(built.adoption?.manifest.providers[0]?.outcome).toBe("no_actor");
      built.dispose?.();
    } finally {
      await memory.stop();
    }
    const small = host(provider, { maxInputTokens: 10 });
    await small.start();
    try {
      await expect(small.build(input(), new AbortController().signal)).rejects.toThrow(
        /stable_prefix/,
      );
    } finally {
      await small.stop();
    }
  });

  it("rechecks generation before adoption and preserves the frozen manifest", async () => {
    const provider = new Provider();
    const memory = host(provider);
    await memory.start();
    try {
      const built = await memory.build(input(), new AbortController().signal);
      const encoded = JSON.stringify(built.adoption);
      memory.invalidate();
      expect(built.signal?.aborted).toBe(true);
      expect(() => built.assertCurrent?.()).toThrow(/invalidated/);
      expect(JSON.stringify(built.adoption)).toBe(encoded);
      built.dispose?.();
    } finally {
      await memory.stop();
    }
  });

  it("bounds a noncooperative Provider and keeps its next request behind the bulkhead", async () => {
    const provider = new Provider();
    provider.provideContext = () => new Promise(() => {});
    const memory = host(provider, { deadlineMs: 150 });
    await memory.start();
    try {
      const at = performance.now();
      const built = await memory.build(input(), new AbortController().signal);
      expect(performance.now() - at).toBeLessThan(250);
      expect(built.adoption?.manifest.providers[0]?.outcome).toBe("timeout");
      const next = await memory.build(input(), new AbortController().signal);
      expect(next.adoption?.manifest.providers[0]?.outcome).toBe("busy");
      built.dispose?.();
      next.dispose?.();
    } finally {
      await memory.stop();
    }
  });
});

it("filters old local input before Prompt, actor mapping and Recall while preserving unknown write warnings", async () => {
  const provider = new Provider();
  let policy!: MemoryPolicySnapshot;
  let seenActors: RequestAssemblyInput | undefined, seenQuery: MemoryQuery | undefined;
  const provideContext = provider.provideContext.bind(provider);
  provider.provideContext = async (query) => {
    seenQuery = query;
    return provideContext(query);
  };
  const request = input();
  const oldSignal = request.snapshot.batch.highlights[0]!.signalId,
    newSignal = randomUUID();
  request.snapshot.batch.highlights = [
    { signalId: oldSignal, userId: "old", text: "OLD_PRIVATE_SIGNAL", weight: 0.9 },
    { signalId: newSignal, userId: "new", text: "ALLOWED_SIGNAL", weight: 0.7 },
  ];
  request.snapshot.batch.topics = [
    { label: "PRIVATE_TOPIC", count: 2, participants: 2, examples: ["PRIVATE_EXAMPLE"] },
  ];
  request.snapshot.batch.urgentSignals = [
    {
      schemaVersion: 1,
      id: randomUUID(),
      source: "trusted",
      kind: "urgent",
      priority: 100,
      occurredAt: 1,
      payload: "OLD_PRIVATE_URGENT",
    },
  ];
  request.snapshot.pendingToolResults = [
    {
      schemaVersion: 1,
      toolRunId: randomUUID(),
      toolName: "remember",
      outcome: "failed",
      truncated: false,
      errorCode: "tool_outcome_unknown",
      value: "OLD_PRIVATE_TOOL",
    },
    {
      schemaVersion: 1,
      toolRunId: randomUUID(),
      toolName: "memory_search",
      outcome: "succeeded",
      truncated: false,
      value: "ALLOWED_TOOL",
    },
  ];
  const memory = host(
    provider,
    {
      actors: (filtered) => {
        seenActors = filtered;
        return [{ provider: "trusted", externalId: "new" }];
      },
    },
    {
      phase4ReadConfirmedSpeech: async () => [],
      phase4EnsureMemoryPolicy: async (scopeKey, privacyRevision) =>
        (policy = { scopeKey, privacyRevision, generation: 1, blocked: false, tombstones: [] }),
      phase4ReadMemoryPolicy: async () => policy,
      phase4ReadLocalVisibility: async ({ signalIds, toolRuns, policy: received }) => {
        expect(received.generation).toBe(1);
        return {
          signals: signalIds.map((signalId) => ({
            signalId,
            result: signalId === newSignal ? "included" : "stale_policy",
          })),
          tools: toolRuns.map(({ toolRunId }, index) => ({
            toolRunId,
            result: index === 1 ? "included" : "stale_policy",
          })),
        };
      },
    },
  );
  try {
    await memory.start();
    const built = await memory.build(request, new AbortController().signal);
    for (const value of [
      built.request.prompt,
      JSON.stringify(seenActors),
      JSON.stringify(seenQuery),
    ]) {
      expect(value).not.toContain("PRIVATE");
      expect(value).toContain("ALLOWED_SIGNAL");
      expect(value).toContain("ALLOWED_TOOL");
    }
    expect(built.request.prompt).toContain("远端写入结果未知");
    expect(seenActors?.snapshot.batch.highlights[0]?.weight).toBeUndefined();
    expect(built.adoption?.manifest.localInputs).toMatchObject({
      topicsSuppressed: true,
      signals: expect.arrayContaining([
        { signalId: oldSignal, result: "stale_policy" },
        { signalId: newSignal, result: "included" },
      ]),
    });
    expect(JSON.stringify(request)).toContain("OLD_PRIVATE_SIGNAL");
    built.dispose?.();
  } finally {
    await memory.stop();
  }
});

it("does not fall back to unchecked local inputs when a persistent visibility port is missing", async () => {
  const provider = new Provider();
  let policy!: MemoryPolicySnapshot;
  const memory = host(
    provider,
    {},
    {
      phase4ReadConfirmedSpeech: async () => [],
      phase4EnsureMemoryPolicy: async (scopeKey, privacyRevision) =>
        (policy = { scopeKey, privacyRevision, generation: 0, blocked: false, tombstones: [] }),
      phase4ReadMemoryPolicy: async () => policy,
    },
  );
  try {
    await memory.start();
    await expect(memory.build(input(), new AbortController().signal)).rejects.toThrow(
      "memory_local_visibility_unavailable",
    );
    expect(provider.queries).toBe(0);
  } finally {
    await memory.stop();
  }
});

it("passes context cancellation to the local visibility read and rejects its late data", async () => {
  const provider = new Provider();
  let policy!: MemoryPolicySnapshot, wireSignal: AbortSignal | undefined;
  let readStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    readStarted = resolve;
  });
  const memory = host(
    provider,
    {},
    {
      phase4ReadConfirmedSpeech: async () => [],
      phase4EnsureMemoryPolicy: async (scopeKey, privacyRevision) =>
        (policy = { scopeKey, privacyRevision, generation: 0, blocked: false, tombstones: [] }),
      phase4ReadMemoryPolicy: async () => policy,
      phase4ReadLocalVisibility: async (_request, signal) => {
        wireSignal = signal;
        readStarted();
        await new Promise<void>((resolve) =>
          signal!.addEventListener("abort", () => resolve(), { once: true }),
        );
        return { signals: [], tools: [] };
      },
    },
  );
  try {
    await memory.start();
    const parent = new AbortController();
    const result = memory.build(input(), parent.signal);
    const rejected = expect(result).rejects.toThrow("cancel context");
    await started;
    parent.abort(new Error("cancel context"));
    await rejected;
    expect(wireSignal?.aborted).toBe(true);
    expect(provider.queries).toBe(0);
  } finally {
    await memory.stop();
  }
});

it("preserves topics and weights when the entire batch range has durable current-policy proof", async () => {
  const provider = new Provider();
  let policy!: MemoryPolicySnapshot;
  const request = input();
  request.snapshot.batch.highlights[0]!.weight = 0.5;
  request.snapshot.batch.topics = [
    { label: "AUTHORIZED_TOPIC", count: 1, participants: 1, examples: ["你好"] },
  ];
  const memory = host(
    provider,
    {},
    {
      phase4ReadConfirmedSpeech: async () => [],
      phase4EnsureMemoryPolicy: async (scopeKey, privacyRevision) =>
        (policy = { scopeKey, privacyRevision, generation: 0, blocked: false, tombstones: [] }),
      phase4ReadMemoryPolicy: async () => policy,
      phase4ReadLocalVisibility: async ({ signalIds, batchRange }) => {
        expect(batchRange).toEqual({ from: "1", to: "1" });
        return {
          signals: signalIds.map((signalId) => ({ signalId, result: "included" })),
          tools: [],
          aggregatesVisible: true,
        };
      },
    },
  );
  try {
    await memory.start();
    const built = await memory.build(request, new AbortController().signal);
    expect(built.request.prompt).toContain("AUTHORIZED_TOPIC");
    expect(built.request.prompt).toContain("w=0.50");
    expect(built.adoption?.manifest.localInputs).toMatchObject({
      aggregatesVisible: true,
      topicsSuppressed: false,
    });
    built.dispose?.();
  } finally {
    await memory.stop();
  }
});

it("keeps external invalidation blocked after a lost durable ACK until the same event is retried", async () => {
  const provider = new Provider();
  let policy!: MemoryPolicySnapshot;
  let calls = 0;
  const memory = host(
    provider,
    {},
    {
      phase4ReadConfirmedSpeech: async () => [],
      phase4ReadLocalVisibility: async ({ signalIds, toolRuns }) => ({
        signals: signalIds.map((signalId) => ({ signalId, result: "unbound" })),
        tools: toolRuns.map(({ toolRunId }) => ({ toolRunId, result: "unbound" })),
      }),
      phase4EnsureMemoryPolicy: async (scopeKey, privacyRevision) =>
        (policy = { scopeKey, privacyRevision, generation: 0, blocked: false, tombstones: [] }),
      phase4ReadMemoryPolicy: async () => structuredClone(policy),
      phase4ApplyResourceInvalidation: async (_scope, event) => {
        if (++calls === 1) {
          policy = {
            ...policy,
            generation: 1,
            tombstones: event.resources.map((resource) => ({
              ...resource,
              providerId: event.providerId,
            })),
          };
          throw new Error("lost committed ACK");
        }
        return structuredClone(policy);
      },
    },
  );
  const event = {
    schemaVersion: 1 as const,
    providerId: "fixture",
    agentId: "agent",
    eventId: "external:one",
    cursor: "1",
    resources: [{ resourceRef: "fixture:one", throughRevision: null }],
  };
  try {
    await memory.start();
    const old = await memory.build(input(), new AbortController().signal);
    const invalidate = provider.context!.invalidateResources!;
    await expect(invalidate(event, new AbortController().signal)).rejects.toThrow(
      "lost committed ACK",
    );
    expect(old.signal?.aborted).toBe(true);
    await expect(memory.build(input(), new AbortController().signal)).rejects.toThrow(
      "memory_privacy_blocked",
    );
    await expect(
      invalidate({ ...event, eventId: "changed" }, new AbortController().signal),
    ).rejects.toThrow("memory_resource_invalidation_pending");
    await invalidate(event, new AbortController().signal);
    const fresh = await memory.build(input(), new AbortController().signal);
    expect(fresh.request.prompt).not.toContain("记得喝水");
    expect(fresh.adoption?.manifest.policy?.generation).toBe(1);
    old.dispose?.();
    fresh.dispose?.();
  } finally {
    await memory.stop();
  }
});

it("persists history gaps before ACK, cancels old context and holds delivery through failed persistence", async () => {
  const provider = new Provider();
  let policy!: MemoryPolicySnapshot;
  let calls = 0;
  let releaseStop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  const memory = host(
    provider,
    {},
    {
      phase4ReadConfirmedSpeech: async () => [],
      phase4ReadLocalVisibility: async ({ signalIds, toolRuns }) => ({
        signals: signalIds.map((signalId) => ({ signalId, result: "unbound" })),
        tools: toolRuns.map(({ toolRunId }) => ({ toolRunId, result: "unbound" })),
      }),
      phase4EnsureMemoryPolicy: async (scopeKey, privacyRevision) =>
        (policy = { scopeKey, privacyRevision, generation: 0, blocked: false, tombstones: [] }),
      phase4ReadMemoryPolicy: async () => structuredClone(policy),
      phase4BeginHistoryGap: async () => {
        if (++calls === 1) throw new Error("disk failure");
        policy = { ...policy, blocked: true, historyBlocked: true };
        return structuredClone(policy);
      },
    },
    () => stopped,
  );
  const gap = {
    schemaVersion: 1 as const,
    providerId: "fixture",
    agentId: "agent",
    gapId: "a".repeat(64),
    reason: "history_unavailable" as const,
    cursor: "7",
    eventId: "old:7",
  };
  try {
    await memory.start();
    const old = await memory.build(input(), new AbortController().signal);
    const report = old.adoption!.usage[0]!;
    const message = {
      schemaVersion: 1 as const,
      partitionKey: provider.id,
      createdAtMs: 1,
      outboxId: report.report.outboxId,
      topic: "memory.usage.v1",
      payload: JsonValueSchema.parse({ ...report, policy: old.adoption!.manifest.policy }),
    };
    const notify = provider.context!.historyUnavailable!;
    for (const foreign of [
      { ...gap, providerId: "other" },
      { ...gap, agentId: "other" },
    ]) {
      await expect(notify(foreign, new AbortController().signal)).rejects.toThrow(
        "memory_history_barrier_unavailable",
      );
    }
    expect(calls).toBe(0);
    await expect(notify(gap, new AbortController().signal)).rejects.toThrow("disk failure");
    expect(old.signal?.aborted).toBe(true);
    await expect(memory.build(input(), new AbortController().signal)).rejects.toThrow(
      "memory_privacy_blocked",
    );
    expect(await memory.publish(message, new AbortController().signal)).toEqual({
      ok: false,
      errorCode: "history_unavailable",
      retryable: true,
    });
    await expect(
      notify({ ...gap, eventId: "changed" }, new AbortController().signal),
    ).rejects.toThrow("memory_history_barrier_pending");
    let acknowledged = false;
    const retry = notify(gap, new AbortController().signal).then(() => {
      acknowledged = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls).toBe(2);
    expect(policy.historyBlocked).toBe(true);
    expect(acknowledged).toBe(false);
    releaseStop();
    await retry;
    expect(acknowledged).toBe(true);
    await expect(memory.build(input(), new AbortController().signal)).rejects.toThrow(
      "memory_privacy_blocked",
    );
    expect(await memory.publish(message, new AbortController().signal)).toEqual({
      ok: false,
      errorCode: "history_unavailable",
      retryable: true,
    });
    old.dispose?.();
  } finally {
    releaseStop();
    await memory.stop();
  }
});
