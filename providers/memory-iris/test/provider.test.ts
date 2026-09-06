import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  MemoryObserveEvent,
  MemoryQuery,
  MemoryUsageReport,
  PersonaSnapshot,
} from "@bellis/contracts/memory";
import { assertMemoryProviderConformance } from "@bellis/testkit";
import type {
  CapabilitiesEnvelope,
  CoreEvent,
  LeaseView,
  ObservationRecordInput,
  PersonaCurrentResponse,
  RecallRequest,
  RecallResponse,
  SourceCursorEnvelope,
} from "@iris-memory/sdk";
import { describe, expect, it } from "vitest";

import {
  IrisMemoryProvider,
  JsonAdapterStateStore,
  MemoryAdapterStateStore,
  computePersonaContentHash,
  type IrisClientPort,
} from "../src/index.js";

const query: MemoryQuery = {
  schemaVersion: 1,
  queryId: "query-1",
  agentId: "agent-1",
  spaceId: "space-1",
  sessionId: "session-1",
  actors: [{ provider: "chat", externalId: "viewer-1" }],
  topic: "remember me",
  purpose: "reply",
  privacyScope: "space:space-1",
  allowPartial: true,
};

const observeEvent: MemoryObserveEvent = {
  schemaVersion: 1,
  eventId: "event-1",
  outboxId: "outbox-1",
  agentId: "agent-1",
  spaceId: "space-1",
  sessionId: "session-1",
  role: "assistant",
  kind: "message.text",
  occurredAtMs: 1_700_000_000_000,
  committedAtMs: 1_700_000_000_100,
  sourceStream: "bellis:session-1",
  sourceCursor: "4",
  effectState: "partial",
  content: "confirmed prefix",
};

const usageReport: MemoryUsageReport = {
  schemaVersion: 1,
  requestId: "query-1",
  hostCycleId: "cycle-1",
  outboxId: "usage-outbox-1",
  personaRevision: "1",
  returnedBlockIds: ["cand:0123456789abcdef"],
  hostSelectedBlockIds: ["cand:0123456789abcdef"],
  modelVisibleBlockIds: ["cand:0123456789abcdef"],
  reportedAtMs: 1_700_000_000_200,
};

function personaContent() {
  return { core: { language: "zh", name: "Iris" }, traits: { calm: true }, narrative: {} };
}

class FakeIrisClient implements IrisClientPort {
  public readonly observed: ObservationRecordInput[][] = [];
  public readonly usages: unknown[] = [];
  public personaState: PersonaCurrentResponse["state"] = null;
  public recallInput: RecallRequest | undefined;
  public recallSignal: AbortSignal | undefined;

  public async negotiate(): Promise<CapabilitiesEnvelope> {
    return {
      api_version: "v1",
      schema_version: 11,
      capabilities: [
        "contract.negotiation",
        "observe.batch.v1",
        "persona.read.v1",
        "recall.usage.v1",
        "recall.v1",
        "source-cursor.v1",
      ],
    };
  }

  public async recall(
    input: RecallRequest,
    options?: { signal?: AbortSignal },
  ): Promise<RecallResponse> {
    this.recallInput = input;
    this.recallSignal = options?.signal;
    return {
      schema_version: 1,
      request_id: input.request_id,
      source_watermark: "18",
      persona_revision: 1,
      persona_content_hash: computePersonaContentHash(personaContent()),
      candidates: [
        {
          candidate_id: "cand:0123456789abcdef",
          resource_ref: { resource_type: "claim", resource_id: "claim/one", revision: 2 },
          content_hash: "candidate-hash",
          text: "The viewer prefers Chinese",
          category: "preference",
          placement: "memory",
          scope: { space_id: "space-1" },
          privacy_labels: ["space:space-1", "private"],
          source_refs: [{ resource_type: "claim", resource_id: "claim/one", revision: 2 }],
          scores: { relevance: 0.8 },
          final_score: 0.8,
          token_estimate: 5,
          conflict_state: "redundant",
          expires_at: "2026-09-06T00:00:00Z",
        },
        {
          candidate_id: "cand:fedcba9876543210",
          resource_ref: { resource_type: "future", resource_id: "unknown", revision: 1 },
          content_hash: "future-hash",
          text: "unknown category",
          category: "future-category",
          placement: "working",
          scope: {},
          privacy_labels: [],
          source_refs: [],
          scores: {},
          final_score: 0.5,
          token_estimate: 2,
        },
      ],
      pending_event_ids: [],
      completed_routes: ["claims"],
      degraded_routes: [
        { route: "vector", reason_code: "unavailable", retryable: true, fallback: "fts" },
      ],
      partial: true,
      cache_until: "2026-09-05T23:00:00Z",
      next_wake_at: null,
      trace: null,
    };
  }

  public async reportRecallUsage(_requestId: string, input: unknown): Promise<unknown> {
    this.usages.push(input);
    return {};
  }

  public async observeBatch(records: readonly ObservationRecordInput[]): Promise<unknown> {
    this.observed.push([...records]);
    return {};
  }

  public async currentPersona(): Promise<PersonaCurrentResponse> {
    const content = personaContent();
    return {
      revision: {
        agent_id: "agent-1",
        revision: 1,
        content_hash: computePersonaContentHash(content),
        ...content,
        effective_from_us: 1_700_000_000_000_000,
        status: "published",
      },
      policy: { mode: "locked" },
      state: this.personaState,
    };
  }

  public async sourceCursor(sourceStream: string): Promise<SourceCursorEnvelope> {
    return { source_stream: sourceStream, cursor_position: 4, gap_policy: "reject" };
  }

  public async events(): Promise<readonly CoreEvent[]> {
    return [];
  }

  public async acquireSurfaceLease(): Promise<LeaseView> {
    return {
      lease_id: "lease-1",
      tenant_id: "tenant-1",
      agent_id: "agent-1",
      holder_app_instance_id: "bellis-1",
      lease_epoch: 1,
      status: "active",
      expires_us: 1_800_000_000_000_000,
    };
  }

  public async heartbeatSurfaceLease(_leaseId: string, _input: unknown): Promise<LeaseView> {
    return this.acquireSurfaceLease();
  }

  public async releaseSurfaceLease(_leaseId: string, _input: unknown): Promise<LeaseView> {
    return { ...(await this.acquireSurfaceLease()), status: "released" };
  }
}

function makeProvider(client = new FakeIrisClient()) {
  return {
    client,
    provider: new IrisMemoryProvider({ client, stateStore: new MemoryAdapterStateStore() }),
  };
}

describe("IrisMemoryProvider", () => {
  it("passes the shared provider conformance harness", async () => {
    const { provider } = makeProvider();
    await assertMemoryProviderConformance({
      provider,
      query,
      tokenBudget: 32,
      deadlineMs: 250,
      observeEvent,
      usageReport,
    });
    await provider.flushPending();
  });

  it("maps recall fields explicitly and drops unknown categories fail-closed", async () => {
    const { client, provider } = makeProvider();
    const contribution = await provider.provideContext(
      query,
      { tokenBudget: 32, deadlineMs: 250 },
      new AbortController().signal,
    );
    expect(contribution.returnedBlockIds).toEqual([
      "cand:0123456789abcdef",
      "cand:fedcba9876543210",
    ]);
    expect(contribution.audit.droppedCandidateIds).toEqual(["cand:fedcba9876543210"]);
    expect(contribution.blocks).toHaveLength(1);
    expect(contribution.blocks[0]).toMatchObject({
      id: "cand:0123456789abcdef",
      revision: "2",
      category: "fact",
      providerCategory: "preference",
      placement: "memory",
      priority: 2,
      privacyScope: "space:space-1",
      privacyLabels: ["space:space-1", "private"],
      conflictHint: "redundant",
      expiresAt: Date.parse("2026-09-05T23:00:00Z"),
      sourceRefs: ["iris:claim:claim%2Fone@2"],
    });
    expect(contribution.blocks[0]).not.toHaveProperty("confidence");
    expect(client.recallInput?.deadline_at).toBeDefined();
    expect(client.recallSignal).toBeInstanceOf(AbortSignal);
  });

  it("never observes uncommitted or unplayed assistant output", async () => {
    const { client, provider } = makeProvider();
    await provider.observe(
      [
        {
          ...observeEvent,
          effectState: "cancelled" as never,
          content: undefined,
        },
      ],
      new AbortController().signal,
    );
    await provider.flushPending();
    expect(client.observed).toHaveLength(0);

    await provider.observe([observeEvent], new AbortController().signal);
    await provider.flushPending();
    expect(client.observed[0]?.[0]).toMatchObject({
      idempotency_key: "event-1",
      effect_state: "partial",
      content: "confirmed prefix",
      source_cursor: "4",
    });
  });

  it("observes only confirmed tool effects", async () => {
    const { client, provider } = makeProvider();
    const toolEvent: MemoryObserveEvent = {
      ...observeEvent,
      eventId: "tool-event-1",
      outboxId: "tool-outbox-1",
      role: "tool",
      kind: "tool.result",
      structuredPayload: { result: "ok" },
      effectApplied: false,
    };
    await provider.observe([toolEvent], new AbortController().signal);
    await provider.flushPending();
    expect(client.observed).toHaveLength(0);

    await provider.observe([{ ...toolEvent, effectApplied: true }], new AbortController().signal);
    await provider.flushPending();
    expect(client.observed).toHaveLength(1);
  });

  it("rejects invalid model-visible usage subsets before enqueue", async () => {
    const { client, provider } = makeProvider();
    await expect(
      provider.reportUsage(
        { ...usageReport, modelVisibleBlockIds: ["cand:fedcba9876543210"] },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/subset/);
    await provider.flushPending();
    expect(client.usages).toHaveLength(0);
  });

  it("loads a verified persona during start and exposes only structured data", async () => {
    const { provider } = makeProvider();
    await provider.start({
      appInstanceId: "bellis-1",
      agentId: "agent-1",
      nowMs: () => 1_700_000_000_000,
    });
    const persona = await provider.current("agent-1", new AbortController().signal);
    expect(persona).toMatchObject({
      agentId: "agent-1",
      revision: "1",
      policyMode: "locked",
      core: { language: "zh", name: "Iris" },
      origin: "live",
    });
    expect(persona).not.toHaveProperty("prompt");
    await provider.stop();
  });

  it("materializes an expired cached persona state at its baseline", async () => {
    let nowMs = 1_700_000_000_000;
    const client = new FakeIrisClient();
    client.personaState = {
      state: { mood: "energized" },
      baseline: { mood: "neutral" },
      expires_us: (nowMs + 1_000) * 1_000,
    };
    const provider = new IrisMemoryProvider({ client, stateStore: new MemoryAdapterStateStore() });
    await provider.start({ appInstanceId: "bellis-1", agentId: "agent-1", nowMs: () => nowMs });
    expect((await provider.current("agent-1", new AbortController().signal)).state?.fields).toEqual(
      {
        mood: "energized",
      },
    );

    nowMs += 1_001;
    expect((await provider.current("agent-1", new AbortController().signal)).state?.fields).toEqual(
      {
        mood: "neutral",
      },
    );
    await provider.stop();
  });

  it("persists encrypted adapter state without plaintext payload leakage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bellis-iris-state-"));
    try {
      const path = join(directory, "state.json");
      const store = new JsonAdapterStateStore(path, { encryptionKey: new Uint8Array(32).fill(7) });
      const persona = {
        agentId: "agent-1",
        revision: "1",
        ...personaContent(),
        contentHash: computePersonaContentHash(personaContent()),
        policyMode: "locked",
        state: null,
        effectiveFrom: 1,
        fetchedAt: 2,
        origin: "live",
      } satisfies PersonaSnapshot;
      await store.save({
        version: 1,
        sourceCursors: {},
        personaCache: { "agent-1": persona },
        pending: [],
      });
      expect(await readFile(path, "utf8")).not.toContain("Iris");
      expect((await store.load())?.personaCache["agent-1"]?.contentHash).toBe(persona.contentHash);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not acknowledge observe before the remote request succeeds", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    class SlowClient extends FakeIrisClient {
      public override async observeBatch(
        records: readonly ObservationRecordInput[],
      ): Promise<unknown> {
        await waiting;
        return super.observeBatch(records);
      }
    }
    const client = new SlowClient();
    const provider = new IrisMemoryProvider({ client });
    let acknowledged = false;
    const delivery = provider.observe([observeEvent], new AbortController().signal).then(() => {
      acknowledged = true;
    });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    expect(client.observed).toHaveLength(0);
    release();
    await delivery;
    expect(client.observed).toHaveLength(1);
    expect(acknowledged).toBe(true);
  });

  it("returns remote failures to the host Outbox for observe and usage", async () => {
    class OfflineClient extends FakeIrisClient {
      public override async observeBatch(): Promise<unknown> {
        throw new Error("offline");
      }
      public override async reportRecallUsage(): Promise<unknown> {
        throw new Error("offline");
      }
    }
    const provider = new IrisMemoryProvider({ client: new OfflineClient() });
    await expect(provider.observe([observeEvent], new AbortController().signal)).rejects.toThrow(
      "offline",
    );
    await expect(provider.reportUsage(usageReport, new AbortController().signal)).rejects.toThrow(
      "offline",
    );
  });

  it("retains expired legacy pending rows for reconciliation instead of silently dropping them", async () => {
    const client = new FakeIrisClient();
    const store = new MemoryAdapterStateStore();
    await store.save({
      version: 1,
      sourceCursors: {},
      personaCache: {},
      pending: [
        {
          id: "legacy-observe",
          kind: "observe",
          payload: [observeEvent],
          createdAtMs: 0,
          attempts: 0,
          nextAttemptAtMs: 0,
        },
      ],
    });
    const provider = new IrisMemoryProvider({ client, stateStore: store, outboxTtlMs: 1 });
    await provider.start({ appInstanceId: "restart", agentId: "agent-1" });
    try {
      await provider.flushPending();
      expect(client.observed).toHaveLength(0);
      expect((await store.load())?.pending).toHaveLength(1);
    } finally {
      await provider.stop();
    }
  });

  it("fails closed in required lease mode across repeated acquisition failures", async () => {
    class FailingLeaseClient extends FakeIrisClient {
      public override async acquireSurfaceLease(): Promise<LeaseView> {
        throw new Error("fenced");
      }
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const provider = new IrisMemoryProvider({
        client: new FailingLeaseClient(),
        stateStore: new MemoryAdapterStateStore(),
        activeSurfaceMode: "required",
      });
      await expect(
        provider.start({ appInstanceId: `bellis-${attempt}`, agentId: "agent-1" }),
      ).rejects.toThrow("fenced");
      expect((await provider.capabilities(new AbortController().signal)).healthy).toBe(false);
    }
  });

  it("fails closed when required lease acquisition returns a non-active lease", async () => {
    class ReleasedLeaseClient extends FakeIrisClient {
      public override async acquireSurfaceLease(): Promise<LeaseView> {
        return { ...(await super.acquireSurfaceLease()), status: "released" };
      }
    }
    const provider = new IrisMemoryProvider({
      client: new ReleasedLeaseClient(),
      stateStore: new MemoryAdapterStateStore(),
      activeSurfaceMode: "required",
    });
    await expect(provider.start({ appInstanceId: "bellis-1", agentId: "agent-1" })).rejects.toThrow(
      "invalid active-surface lease",
    );
    expect((await provider.capabilities(new AbortController().signal)).healthy).toBe(false);
  });

  it("invalidates a cached persona when Recall revision/hash disagrees", async () => {
    class MismatchClient extends FakeIrisClient {
      public override async recall(
        input: RecallRequest,
        options?: { signal?: AbortSignal },
      ): Promise<RecallResponse> {
        return {
          ...(await super.recall(input, options)),
          persona_revision: 2,
          persona_content_hash: "0".repeat(64),
        };
      }
    }
    const client = new MismatchClient();
    const provider = new IrisMemoryProvider({ client, stateStore: new MemoryAdapterStateStore() });
    await provider.start({ appInstanceId: "bellis-1", agentId: "agent-1" });
    const invalidations: string[] = [];
    const subscription = provider.subscribe((event) => invalidations.push(event.reason));
    await provider.provideContext(
      query,
      { tokenBudget: 32, deadlineMs: 250 },
      new AbortController().signal,
    );
    expect(invalidations).toEqual(["recall-mismatch"]);
    subscription.dispose();
    await provider.stop();
  });
});
