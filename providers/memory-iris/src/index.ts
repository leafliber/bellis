import { createHash } from "node:crypto";

import {
  PersonaSnapshotSchema,
  type ContextCategory,
  type ContextContribution,
  type JsonValue,
  type MemoryObserveEvent,
  type MemoryProvider,
  type MemoryProviderCapabilities,
  type MemoryProviderContext,
  type MemoryQuery,
  type MemoryUsageReport,
  type PersonaInvalidation,
  type PersonaSnapshot,
  type PersonaSource,
} from "@bellis/contracts/memory";
import {
  AsyncIrisMemoryClient,
  type CapabilitiesEnvelope,
  type CoreEvent,
  type LeaseView,
  type ObservationRecordInput,
  type PersonaCurrentResponse,
  type RecallRequest,
  type RecallResponse,
  type SourceCursorEnvelope,
} from "@iris-memory/sdk";

import {
  CORE_CATEGORY_VOCABULARY,
  CORE_RESOURCE_TYPES,
  MAPPING_VERSION,
  PRIORITY_DERIVATION_VERSION,
  deriveContextCategory,
  mapRecallCandidate,
  selectWithinBudget,
} from "./mapping.js";
import {
  MemoryAdapterStateStore,
  type AdapterPersistentState,
  type AdapterStateStore,
  type PendingDelivery,
} from "./state-store.js";

export {
  CORE_CATEGORY_VOCABULARY,
  CORE_RESOURCE_TYPES,
  MAPPING_VERSION,
  PRIORITY_DERIVATION_VERSION,
  deriveContextCategory,
} from "./mapping.js";
export {
  JsonAdapterStateStore,
  MemoryAdapterStateStore,
  type AdapterPersistentState,
  type AdapterStateStore,
  type PendingDelivery,
} from "./state-store.js";

export type IrisContextContribution = ContextContribution &
  Required<
    Pick<
      ContextContribution,
      | "mappingVersion"
      | "priorityDerivationVersion"
      | "returnedBlockIds"
      | "sourceWatermark"
      | "completedRoutes"
      | "degradedRoutes"
      | "partial"
      | "cacheUntil"
      | "nextWakeAt"
      | "personaRevision"
      | "personaContentHash"
      | "audit"
    >
  >;

export const IRIS_PROVIDER_VERSION = "0.1.0";

const REQUIRED_CAPABILITIES = [
  "contract.negotiation",
  "observe.batch.v1",
  "persona.read.v1",
  "recall.usage.v1",
  "recall.v1",
  "source-cursor.v1",
] as const;

export interface IrisClientPort {
  negotiate(
    apiVersions?: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<CapabilitiesEnvelope>;
  recall(input: RecallRequest, options?: { signal?: AbortSignal }): Promise<RecallResponse>;
  reportRecallUsage(
    requestId: string,
    input: {
      host_cycle_id: string;
      persona_revision: number;
      returned_candidate_ids: readonly string[];
      host_selected_candidate_ids: readonly string[];
      model_visible_candidate_ids: readonly string[];
      reported_at: string;
    },
    options: { idempotencyKey: string; signal?: AbortSignal },
  ): Promise<unknown>;
  observeBatch(
    records: readonly ObservationRecordInput[],
    options?: {
      idempotencyKey?: string;
      signal?: AbortSignal;
      lease_id?: string;
      lease_epoch?: number;
    },
  ): Promise<unknown>;
  currentPersona(
    agentId: string,
    options?: { signal?: AbortSignal },
  ): Promise<PersonaCurrentResponse>;
  sourceCursor(
    sourceStream: string,
    agentId: string,
    options?: { signal?: AbortSignal },
  ): Promise<SourceCursorEnvelope>;
  events(options?: { after?: string; signal?: AbortSignal }): Promise<readonly CoreEvent[]>;
  acquireSurfaceLease(
    input: {
      agent_id: string;
      holder_app_instance_id: string;
      ttl_us: number;
      priority?: number;
      allow_preempt?: boolean;
      reason?: string;
    },
    options?: { signal?: AbortSignal },
  ): Promise<LeaseView>;
  heartbeatSurfaceLease(
    leaseId: string,
    input: { lease_epoch: number; holder_app_instance_id: string; ttl_us: number },
    options?: { signal?: AbortSignal },
  ): Promise<LeaseView>;
  releaseSurfaceLease(
    leaseId: string,
    input: { lease_epoch: number; holder_app_instance_id: string; reason?: string },
    options?: { signal?: AbortSignal },
  ): Promise<LeaseView>;
}

export interface IrisMemoryProviderConfig {
  readonly baseUrl?: string;
  readonly bearerToken?: string;
  readonly client?: IrisClientPort;
  readonly activeSurfaceMode?: "off" | "advisory" | "required";
  readonly leaseTtlMs?: number;
  readonly leasePriority?: number;
  readonly allowLeasePreempt?: boolean;
  readonly minimumCoreSchemaVersion?: number;
  readonly maximumCoreSchemaVersion?: number;
  readonly categoryMap?: Readonly<Record<string, ContextCategory>>;
  readonly stateStore?: AdapterStateStore;
  readonly outboxCapacity?: number;
  readonly outboxTtlMs?: number;
  readonly retryBaseMs?: number;
  readonly eventPollMs?: number;
  readonly staticPersona?: PersonaSnapshot;
}

function nowIso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function millisecondsToMicroseconds(value: number): number {
  const converted = value * 1000;
  if (!Number.isSafeInteger(converted)) throw new RangeError("timestamp exceeds safe microseconds");
  return converted;
}

function asJsonValue(value: string | number | boolean | null): JsonValue {
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function computePersonaContentHash(
  snapshot: Pick<PersonaSnapshot, "core" | "traits" | "narrative">,
): string {
  const value = {
    canonical_json_version: 1,
    content: { core: snapshot.core, traits: snapshot.traits, narrative: snapshot.narrative },
  };
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function validatePersonaSnapshot(snapshot: PersonaSnapshot): PersonaSnapshot {
  const parsed = PersonaSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) throw new Error("persona snapshot violates the Bellis contract");
  const encodedBytes = Buffer.byteLength(
    JSON.stringify({ core: snapshot.core, traits: snapshot.traits, narrative: snapshot.narrative }),
  );
  if (encodedBytes > 65_536) throw new Error("persona snapshot exceeds 65536 bytes");
  if (computePersonaContentHash(snapshot) !== snapshot.contentHash) {
    throw new Error("persona content hash mismatch");
  }
  return parsed.data;
}

function mapPersona(
  value: PersonaCurrentResponse,
  nowMs: number,
  origin: PersonaSnapshot["origin"],
): PersonaSnapshot {
  const stateExpiresAt =
    value.state === null ? undefined : Math.floor(value.state.expires_us / 1000);
  const snapshot: PersonaSnapshot = {
    agentId: value.revision.agent_id,
    revision: String(value.revision.revision),
    contentHash: value.revision.content_hash,
    policyMode: value.policy.mode,
    core: value.revision.core as PersonaSnapshot["core"],
    traits: value.revision.traits as PersonaSnapshot["traits"],
    narrative: value.revision.narrative as PersonaSnapshot["narrative"],
    state:
      value.state === null
        ? null
        : {
            fields: (stateExpiresAt !== undefined && stateExpiresAt <= nowMs
              ? value.state.baseline
              : value.state.state) as PersonaSnapshot["core"],
            baseline: value.state.baseline as PersonaSnapshot["core"],
            expiresAt: stateExpiresAt as number,
          },
    effectiveFrom: Math.floor(value.revision.effective_from_us / 1000),
    fetchedAt: nowMs,
    origin,
  };
  if (value.revision.status === "revoked") throw new Error("persona revision is revoked");
  return validatePersonaSnapshot(snapshot);
}

function isSubset(subset: readonly string[], superset: readonly string[]): boolean {
  const available = new Set(superset);
  return subset.every((item) => available.has(item));
}

export class IrisMemoryProvider implements MemoryProvider, PersonaSource {
  public readonly id = "iris";

  readonly #client: IrisClientPort;
  readonly #config: Required<
    Pick<
      IrisMemoryProviderConfig,
      | "activeSurfaceMode"
      | "allowLeasePreempt"
      | "eventPollMs"
      | "leasePriority"
      | "leaseTtlMs"
      | "maximumCoreSchemaVersion"
      | "minimumCoreSchemaVersion"
      | "outboxCapacity"
      | "outboxTtlMs"
      | "retryBaseMs"
    >
  > &
    Pick<IrisMemoryProviderConfig, "categoryMap" | "staticPersona">;
  readonly #store: AdapterStateStore;
  readonly #subscribers = new Set<(event: PersonaInvalidation) => void>();
  #context: MemoryProviderContext | undefined;
  #coreCapabilities: CapabilitiesEnvelope | undefined;
  #healthy = false;
  #degradedReason: string | undefined;
  #lease: LeaseView | undefined;
  #state: AdapterPersistentState = {
    version: 1,
    sourceCursors: {},
    personaCache: {},
    pending: [],
  };
  #running = false;
  #eventTimer: NodeJS.Timeout | undefined;
  #leaseTimer: NodeJS.Timeout | undefined;
  #flushTimer: NodeJS.Timeout | undefined;
  #saving: Promise<void> = Promise.resolve();
  #flushing: Promise<void> | undefined;

  public constructor(config: IrisMemoryProviderConfig) {
    if (config.client === undefined && config.baseUrl === undefined) {
      throw new TypeError("baseUrl or client is required");
    }
    const clientOptions =
      config.bearerToken === undefined ? {} : { bearerToken: config.bearerToken };
    this.#client =
      config.client ?? new AsyncIrisMemoryClient(config.baseUrl as string, clientOptions);
    this.#store = config.stateStore ?? new MemoryAdapterStateStore();
    this.#config = {
      activeSurfaceMode: config.activeSurfaceMode ?? "off",
      allowLeasePreempt: config.allowLeasePreempt ?? false,
      eventPollMs: config.eventPollMs ?? 1_000,
      leasePriority: config.leasePriority ?? 0,
      leaseTtlMs: config.leaseTtlMs ?? 30_000,
      maximumCoreSchemaVersion: config.maximumCoreSchemaVersion ?? 11,
      minimumCoreSchemaVersion: config.minimumCoreSchemaVersion ?? 11,
      outboxCapacity: config.outboxCapacity ?? 1_000,
      outboxTtlMs: config.outboxTtlMs ?? 86_400_000,
      retryBaseMs: config.retryBaseMs ?? 250,
      ...(config.categoryMap === undefined ? {} : { categoryMap: config.categoryMap }),
      ...(config.staticPersona === undefined ? {} : { staticPersona: config.staticPersona }),
    };
  }

  public async start(context: MemoryProviderContext): Promise<void> {
    if (this.#running) return;
    this.#context = context;
    this.#state = (await this.#store.load()) ?? this.#state;
    if (this.#state.pending.length > this.#config.outboxCapacity) {
      throw new Error("legacy outbox exceeds configured capacity; reconciliation required");
    }
    this.#running = true;
    try {
      await this.#negotiate(new AbortController().signal);
      await this.#acquireLease();
      await this.#loadInitialPersona(context.agentId);
      await this.reconcile();
      this.#healthy = this.#config.activeSurfaceMode !== "required" || this.#lease !== undefined;
    } catch (error) {
      this.#healthy = false;
      this.#degradedReason = "startup_unavailable";
      if (
        !this.#activateFallbackPersona(context.agentId) ||
        this.#config.activeSurfaceMode === "required"
      ) {
        this.#running = false;
        throw error;
      }
    }
    this.#scheduleEventPoll();
    this.#scheduleLeaseHeartbeat();
    this.#scheduleFlush(0);
  }

  public async stop(): Promise<void> {
    this.#running = false;
    if (this.#eventTimer !== undefined) clearTimeout(this.#eventTimer);
    if (this.#leaseTimer !== undefined) clearTimeout(this.#leaseTimer);
    if (this.#flushTimer !== undefined) clearTimeout(this.#flushTimer);
    await this.flushPending();
    if (this.#lease !== undefined && this.#context !== undefined) {
      try {
        await this.#client.releaseSurfaceLease(this.#lease.lease_id, {
          lease_epoch: this.#lease.lease_epoch,
          holder_app_instance_id: this.#context.appInstanceId,
          reason: "adapter_stop",
        });
      } catch {
        this.#diagnostic("lease.release_failed", {});
      }
    }
    this.#lease = undefined;
    await this.#saving;
  }

  public async capabilities(signal: AbortSignal): Promise<MemoryProviderCapabilities> {
    if (this.#coreCapabilities === undefined) await this.#negotiate(signal);
    return {
      schemaVersion: 1,
      providerVersion: IRIS_PROVIDER_VERSION,
      mappingVersion: MAPPING_VERSION,
      healthy: this.#healthy,
      categories: this.#producibleCategories(),
      placements: ["working", "memory"],
      observe: true,
      usageReport: true,
      persona: true,
      activeSurfaceMode: this.#config.activeSurfaceMode,
      ...(this.#degradedReason === undefined ? {} : { degradedReason: this.#degradedReason }),
      ...(this.#coreCapabilities === undefined
        ? {}
        : {
            coreApiVersion: this.#coreCapabilities.api_version,
            coreSchemaVersion: this.#coreCapabilities.schema_version,
          }),
    };
  }

  public async provideContext(
    query: MemoryQuery,
    options: { readonly tokenBudget: number; readonly deadlineMs: number },
    signal: AbortSignal,
  ): Promise<IrisContextContribution> {
    if (this.#config.activeSurfaceMode === "required" && this.#lease === undefined) {
      throw new Error("required active-surface lease is unavailable");
    }
    const nowMs = this.#nowMs();
    const boundedDeadline = Math.max(1, Math.min(options.deadlineMs, 60_000));
    const combined = AbortSignal.any([signal, AbortSignal.timeout(boundedDeadline)]);
    const request: RecallRequest = {
      schema_version: 1,
      request_id: query.queryId,
      scope: {
        agent_id: query.agentId,
        space_id: query.spaceId,
        ...(query.spaceGroupId === undefined ? {} : { space_group_id: query.spaceGroupId }),
        ...(query.sessionId === undefined ? {} : { session_id: query.sessionId }),
      },
      actors: query.actors.map((actor) => ({
        provider: actor.provider,
        external_id: actor.externalId,
        ...(actor.realm === undefined ? {} : { realm: actor.realm }),
        ...(actor.weight === undefined ? {} : { weight: actor.weight }),
      })),
      topic: query.topic,
      purpose: query.purpose,
      token_budget: options.tokenBudget,
      deadline_at: nowIso(nowMs + boundedDeadline),
      allow_partial: query.allowPartial ?? true,
      ...(query.requestedPrivacyLabels === undefined
        ? {}
        : { requested_privacy_labels: query.requestedPrivacyLabels }),
      ...(query.minimumWatermark === undefined
        ? {}
        : { minimum_watermark: query.minimumWatermark }),
      ...(query.includeTrace === undefined ? {} : { include_trace: query.includeTrace }),
    };
    const response = await this.#client.recall(request, { signal: combined });
    const mapped = response.candidates.map((candidate, index) => ({
      id: candidate.candidate_id,
      result: mapRecallCandidate(
        candidate,
        index,
        response.candidates.length,
        query,
        response,
        this.#config.categoryMap ?? {},
      ),
    }));
    // The host's category filter is honoured after mapping: Core's category
    // vocabulary is not the host's, so filtering upstream would need an inverse
    // map, while filtering here is exact.
    const requested = query.categories === undefined ? undefined : new Set(query.categories);
    const filteredCandidateIds = mapped
      .filter(
        (item) =>
          item.result.block !== undefined &&
          requested !== undefined &&
          !requested.has(item.result.block.category),
      )
      .map((item) => item.id);
    const filteredOut = new Set(filteredCandidateIds);
    const blocks = selectWithinBudget(
      mapped.flatMap((item) =>
        item.result.block === undefined || filteredOut.has(item.id) ? [] : [item.result.block],
      ),
      options.tokenBudget,
    );
    const droppedCandidateIds = mapped.filter((item) => item.result.dropped).map((item) => item.id);
    const unknownProviderCategories = [
      ...new Set(
        mapped.flatMap((item) =>
          item.result.unknownProviderCategory === undefined
            ? []
            : [item.result.unknownProviderCategory],
        ),
      ),
    ];
    for (const category of unknownProviderCategories) {
      this.#diagnostic("recall.unknown_provider_category", { category });
    }
    this.#checkPersonaCoherence(query.agentId, response);
    return {
      schemaVersion: 1,
      providerId: this.id,
      requestId: query.queryId,
      mappingVersion: MAPPING_VERSION,
      priorityDerivationVersion: PRIORITY_DERIVATION_VERSION,
      blocks: [...blocks],
      returnedBlockIds: response.candidates.map((candidate) => candidate.candidate_id),
      sourceWatermark: response.source_watermark,
      completedRoutes: [...response.completed_routes],
      degradedRoutes: response.degraded_routes.map((route) => ({
        route: route.route,
        reasonCode: route.reason_code,
        retryable: route.retryable,
        fallback: route.fallback,
      })),
      partial: response.partial,
      cacheUntil: response.cache_until === null ? null : Date.parse(response.cache_until),
      nextWakeAt: response.next_wake_at === null ? null : Date.parse(response.next_wake_at),
      personaRevision: String(response.persona_revision),
      personaContentHash: response.persona_content_hash,
      audit: {
        droppedCandidateIds,
        ...(filteredCandidateIds.length === 0 ? {} : { filteredCandidateIds }),
        ...(unknownProviderCategories.length === 0 ? {} : { unknownProviderCategories }),
        ...(response.trace === undefined ? {} : { providerTrace: response.trace as JsonValue }),
      },
    };
  }

  public async observe(events: readonly MemoryObserveEvent[], signal: AbortSignal): Promise<void> {
    const deliverable = events.filter((event) => {
      if (event.effectState !== "committed" && event.effectState !== "partial") return false;
      if (event.role === "tool") return event.effectApplied === true;
      if (event.role !== "assistant") return true;
      return event.content !== undefined && event.content.length > 0;
    });
    if (deliverable.length === 0) return;
    if (signal.aborted) throw signal.reason;
    await this.#deliver(
      {
        id: `observe:${deliverable
          .map((event) => event.outboxId)
          .toSorted()
          .join(",")}`,
        kind: "observe",
        payload: deliverable,
        createdAtMs: this.#nowMs(),
        attempts: 0,
        nextAttemptAtMs: this.#nowMs(),
      },
      signal,
    );
    await this.#save();
  }

  public async reportUsage(report: MemoryUsageReport, signal: AbortSignal): Promise<void> {
    if (!isSubset(report.modelVisibleBlockIds, report.hostSelectedBlockIds)) {
      throw new Error("modelVisibleBlockIds must be a subset of hostSelectedBlockIds");
    }
    if (!isSubset(report.hostSelectedBlockIds, report.returnedBlockIds)) {
      throw new Error("hostSelectedBlockIds must be a subset of returnedBlockIds");
    }
    if (signal.aborted) throw signal.reason;
    await this.#deliver(
      {
        id: `usage:${report.outboxId}`,
        kind: "usage",
        payload: report,
        createdAtMs: this.#nowMs(),
        attempts: 0,
        nextAttemptAtMs: this.#nowMs(),
      },
      signal,
    );
    await this.#save();
  }

  public async current(agentId: string, signal: AbortSignal): Promise<PersonaSnapshot> {
    const cached = this.#state.personaCache[agentId];
    if (cached !== undefined) {
      if (
        cached.state !== null &&
        cached.state.expiresAt <= this.#nowMs() &&
        stableJson(cached.state.fields) !== stableJson(cached.state.baseline)
      ) {
        const expired = {
          ...cached,
          state: { ...cached.state, fields: cached.state.baseline },
        } satisfies PersonaSnapshot;
        this.#state = {
          ...this.#state,
          personaCache: { ...this.#state.personaCache, [agentId]: expired },
        };
        await this.#save();
        return expired;
      }
      return cached;
    }
    try {
      return await this.#refreshPersona(agentId, signal);
    } catch (error) {
      if (this.#activateFallbackPersona(agentId))
        return this.#state.personaCache[agentId] as PersonaSnapshot;
      throw error;
    }
  }

  public subscribe(onInvalidated: (event: PersonaInvalidation) => void): { dispose(): void } {
    this.#subscribers.add(onInvalidated);
    return { dispose: () => this.#subscribers.delete(onInvalidated) };
  }

  public async reconcile(signal: AbortSignal = new AbortController().signal): Promise<void> {
    if (this.#context === undefined) return;
    for (const [stream, localCursor] of Object.entries(this.#state.sourceCursors)) {
      const remote = await this.#client.sourceCursor(stream, this.#context.agentId, { signal });
      if (remote.cursor_position !== null && BigInt(localCursor) > BigInt(remote.cursor_position)) {
        this.#diagnostic("cursor.remote_behind", { stream, localCursor });
      }
    }
  }

  public async flushPending(signal: AbortSignal = new AbortController().signal): Promise<void> {
    if (this.#flushing !== undefined) return this.#flushing;
    this.#flushing = this.#flushPending(signal).finally(() => {
      this.#flushing = undefined;
    });
    return this.#flushing;
  }

  async #flushPending(signal: AbortSignal): Promise<void> {
    for (const delivery of this.#state.pending) {
      if (delivery.createdAtMs < this.#nowMs() - this.#config.outboxTtlMs) {
        // Legacy pending rows remain available for reconciliation; never silently delete them.
        this.#diagnostic("outbox.expired_requires_reconciliation", { kind: delivery.kind });
        continue;
      }
      if (delivery.nextAttemptAtMs > this.#nowMs()) continue;
      try {
        await this.#deliver(delivery, signal);
        this.#state = {
          ...this.#state,
          pending: this.#state.pending.filter((item) => item.id !== delivery.id),
        };
        await this.#save();
      } catch {
        const attempts = delivery.attempts + 1;
        const updated = {
          ...delivery,
          attempts,
          nextAttemptAtMs:
            this.#nowMs() + Math.min(this.#config.retryBaseMs * 2 ** attempts, 60_000),
        } satisfies PendingDelivery;
        this.#state = {
          ...this.#state,
          pending: this.#state.pending.map((item) => (item.id === delivery.id ? updated : item)),
        };
        await this.#save();
        this.#diagnostic("outbox.delivery_failed", { kind: delivery.kind, attempts });
      }
    }
    if (
      this.#running &&
      this.#state.pending.some(
        (item) => item.createdAtMs >= this.#nowMs() - this.#config.outboxTtlMs,
      )
    )
      this.#scheduleFlush(this.#config.retryBaseMs);
  }

  async #deliver(delivery: PendingDelivery, signal: AbortSignal): Promise<void> {
    if (delivery.kind === "usage") {
      await this.#client.reportRecallUsage(
        delivery.payload.requestId,
        {
          host_cycle_id: delivery.payload.hostCycleId,
          persona_revision: Number(delivery.payload.personaRevision),
          returned_candidate_ids: delivery.payload.returnedBlockIds,
          host_selected_candidate_ids: delivery.payload.hostSelectedBlockIds,
          model_visible_candidate_ids: delivery.payload.modelVisibleBlockIds,
          reported_at: nowIso(delivery.payload.reportedAtMs),
        },
        { idempotencyKey: delivery.payload.outboxId, signal },
      );
      return;
    }
    const records: ObservationRecordInput[] = delivery.payload.map((event) => ({
      agent_id: event.agentId,
      role: event.role,
      kind: event.kind,
      idempotency_key: event.eventId,
      occurred_us: millisecondsToMicroseconds(event.occurredAtMs),
      committed_us: millisecondsToMicroseconds(event.committedAtMs),
      ...(event.spaceId === undefined ? {} : { space_id: event.spaceId }),
      ...(event.spaceGroupId === undefined ? {} : { space_group_id: event.spaceGroupId }),
      ...(event.sessionId === undefined ? {} : { session_id: event.sessionId }),
      ...(event.sourceStream === undefined ? {} : { source_stream: event.sourceStream }),
      ...(event.sourceCursor === undefined ? {} : { source_cursor: event.sourceCursor }),
      ...(event.effectState === undefined ? {} : { effect_state: event.effectState }),
      ...(event.effectApplied === undefined ? {} : { effect_applied: event.effectApplied }),
      ...(event.content === undefined ? {} : { content: event.content }),
      ...(event.structuredPayload === undefined
        ? {}
        : { structured_payload: event.structuredPayload }),
      ...(event.privacyLabels === undefined ? {} : { privacy_labels: event.privacyLabels }),
      ...(event.effectProof === undefined ? {} : { effect_proof: event.effectProof }),
      source_event_id: event.eventId,
    }));
    await this.#client.observeBatch(records, {
      idempotencyKey: delivery.id,
      signal,
      ...(this.#lease === undefined
        ? {}
        : { lease_id: this.#lease.lease_id, lease_epoch: this.#lease.lease_epoch }),
    });
    const sourceCursors = { ...this.#state.sourceCursors };
    for (const event of delivery.payload) {
      if (event.sourceStream !== undefined && event.sourceCursor !== undefined) {
        sourceCursors[event.sourceStream] = event.sourceCursor;
      }
    }
    this.#state = { ...this.#state, sourceCursors };
  }

  async #negotiate(signal: AbortSignal): Promise<void> {
    const negotiated = await this.#client.negotiate(["v1"], { signal });
    const missing = REQUIRED_CAPABILITIES.filter((name) => !negotiated.capabilities.includes(name));
    if (
      negotiated.api_version !== "v1" ||
      negotiated.schema_version < this.#config.minimumCoreSchemaVersion ||
      negotiated.schema_version > this.#config.maximumCoreSchemaVersion ||
      missing.length > 0
    ) {
      this.#healthy = false;
      this.#degradedReason = "incompatible_core";
      throw new Error("Iris Core capability negotiation failed");
    }
    this.#coreCapabilities = negotiated;
    this.#healthy = true;
    this.#degradedReason = undefined;
  }

  async #acquireLease(): Promise<void> {
    if (this.#config.activeSurfaceMode === "off" || this.#context === undefined) return;
    try {
      const lease = await this.#client.acquireSurfaceLease({
        agent_id: this.#context.agentId,
        holder_app_instance_id: this.#context.appInstanceId,
        ttl_us: this.#config.leaseTtlMs * 1000,
        priority: this.#config.leasePriority,
        allow_preempt: this.#config.allowLeasePreempt,
        reason: "bellis_adapter_start",
      });
      this.#assertActiveLease(lease);
      this.#lease = lease;
    } catch (error) {
      this.#degradedReason = "lease_unavailable";
      if (this.#config.activeSurfaceMode === "required") throw error;
    }
  }

  #scheduleLeaseHeartbeat(): void {
    if (!this.#running || this.#lease === undefined || this.#context === undefined) return;
    this.#leaseTimer = setTimeout(
      () => {
        void this.#heartbeatLease();
      },
      Math.max(100, Math.floor(this.#config.leaseTtlMs / 3)),
    );
    this.#leaseTimer.unref();
  }

  async #heartbeatLease(): Promise<void> {
    if (!this.#running || this.#lease === undefined || this.#context === undefined) return;
    try {
      const lease = await this.#client.heartbeatSurfaceLease(this.#lease.lease_id, {
        lease_epoch: this.#lease.lease_epoch,
        holder_app_instance_id: this.#context.appInstanceId,
        ttl_us: this.#config.leaseTtlMs * 1000,
      });
      this.#assertActiveLease(lease);
      this.#lease = lease;
      this.#healthy = true;
    } catch {
      this.#lease = undefined;
      this.#degradedReason = "lease_fenced";
      if (this.#config.activeSurfaceMode === "required") this.#healthy = false;
      this.#diagnostic("lease.fenced", {});
    }
    this.#scheduleLeaseHeartbeat();
  }

  #assertActiveLease(lease: LeaseView): void {
    if (
      this.#context === undefined ||
      lease.status !== "active" ||
      lease.agent_id !== this.#context.agentId ||
      lease.holder_app_instance_id !== this.#context.appInstanceId ||
      lease.expires_us <= millisecondsToMicroseconds(this.#nowMs())
    ) {
      throw new Error("Iris Core returned an invalid active-surface lease");
    }
  }

  async #loadInitialPersona(agentId: string): Promise<void> {
    try {
      await this.#refreshPersona(agentId, new AbortController().signal);
      return;
    } catch {
      const cached = this.#state.personaCache[agentId];
      if (cached !== undefined) {
        const verified = validatePersonaSnapshot({ ...cached, origin: "verified-cache" });
        this.#state = {
          ...this.#state,
          personaCache: { ...this.#state.personaCache, [agentId]: verified },
        };
        this.#degradedReason = "persona_verified_cache";
        return;
      }
      if (!this.#activateFallbackPersona(agentId)) throw new Error("persona is unavailable");
    }
  }

  async #refreshPersona(agentId: string, signal: AbortSignal): Promise<PersonaSnapshot> {
    const value = await this.#client.currentPersona(agentId, { signal });
    const snapshot = mapPersona(value, this.#nowMs(), "live");
    if (snapshot.agentId !== agentId) throw new Error("persona agent mismatch");
    this.#state = {
      ...this.#state,
      personaCache: { ...this.#state.personaCache, [agentId]: snapshot },
    };
    await this.#save();
    return snapshot;
  }

  #activateFallbackPersona(agentId: string): boolean {
    const configured = this.#config.staticPersona;
    if (configured === undefined || configured.agentId !== agentId) return false;
    const snapshot = validatePersonaSnapshot({
      ...configured,
      origin: "static-fallback",
      fetchedAt: this.#nowMs(),
    });
    this.#state = {
      ...this.#state,
      personaCache: { ...this.#state.personaCache, [agentId]: snapshot },
    };
    this.#degradedReason = "persona_static_fallback";
    void this.#save();
    return true;
  }

  #checkPersonaCoherence(agentId: string, response: RecallResponse): void {
    const cached = this.#state.personaCache[agentId];
    if (
      cached !== undefined &&
      (cached.revision !== String(response.persona_revision) ||
        cached.contentHash !== response.persona_content_hash)
    ) {
      this.#invalidatePersona({
        agentId,
        revision: String(response.persona_revision),
        ...(response.persona_content_hash.length === 0
          ? {}
          : { contentHash: response.persona_content_hash }),
        reason: "recall-mismatch",
      });
      void this.#refreshPersona(agentId, new AbortController().signal).catch(() => {
        this.#diagnostic("persona.refresh_failed", {});
      });
    }
  }

  #scheduleEventPoll(): void {
    if (!this.#running || !this.#coreCapabilities?.capabilities.includes("events.sse.v1")) return;
    this.#eventTimer = setTimeout(() => {
      void this.#pollEvents();
    }, this.#config.eventPollMs);
    this.#eventTimer.unref();
  }

  async #pollEvents(): Promise<void> {
    if (!this.#running || this.#context === undefined) return;
    try {
      const eventOptions =
        this.#state.eventCursor === undefined ? {} : { after: this.#state.eventCursor };
      const events = await this.#client.events(eventOptions);
      for (const event of events) {
        this.#state = { ...this.#state, eventCursor: event.cursor };
        if (
          event.event_type === "persona.revised.v1" ||
          event.event_type === "revision.invalidated.v1"
        ) {
          this.#invalidatePersona({
            agentId: this.#context.agentId,
            reason: event.event_type === "persona.revised.v1" ? "revised" : "invalidated",
            cursor: event.cursor,
          });
          await this.#refreshPersona(this.#context.agentId, new AbortController().signal);
        }
      }
      if (events.length > 0) await this.#save();
    } catch {
      this.#diagnostic("events.poll_failed", {});
    }
    this.#scheduleEventPoll();
  }

  #invalidatePersona(event: PersonaInvalidation): void {
    const personaCache = { ...this.#state.personaCache };
    delete personaCache[event.agentId];
    this.#state = { ...this.#state, personaCache };
    for (const subscriber of this.#subscribers) subscriber(event);
    void this.#save();
  }

  /**
   * The categories this adapter can actually emit, derived from the mapping
   * rather than hardcoded, plus anything an operator override can produce.
   * `viewer` is absent by construction — see `RESOURCE_TYPE_CATEGORY`.
   */
  #producibleCategories(): ContextCategory[] {
    const overrides = this.#config.categoryMap ?? {};
    const produced = new Set<ContextCategory>();
    for (const resourceType of CORE_RESOURCE_TYPES) {
      for (const category of CORE_CATEGORY_VOCABULARY[resourceType] ?? []) {
        const mapped = deriveContextCategory(resourceType, category, overrides);
        if (mapped !== undefined) produced.add(mapped);
      }
    }
    for (const mapped of Object.values(overrides)) produced.add(mapped);
    return [...produced].toSorted();
  }

  #scheduleFlush(delayMs: number): void {
    if (!this.#running) return;
    if (this.#flushTimer !== undefined) clearTimeout(this.#flushTimer);
    this.#flushTimer = setTimeout(() => {
      void this.flushPending();
    }, delayMs);
    this.#flushTimer.unref();
  }

  #save(): Promise<void> {
    const snapshot = structuredClone(this.#state);
    this.#saving = this.#saving.catch(() => {}).then(() => this.#store.save(snapshot));
    return this.#saving;
  }

  #nowMs(): number {
    return this.#context?.nowMs?.() ?? Date.now();
  }

  #diagnostic(event: string, fields: Readonly<Record<string, string | number | boolean>>): void {
    const jsonFields: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(fields)) jsonFields[key] = asJsonValue(value);
    this.#context?.diagnostic?.(event, jsonFields);
  }
}
