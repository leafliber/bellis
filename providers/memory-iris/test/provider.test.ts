import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  MemoryRecallRequest,
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
import { describe, expect, it, vi } from "vitest";

import {
  IrisMemoryProvider,
  JsonAdapterStateStore,
  MemoryAdapterStateStore,
  computePersonaContentHash,
  IrisBoundaryError,
  type IrisClientPort,
  type AdapterPersistentState,
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
  effectProof: { confirmed_range: { unit: "utf16", start: 0, end: 16 } },
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
      schema_version: 14,
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
          content_hash: "a".repeat(64),
          text: "The viewer prefers Chinese",
          category: "preference",
          placement: "memory",
          scope: { space_id: "space-1" },
          privacy_labels: ["space:space-1", "entity:viewer-1:private"],
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
          content_hash: "b".repeat(16),
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
    return {
      accepted_observation_ids: records.map((record) => `obs:${record.idempotency_key}`),
      duplicate_observation_ids: [],
      outbox_enqueued: records.length,
    };
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

it.each([13, 14, 15, 16])(
  "limits default schema negotiation to verified versions (schema %s)",
  async (schemaVersion) => {
    const client = new FakeIrisClient();
    const negotiate = client.negotiate.bind(client);
    client.negotiate = async () => ({ ...(await negotiate()), schema_version: schemaVersion });
    const provider = new IrisMemoryProvider({ client });
    try {
      if (schemaVersion === 14 || schemaVersion === 15) {
        await provider.start({ appInstanceId: "schema-probe", agentId: "agent-1" });
        expect((await provider.capabilities(new AbortController().signal)).coreSchemaVersion).toBe(
          schemaVersion,
        );
      } else {
        await expect(
          provider.start({ appInstanceId: "schema-probe", agentId: "agent-1" }),
        ).rejects.toMatchObject({ code: "incompatible_core" });
      }
    } finally {
      await provider.stop();
    }
  },
);

function makeProvider(client = new FakeIrisClient()) {
  return {
    client,
    provider: new IrisMemoryProvider({ client, stateStore: new MemoryAdapterStateStore() }),
  };
}

it("waits for durable request preparation and sends exactly the recorded body", async () => {
  const { client, provider } = makeProvider();
  const records: MemoryRecallRequest[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await provider.start({
      appInstanceId: "request-record-test",
      agentId: query.agentId,
      recordRecallRequest: async (value) => {
        records.push(value);
        await gate;
      },
    });
    const pending = provider.provideContext(
      query,
      { tokenBudget: 100, deadlineMs: 1000 },
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(client.recallInput).toBeUndefined();
    release();
    await pending;
    expect(records[0]!.body).toEqual(client.recallInput);
    expect(records[0]).toMatchObject({
      requestId: query.queryId,
      agentId: query.agentId,
      spaceId: query.spaceId,
    });
    await provider.provideContext(
      query,
      { tokenBudget: 100, deadlineMs: 1000 },
      new AbortController().signal,
    );
    expect(records).toHaveLength(2);
    expect(records[1]!.attemptId).not.toBe(records[0]!.attemptId);
    expect(records[1]!.body).toEqual(client.recallInput);
  } finally {
    release?.();
    await provider.stop();
  }
});

it.each(["rejected", "cancelled"])(
  "does not send Recall after request preparation is %s",
  async (mode) => {
    const { client, provider } = makeProvider();
    const controller = new AbortController();
    try {
      await provider.start({
        appInstanceId: "request-record-test",
        agentId: query.agentId,
        recordRecallRequest: async () => {
          if (mode === "rejected") throw new Error("request store failed");
          controller.abort(new Error("cancelled after preparation"));
        },
      });
      await expect(
        provider.provideContext(query, { tokenBudget: 100, deadlineMs: 1000 }, controller.signal),
      ).rejects.toBeDefined();
      expect(client.recallInput).toBeUndefined();
    } finally {
      await provider.stop();
    }
  },
);

it.each([false, true])(
  "persists and retries the original paired checkpoint, capability=%s",
  async (checkpointSupported) => {
    const client = new EventClient();
    client.checkpointSupported = checkpointSupported;
    class CheckpointStore extends MemoryAdapterStateStore {
      blocked = false;
      failures = 0;
      override async save(state: AdapterPersistentState) {
        if (this.blocked && state.eventCursor === "2") {
          expect(state.eventId).toBe("event:2");
          this.failures++;
          throw new Error("injected checkpoint write failure");
        }
        if (state.eventCursor !== undefined)
          expect(state.eventId).toBe(`event:${state.eventCursor}`);
        await super.save(state);
      }
    }
    const store = new CheckpointStore();
    const requests = vi.spyOn(client, "events");
    const provider = new IrisMemoryProvider({ client, stateStore: store, eventPollMs: 5 });
    let restarted: IrisMemoryProvider | undefined;
    try {
      await provider.start({ appInstanceId: "checkpoint", agentId: "agent-1" });
      await vi.waitFor(() => expect(requests).toHaveBeenCalled(), { interval: 5 });
      expect(requests.mock.calls[0]?.[0]).not.toHaveProperty("afterEventId");
      client.revise(1);
      await vi.waitFor(
        async () =>
          expect(await store.load()).toMatchObject({ eventCursor: "1", eventId: "event:1" }),
        { interval: 5 },
      );
      store.blocked = true;
      requests.mockClear();
      client.revise(2);
      await vi.waitFor(() => expect(store.failures).toBeGreaterThanOrEqual(2), { interval: 5 });
      expect(await store.load()).toMatchObject({ eventCursor: "1", eventId: "event:1" });
      expect(
        requests.mock.calls.every(
          ([options]) =>
            options?.after === "1" &&
            options.afterEventId === (checkpointSupported ? "event:1" : undefined),
        ),
      ).toBe(true);
      store.blocked = false;
      await vi.waitFor(
        async () =>
          expect(await store.load()).toMatchObject({ eventCursor: "2", eventId: "event:2" }),
        { interval: 5 },
      );
      await provider.stop();
      const recoveredClient = new EventClient();
      recoveredClient.checkpointSupported = checkpointSupported;
      recoveredClient.revise(2);
      const recoveredRequests = vi.spyOn(recoveredClient, "events");
      restarted = new IrisMemoryProvider({
        client: recoveredClient,
        stateStore: store,
        eventPollMs: 5,
      });
      await restarted.start({ appInstanceId: "checkpoint", agentId: "agent-1" });
      await vi.waitFor(() => expect(recoveredRequests).toHaveBeenCalled(), { interval: 5 });
      expect(recoveredRequests.mock.calls[0]?.[0]?.after).toBe("2");
      expect(recoveredRequests.mock.calls[0]?.[0]?.afterEventId).toBe(
        checkpointSupported ? "event:2" : undefined,
      );
      expect(await store.load()).toMatchObject({ eventCursor: "2", eventId: "event:2" });
    } finally {
      store.blocked = false;
      await provider.stop().catch(() => {});
      await restarted?.stop();
    }
  },
);

class EventClient extends FakeIrisClient {
  checkpointSupported = false;
  offline = false;
  revision = 1;
  status: "published" | "revoked" | "superseded" = "published";
  event: CoreEvent | undefined;
  reads = 0;
  override async negotiate() {
    const result = await super.negotiate();
    return {
      ...result,
      capabilities: [
        ...result.capabilities,
        "events.sse.v1",
        ...(this.checkpointSupported ? ["events.checkpoint.v1"] : []),
      ],
    };
  }
  override async currentPersona() {
    this.reads++;
    if (this.offline) throw new IrisBoundaryError("unavailable", true);
    const value = await super.currentPersona();
    return {
      ...value,
      revision: { ...value.revision, revision: this.revision, status: this.status },
    };
  }
  override async events(options?: { after?: string; afterEventId?: string }) {
    return this.event !== undefined && options?.after !== this.event.cursor ? [this.event] : [];
  }
  revise(revision: number) {
    this.revision = revision;
    this.event = {
      cursor: String(revision),
      event_id: `event:${revision}`,
      event_type: "persona.revised.v1",
      occurred_at: "2026-09-06T00:00:00Z",
      source_watermark: revision,
      resource_refs: [
        { resource_type: "persona_revision", resource_id: `revision:${revision}`, revision },
      ],
    };
  }
}

describe("IrisMemoryProvider", () => {
  it("retains the canonical candidate resource alongside provenance references for tombstone filtering", async () => {
    const { client, provider } = makeProvider();
    const recall = client.recall.bind(client);
    client.recall = async (request, options) => {
      const value = await recall(request, options);
      return {
        ...value,
        candidates: value.candidates.map((candidate) => ({
          ...candidate,
          source_refs: [{ resource_type: "observation", resource_id: "origin", revision: 1 }],
        })),
      };
    };
    const contribution = await provider.provideContext(
      query,
      { tokenBudget: 32, deadlineMs: 250 },
      new AbortController().signal,
    );
    expect(contribution.blocks[0]?.sourceRefs).toEqual([
      "iris:claim:claim%2Fone@2",
      "iris:observation:origin@1",
    ]);
  });

  it("refreshes transient Persona state in the background when Core has no event capability", async () => {
    const client = new FakeIrisClient();
    client.events = async () => {
      throw new Error("events capability absent");
    };
    const provider = new IrisMemoryProvider({ client, eventPollMs: 5 });
    await provider.start({ appInstanceId: "state-poll", agentId: "agent-1", nowMs: () => 100 });
    try {
      const before = await provider.current("agent-1", new AbortController().signal);
      client.personaState = {
        state: { mood: "calm" },
        baseline: { mood: "neutral" },
        expires_us: 1_000_000,
      };
      await vi.waitFor(
        async () => {
          const after = await provider.current("agent-1", new AbortController().signal);
          expect(after.state?.fields).toEqual({ mood: "calm" });
          expect(after.revision).toBe(before.revision);
          expect(after.contentHash).toBe(before.contentHash);
        },
        { interval: 5 },
      );
    } finally {
      await provider.stop();
    }
  });

  it("persists authorization failure during negotiation so later offline startup cannot use static Persona", async () => {
    const client = new EventClient();
    const store = new MemoryAdapterStateStore();
    const first = new IrisMemoryProvider({ client, stateStore: store });
    await first.start({ appInstanceId: "auth", agentId: "agent-1" });
    const staticPersona = await first.current("agent-1", new AbortController().signal);
    await first.stop();
    client.negotiate = async () => {
      throw new IrisBoundaryError("forbidden", false, 403);
    };
    const revoked = new IrisMemoryProvider({ client, stateStore: store, staticPersona });
    await expect(
      revoked.start({ appInstanceId: "auth", agentId: "agent-1" }),
    ).rejects.toMatchObject({ status: 403 });
    expect((await store.load())?.personaBarriers?.["agent-1"]).toBeDefined();
    client.negotiate = async () => {
      throw new IrisBoundaryError("unavailable", true);
    };
    await expect(
      revoked.start({ appInstanceId: "auth", agentId: "agent-1" }),
    ).rejects.toMatchObject({ code: "unavailable" });
    await revoked.stop();
  });

  it("discards a refresh overtaken by a newer Recall invalidation", async () => {
    const client = new EventClient();
    const installed: string[] = [];
    class Store extends MemoryAdapterStateStore {
      override async save(state: AdapterPersistentState) {
        const revision = state.personaCache["agent-1"]?.revision;
        if (revision !== undefined) installed.push(revision);
        await super.save(state);
      }
    }
    const store = new Store();
    const provider = new IrisMemoryProvider({ client, stateStore: store, eventPollMs: 5 });
    await provider.start({ appInstanceId: "late", agentId: "agent-1" });
    const current = client.currentPersona.bind(client);
    let finish!: (value: PersonaCurrentResponse) => void;
    client.currentPersona = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    try {
      client.revise(2);
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"), { interval: 5 });
      const stale = await current();
      const recall = client.recall.bind(client);
      client.recall = async (request, options) => ({
        ...(await recall(request, options)),
        persona_revision: 3,
      });
      await provider.provideContext(
        query,
        { tokenBudget: 32, deadlineMs: 250 },
        new AbortController().signal,
      );
      await vi.waitFor(
        async () =>
          expect((await store.load())?.personaBarriers?.["agent-1"]?.minimumRevision).toBe("3"),
        { interval: 5 },
      );
      client.revise(3);
      client.currentPersona = current;
      finish(stale);
      await vi.waitFor(async () => expect((await store.load())?.eventCursor).toBe("3"), {
        interval: 5,
      });
      expect(installed).not.toContain("2");
      expect((await provider.current("agent-1", new AbortController().signal)).revision).toBe("3");
    } finally {
      await provider.stop();
    }
  });

  it("restores the read barrier if durable installation of a refreshed Persona fails", async () => {
    const client = new EventClient();
    class FailingStore extends MemoryAdapterStateStore {
      override async save(state: AdapterPersistentState) {
        if (state.personaCache["agent-1"]?.revision === "2") {
          client.offline = true;
          throw new Error("injected storage failure");
        }
        await super.save(state);
      }
    }
    const store = new FailingStore();
    const provider = new IrisMemoryProvider({ client, stateStore: store, eventPollMs: 5 });
    await provider.start({ appInstanceId: "storage", agentId: "agent-1" });
    try {
      client.revise(2);
      await vi.waitFor(() => expect(client.offline).toBe(true), { interval: 5 });
      await expect(provider.current("agent-1", new AbortController().signal)).rejects.toMatchObject(
        { retryable: true },
      );
      const state = await store.load();
      expect(state?.personaBarriers?.["agent-1"]?.minimumRevision).toBe("2");
      expect(state?.personaCache["agent-1"]).toBeUndefined();
      expect(state?.eventCursor).toBeUndefined();
    } finally {
      await provider.stop();
    }
  });

  it("persists failed event invalidation before cursor advancement and forbids static fallback after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "iris-persona-barrier-"));
    const client = new EventClient();
    const path = join(directory, "state.json");
    const store = new JsonAdapterStateStore(path);
    const provider = new IrisMemoryProvider({ client, stateStore: store, eventPollMs: 5 });
    let restarted: IrisMemoryProvider | undefined;
    try {
      await provider.start({ appInstanceId: "barrier-test", agentId: "agent-1" });
      const staticPersona = await provider.current("agent-1", new AbortController().signal);
      client.offline = true;
      client.revise(2);
      await vi.waitFor(
        async () => {
          const state = await store.load();
          expect(state?.personaBarriers?.["agent-1"]).toMatchObject({
            minimumRevision: "2",
            cursor: "2",
          });
          expect(state?.personaCache["agent-1"]).toBeUndefined();
          expect(state?.eventCursor).toBeUndefined();
        },
        { interval: 5 },
      );
      await provider.stop();
      restarted = new IrisMemoryProvider({
        client,
        stateStore: new JsonAdapterStateStore(path),
        staticPersona,
        eventPollMs: 5,
      });
      await expect(
        restarted.start({ appInstanceId: "restarted", agentId: "agent-1" }),
      ).rejects.toMatchObject({ code: "unavailable" });
      await expect(
        restarted.current("agent-1", new AbortController().signal),
      ).rejects.toMatchObject({ code: "unavailable" });
      client.offline = false;
      await restarted.start({ appInstanceId: "restarted", agentId: "agent-1" });
      await vi.waitFor(async () => expect((await store.load())?.eventCursor).toBe("2"), {
        interval: 5,
      });
      expect((await restarted.current("agent-1", new AbortController().signal)).revision).toBe("2");
      expect((await store.load())?.personaBarriers?.["agent-1"]).toBeUndefined();
    } finally {
      await provider.stop();
      await restarted?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["revoked", "superseded"] as const)(
    "keeps a %s revision blocked through restart until a newer publication is verified",
    async (status) => {
      const client = new EventClient();
      const store = new MemoryAdapterStateStore();
      client.status = status;
      const provider = new IrisMemoryProvider({ client, stateStore: store });
      await expect(
        provider.start({ appInstanceId: "revoked", agentId: "agent-1" }),
      ).rejects.toMatchObject({
        code: status === "revoked" ? "persona_revoked" : "persona_not_published",
      });
      expect((await store.load())?.personaBarriers?.["agent-1"]).toMatchObject({
        reason: status === "revoked" ? "revoked" : "invalidated",
        minimumRevision: "2",
      });
      const restarted = new IrisMemoryProvider({ client, stateStore: store });
      client.status = "published";
      await expect(
        restarted.start({ appInstanceId: "restart", agentId: "agent-1" }),
      ).rejects.toMatchObject({ code: "persona_revision_conflict" });
      client.revision = 2;
      await restarted.start({ appInstanceId: "restart", agentId: "agent-1" });
      expect((await restarted.current("agent-1", new AbortController().signal)).revision).toBe("2");
      expect((await store.load())?.personaBarriers?.["agent-1"]).toBeUndefined();
      await restarted.stop();
      await provider.stop();
    },
  );

  it("bounds an uncooperative Persona read and discards its late response after shutdown", async () => {
    const client = new EventClient();
    const store = new MemoryAdapterStateStore();
    let resolve!: (value: PersonaCurrentResponse) => void;
    const value = await client.currentPersona();
    let reads = 0;
    client.currentPersona = () => {
      reads++;
      return new Promise<PersonaCurrentResponse>((done) => {
        resolve = done;
      });
    };
    const provider = new IrisMemoryProvider({ client, stateStore: store, backgroundTimeoutMs: 10 });
    await expect(
      provider.start({ appInstanceId: "hung", agentId: "agent-1" }),
    ).rejects.toMatchObject({ code: "request_timeout" });
    await expect(provider.current("agent-1", new AbortController().signal)).rejects.toMatchObject({
      code: "operation_busy",
    });
    expect(reads).toBe(1);
    await provider.stop();
    resolve(value);
    await new Promise((done) => setImmediate(done));
    expect((await store.load())?.personaCache["agent-1"]).toBeUndefined();
  });

  it("rejects oversized batches and incomplete durable acknowledgments", async () => {
    class IncompleteClient extends FakeIrisClient {
      public override async observeBatch(): Promise<unknown> {
        return { accepted_observation_ids: [], duplicate_observation_ids: [], outbox_enqueued: 0 };
      }
    }
    const provider = new IrisMemoryProvider({ client: new IncompleteClient() });
    await expect(
      provider.observe([observeEvent], new AbortController().signal),
    ).rejects.toMatchObject({ code: "observe_ack_invalid", retryable: false });
    await expect(
      provider.observe(
        Array.from({ length: 101 }, (_, index) => ({ ...observeEvent, eventId: `event-${index}` })),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "observe_batch_limit" });
  });
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
      privacyLabels: ["space:space-1", "entity:viewer-1:private"],
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

it("persists resource invalidation before host ACK and resumes it before Recall after restart", async () => {
  const client = new EventClient(),
    store = new MemoryAdapterStateStore();
  const event: CoreEvent = {
    cursor: "5",
    event_id: "delete:one",
    event_type: "revision.invalidated.v1",
    occurred_at: "2026-09-07T00:00:00Z",
    source_watermark: 5,
    resource_refs: [{ resource_type: "claim", resource_id: "one" }],
  };
  const reject = vi.fn(async () => {
    throw new Error("host unavailable");
  });
  const first = new IrisMemoryProvider({ client, stateStore: store, eventPollMs: 5 });
  let restarted: IrisMemoryProvider | undefined;
  try {
    await first.start({
      appInstanceId: "resource-events",
      agentId: "agent-1",
      invalidateResources: reject,
    });
    client.event = event;
    await vi.waitFor(
      async () =>
        expect((await store.load())?.pendingResourceInvalidation?.eventId).toBe("delete:one"),
      { interval: 5 },
    );
    await vi.waitFor(() => expect(reject).toHaveBeenCalled(), { interval: 5 });
    expect((await store.load())?.eventCursor).toBeUndefined();
    await expect(
      first.provideContext(
        query,
        { tokenBudget: 100, deadlineMs: 200 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "resource_invalidation_pending" });
    await first.stop();
    const accept = vi.fn(async (value: import("@bellis/contracts").MemoryResourceInvalidation) => {
      expect((await store.load())?.pendingResourceInvalidation).toEqual(value);
      expect(value.resources).toEqual([{ resourceRef: "iris:claim:one", throughRevision: null }]);
    });
    restarted = new IrisMemoryProvider({ client, stateStore: store, eventPollMs: 5 });
    await restarted.start({
      appInstanceId: "resource-events",
      agentId: "agent-1",
      invalidateResources: accept,
    });
    expect(accept).toHaveBeenCalled();
    await vi.waitFor(async () => expect((await store.load())?.eventCursor).toBe("5"), {
      interval: 5,
    });
    expect((await store.load())?.pendingResourceInvalidation).toBeUndefined();
  } finally {
    await first.stop();
    await restarted?.stop();
  }
});

it("quarantines legacy deliveries on invalidation without retrying cancelled rows", async () => {
  const client = new EventClient(),
    store = new MemoryAdapterStateStore();
  await store.save({
    version: 1,
    sourceCursors: {},
    personaCache: {},
    pending: ["first", "second"].map((id) => ({
      id,
      kind: "usage" as const,
      payload: { ...usageReport, outboxId: id },
      createdAtMs: Date.now(),
      attempts: 0,
      nextAttemptAtMs: 0,
    })),
  });
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const report = client.reportRecallUsage.bind(client);
  client.reportRecallUsage = vi.fn(async (...args) => {
    await held;
    return report(...args);
  });
  const provider = new IrisMemoryProvider({ client, stateStore: store, eventPollMs: 5 });
  try {
    await provider.start({
      appInstanceId: "legacy-resource",
      agentId: "agent-1",
      invalidateResources: async () => {},
    });
    await vi.waitFor(() => expect(client.reportRecallUsage).toHaveBeenCalledTimes(1), {
      interval: 5,
    });
    client.event = {
      cursor: "7",
      event_id: "delete:legacy",
      event_type: "revision.invalidated.v1",
      occurred_at: "2026-09-07T00:00:00Z",
      source_watermark: 7,
      resource_refs: [{ resource_type: "claim", resource_id: "one" }],
    };
    await vi.waitFor(async () => expect((await store.load())?.eventCursor).toBe("7"), {
      interval: 5,
    });
    await provider.flushPending();
    const saved = await store.load();
    expect(saved?.legacyInvalidated).toBe(true);
    expect(saved?.pending.map((row) => [row.id, row.attempts])).toEqual([
      ["first", 0],
      ["second", 0],
    ]);
    expect(client.reportRecallUsage).toHaveBeenCalledTimes(1);
  } finally {
    finish();
    await provider.stop();
  }
});

it("rejects an old in-flight Recall even after the resource event has been acknowledged", async () => {
  const client = new EventClient(),
    store = new MemoryAdapterStateStore();
  const recall = client.recall.bind(client);
  let finish!: () => void, started!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const active = new Promise<void>((resolve) => {
    started = resolve;
  });
  client.recall = async (request) => {
    const value = await recall(request);
    started();
    await held;
    return value;
  };
  const provider = new IrisMemoryProvider({ client, stateStore: store, eventPollMs: 5 });
  try {
    await provider.start({
      appInstanceId: "late-resource",
      agentId: "agent-1",
      invalidateResources: async () => {},
    });
    const pending = provider.provideContext(
      query,
      { tokenBudget: 100, deadlineMs: 1000 },
      new AbortController().signal,
    );
    const rejected = expect(pending).rejects.toMatchObject({
      code: "resource_invalidation_pending",
    });
    await active;
    client.event = {
      cursor: "6",
      event_id: "delete:late",
      event_type: "revision.invalidated.v1",
      occurred_at: "2026-09-07T00:00:00Z",
      source_watermark: 6,
      resource_refs: [{ resource_type: "claim", resource_id: "one", revision: 2 }],
    };
    await vi.waitFor(async () => expect((await store.load())?.eventCursor).toBe("6"), {
      interval: 5,
    });
    finish();
    await rejected;
  } finally {
    finish();
    await provider.stop();
  }
});

it("retains a reported history gap across host ACK loss and restart without reading or advancing the old checkpoint", async () => {
  const client = new EventClient();
  const store = new MemoryAdapterStateStore();
  const legacy = {
    id: "original-legacy",
    kind: "usage" as const,
    payload: usageReport,
    createdAtMs: Date.now(),
    attempts: 3,
    nextAttemptAtMs: Date.now() + 60_000,
  };
  await store.save({
    version: 1,
    sourceCursors: {},
    personaCache: {},
    pending: [legacy],
    eventCursor: "7",
    eventId: "old:7",
  });
  const events = vi
    .spyOn(client, "events")
    .mockRejectedValue(new IrisBoundaryError("history_unavailable", false, 410));
  let allowAck = false;
  const notify = vi.fn(async () => {
    if (!allowAck) throw new Error("host ACK lost");
  });
  const provider = new IrisMemoryProvider({ client, stateStore: store, eventPollMs: 5 });
  let restarted: IrisMemoryProvider | undefined;
  try {
    await provider.start({
      appInstanceId: "history",
      agentId: "agent-1",
      historyUnavailable: notify,
    });
    await vi.waitFor(
      async () =>
        expect((await store.load())?.historyGap).toMatchObject({
          cursor: "7",
          eventId: "old:7",
          reason: "history_unavailable",
        }),
      { interval: 5 },
    );
    await vi.waitFor(() => expect(notify.mock.calls.length).toBeGreaterThan(1), { interval: 5 });
    expect(events).toHaveBeenCalledTimes(1);
    const gap = (await store.load())!.historyGap!;
    expect((await provider.capabilities(new AbortController().signal)).healthy).toBe(false);
    await expect(
      provider.provideContext(
        query,
        { tokenBudget: 100, deadlineMs: 200 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "history_unavailable" });
    await expect(provider.current("agent-1", new AbortController().signal)).rejects.toMatchObject({
      code: "history_unavailable",
    });
    await expect(
      provider.observe([observeEvent], new AbortController().signal),
    ).rejects.toMatchObject({ code: "history_unavailable", retryable: true });
    await expect(
      provider.reportUsage(usageReport, new AbortController().signal),
    ).rejects.toMatchObject({ code: "history_unavailable", retryable: true });
    await provider.flushPending();
    expect((await store.load())?.pending).toEqual([legacy]);
    expect(client.usages).toEqual([]);
    allowAck = true;
    const callsBefore = notify.mock.calls.length;
    await vi.waitFor(() => expect(notify.mock.calls.length).toBeGreaterThan(callsBefore), {
      interval: 5,
    });
    await provider.stop();
    expect(await store.load()).toMatchObject({
      eventCursor: "7",
      eventId: "old:7",
      historyGap: gap,
      pending: [legacy],
    });
    const restartNotify = vi.fn(async () => {});
    restarted = new IrisMemoryProvider({ client, stateStore: store, eventPollMs: 5 });
    const reads = client.reads;
    await expect(
      restarted.start({
        appInstanceId: "history",
        agentId: "agent-1",
        historyUnavailable: restartNotify,
      }),
    ).rejects.toMatchObject({ code: "history_unavailable" });
    expect(restartNotify).toHaveBeenCalledWith(gap, expect.any(AbortSignal));
    expect(client.reads).toBe(reads);
    expect(events).toHaveBeenCalledTimes(1);
  } finally {
    await provider.stop();
    await restarted?.stop();
  }
});

it("notifies the host even when the adapter gap save fails and retries the same gap without another SSE request", async () => {
  class FaultStore extends MemoryAdapterStateStore {
    fail = true;
    override async save(state: AdapterPersistentState) {
      if (state.historyGap && this.fail) throw new Error("adapter disk full");
      await super.save(state);
    }
  }
  const store = new FaultStore();
  const client = new EventClient();
  const events = vi
    .spyOn(client, "events")
    .mockRejectedValue(new IrisBoundaryError("history_unavailable", false, 410));
  const notify = vi.fn(async () => {});
  const provider = new IrisMemoryProvider({ client, stateStore: store, eventPollMs: 5 });
  try {
    await provider.start({
      appInstanceId: "history-save",
      agentId: "agent-1",
      historyUnavailable: notify,
    });
    await vi.waitFor(() => expect(notify.mock.calls.length).toBeGreaterThan(1), { interval: 5 });
    expect((await store.load())?.historyGap).toBeUndefined();
    await expect(
      provider.observe([observeEvent], new AbortController().signal),
    ).rejects.toMatchObject({ code: "history_unavailable" });
    store.fail = false;
    await vi.waitFor(async () => expect((await store.load())?.historyGap).toBeDefined(), {
      interval: 5,
    });
    expect(events).toHaveBeenCalledTimes(1);
    const saved = (await store.load())!.historyGap;
    for (const call of notify.mock.calls) expect(call[0]).toEqual(saved);
  } finally {
    store.fail = false;
    await provider.stop();
  }
});

it("reports a missing legacy checkpoint identity before opening persona or SSE on a checkpoint-capable Core", async () => {
  const store = new MemoryAdapterStateStore();
  await store.save({
    version: 1,
    sourceCursors: {},
    personaCache: {},
    pending: [],
    eventCursor: "9",
  });
  const client = new EventClient();
  const negotiate = client.negotiate.bind(client);
  client.negotiate = async () => {
    const value = await negotiate();
    return { ...value, capabilities: [...value.capabilities, "events.checkpoint.v1"] };
  };
  const events = vi.spyOn(client, "events");
  const notify = vi.fn(async () => {});
  const provider = new IrisMemoryProvider({ client, stateStore: store });
  try {
    await expect(
      provider.start({
        appInstanceId: "legacy-history",
        agentId: "agent-1",
        historyUnavailable: notify,
      }),
    ).rejects.toMatchObject({ code: "history_unavailable" });
    expect(notify).toHaveBeenCalledOnce();
    expect((await store.load())?.historyGap).toMatchObject({
      reason: "checkpoint_missing",
      cursor: "9",
    });
    expect((await store.load())?.historyGap).not.toHaveProperty("eventId");
    expect(client.reads).toBe(0);
    expect(events).not.toHaveBeenCalled();
  } finally {
    await provider.stop();
  }
});

it.each([
  new IrisBoundaryError("unavailable", true, 503),
  new IrisBoundaryError("resource_gone", false, 410),
])("does not convert unrelated event errors into a history-gap receipt (%s)", async (error) => {
  const client = new EventClient(),
    store = new MemoryAdapterStateStore();
  const events = vi.spyOn(client, "events").mockRejectedValue(error);
  const notify = vi.fn(async () => {});
  const provider = new IrisMemoryProvider({ client, stateStore: store, eventPollMs: 5 });
  try {
    await provider.start({
      appInstanceId: "ordinary-error",
      agentId: "agent-1",
      historyUnavailable: notify,
    });
    await vi.waitFor(() => expect(events.mock.calls.length).toBeGreaterThan(1), { interval: 5 });
    expect(notify).not.toHaveBeenCalled();
    expect((await store.load())?.historyGap).toBeUndefined();
  } finally {
    await provider.stop();
  }
});

it("does not return an expired cached persona when a gap arrives during its durable baseline save", async () => {
  let nowMs = 1_700_000_000_000,
    release!: () => void,
    entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  class HeldStore extends MemoryAdapterStateStore {
    hold = false;
    override async save(state: AdapterPersistentState) {
      if (
        this.hold &&
        !state.historyGap &&
        state.personaCache["agent-1"]?.state?.fields.mood === "neutral"
      ) {
        this.hold = false;
        entered();
        await held;
      }
      await super.save(state);
    }
  }
  const store = new HeldStore(),
    client = new EventClient();
  client.personaState = {
    state: { mood: "energized" },
    baseline: { mood: "neutral" },
    expires_us: (nowMs + 1000) * 1000,
  };
  const notify = vi.fn(async () => {});
  const provider = new IrisMemoryProvider({ client, stateStore: store, eventPollMs: 5 });
  try {
    await provider.start({
      appInstanceId: "cache-gap",
      agentId: "agent-1",
      nowMs: () => nowMs,
      historyUnavailable: notify,
    });
    store.hold = true;
    nowMs += 1001;
    client.events = async () => {
      throw new IrisBoundaryError("history_unavailable", false, 410);
    };
    const current = provider.current("agent-1", new AbortController().signal);
    const rejected = expect(current).rejects.toMatchObject({ code: "history_unavailable" });
    await started;
    await vi.waitFor(() => expect(notify).toHaveBeenCalled(), { interval: 5 });
    release();
    await rejected;
    await vi.waitFor(async () => expect((await store.load())?.historyGap).toBeDefined(), {
      interval: 5,
    });
  } finally {
    release();
    await provider.stop();
  }
});

it.each([401, 403, 404])(
  "latches HTTP %s authorization rejection, stops polling and preserves the Persona barrier",
  async (status) => {
    const client = new EventClient();
    const store = new MemoryAdapterStateStore();
    const events = vi.fn(async () => {
      throw new IrisBoundaryError("access_denied", false, status);
    });
    client.events = events;
    const provider = new IrisMemoryProvider({ client, stateStore: store, eventPollMs: 10 });
    const invalidated = vi.fn();
    provider.subscribe(invalidated);
    try {
      await provider.start({ appInstanceId: "authorization", agentId: "agent-1" });
      await vi.waitFor(() => expect(invalidated).toHaveBeenCalled());
      expect(await provider.capabilities(new AbortController().signal)).toMatchObject({
        healthy: false,
        degradedReason: "authorization_unavailable",
      });
      await expect(provider.current("agent-1", new AbortController().signal)).rejects.toMatchObject(
        { code: "authorization_unavailable", retryable: false },
      );
      const count = events.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(events).toHaveBeenCalledTimes(count);
      const state = await store.load();
      expect(state?.personaCache["agent-1"]).toBeUndefined();
      expect(state?.personaBarriers?.["agent-1"]).toBeDefined();
      await provider.start({ appInstanceId: "authorization", agentId: "agent-1" });
      expect((await provider.capabilities(new AbortController().signal)).healthy).toBe(false);
      await provider.stop();
      client.events = async () => [];
      await provider.start({ appInstanceId: "authorization", agentId: "agent-1" });
      expect((await provider.capabilities(new AbortController().signal)).healthy).toBe(true);
      expect((await provider.current("agent-1", new AbortController().signal)).origin).toBe("live");
    } finally {
      await provider.stop();
    }
  },
);
