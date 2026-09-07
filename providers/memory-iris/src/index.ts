import {
  MemoryResourceInvalidationSchema,
  MemoryHistoryGapSchema,
  MemoryRecallRequestSchema,
} from "@bellis/contracts";
import { createHash, randomUUID } from "node:crypto";
export {
  registerIrisTools,
  type IrisToolAuthority,
  type IrisToolGrant,
  type IrisToolRegistrationOptions,
  type IrisToolOperation,
} from "./tools.js";

import {
  ContextContributionSchema,
  MemoryQuerySchema,
  MemoryObserveEventSchema,
  MemoryUsageReportSchema,
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

import { checkedIrisFetch, IrisBoundaryError } from "./http.js";
import { BoundedIrisCalls } from "./bounded-calls.js";
import { decimalToSafeInteger, safeInteger, validateObservation } from "./validation.js";
export { checkedIrisFetch, IrisBoundaryError } from "./http.js";

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
  type PersonaReadBarrier,
  parseAdapterState,
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

export const IRIS_PROVIDER_VERSION = "0.2.0";

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
  events(options?: {
    after?: string;
    afterEventId?: string;
    signal?: AbortSignal;
  }): Promise<readonly CoreEvent[]>;
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
  readonly backgroundTimeoutMs?: number;
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
  if (!parsed.success) throw new IrisBoundaryError("invalid_persona", false);
  const encodedBytes = Buffer.byteLength(
    JSON.stringify({ core: snapshot.core, traits: snapshot.traits, narrative: snapshot.narrative }),
  );
  if (encodedBytes > 65_536) throw new IrisBoundaryError("persona_too_large", false);
  // Core ADR-0008 freezes bootstrap layers as JSON strings in its hash,
  // while the public API normalizes those layers to objects.
  // This is a single pinned legacy representation, not a general hash bypass.
  const bootstrapCore = { language: "und", name_placeholder: true };
  const emptyBootstrap =
    stableJson(snapshot.core) === stableJson(bootstrapCore) &&
    [snapshot.traits, snapshot.narrative].every((layer) => Object.keys(layer).length === 0);
  const bootstrapHash = createHash("sha256")
    .update(
      stableJson({
        canonical_json_version: 1,
        content: { core: stableJson(bootstrapCore), traits: "[]", narrative: "" },
      }),
    )
    .digest("hex");
  const canonicalSource = snapshot.sourceCanonicalJson;
  let wireVerified = false;
  if (typeof canonicalSource === "string" && Buffer.byteLength(canonicalSource) <= 131_072) {
    const source = JSON.parse(canonicalSource) as {
      canonical_json_version?: number;
      content?: unknown;
    };
    wireVerified =
      source.canonical_json_version === 1 &&
      stableJson(source.content) ===
        stableJson({
          core: snapshot.core,
          traits: snapshot.traits,
          narrative: snapshot.narrative,
        }) &&
      createHash("sha256").update(canonicalSource).digest("hex") === snapshot.contentHash;
  }
  if (
    computePersonaContentHash(snapshot) !== snapshot.contentHash &&
    !(emptyBootstrap && bootstrapHash === snapshot.contentHash) &&
    !wireVerified
  ) {
    throw new IrisBoundaryError("persona_hash_mismatch", false);
  }
  return parsed.data;
}

function mapPersona(
  value: PersonaCurrentResponse,
  nowMs: number,
  origin: PersonaSnapshot["origin"],
): PersonaSnapshot {
  safeInteger(value.revision.revision, "persona revision", 1);
  safeInteger(value.revision.effective_from_us, "persona effective timestamp");
  if (value.state !== null) safeInteger(value.state.expires_us, "persona state expiry");
  const stateExpiresAt =
    value.state === null ? undefined : Math.floor(value.state.expires_us / 1000);
  const snapshot: PersonaSnapshot = {
    agentId: value.revision.agent_id,
    revision: String(value.revision.revision),
    contentHash: value.revision.content_hash,
    ...(typeof value.bellisCanonicalPersonaV1 === "string"
      ? { sourceCanonicalJson: value.bellisCanonicalPersonaV1 }
      : {}),
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
  if (value.revision.status === "revoked") throw new IrisBoundaryError("persona_revoked", false);
  if (value.revision.status !== "published")
    throw new IrisBoundaryError("persona_not_published", false);
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
      | "backgroundTimeoutMs"
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
  #store: AdapterStateStore;
  readonly #configuredStore: boolean;
  #resourceEpoch = 0;
  #historyAcknowledged = false;
  #polling: Promise<void> | undefined;
  #legacyDeliveryAbort = new AbortController();
  readonly #subscribers = new Set<(event: PersonaInvalidation) => void>();
  readonly #personaReads = new Set<string>();
  readonly #installingPersona = new Set<string>();
  readonly #calls = new BoundedIrisCalls();
  #lifetime = new AbortController();
  #authorizationAbort = new AbortController();
  #authorizationFailure: IrisBoundaryError | undefined;
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
    const clientOptions = {
      fetch: checkedIrisFetch(),
      ...(config.bearerToken === undefined ? {} : { bearerToken: config.bearerToken }),
    };
    this.#client =
      config.client ?? new AsyncIrisMemoryClient(config.baseUrl as string, clientOptions);
    this.#store = config.stateStore ?? new MemoryAdapterStateStore();
    this.#configuredStore = config.stateStore !== undefined;
    this.#config = {
      activeSurfaceMode: config.activeSurfaceMode ?? "off",
      allowLeasePreempt: config.allowLeasePreempt ?? false,
      eventPollMs: config.eventPollMs ?? 1_000,
      backgroundTimeoutMs: config.backgroundTimeoutMs ?? 4_000,
      leasePriority: config.leasePriority ?? 0,
      leaseTtlMs: config.leaseTtlMs ?? 30_000,
      maximumCoreSchemaVersion: config.maximumCoreSchemaVersion ?? 15,
      minimumCoreSchemaVersion: config.minimumCoreSchemaVersion ?? 14,
      outboxCapacity: config.outboxCapacity ?? 1_000,
      outboxTtlMs: config.outboxTtlMs ?? 86_400_000,
      retryBaseMs: config.retryBaseMs ?? 250,
      ...(config.categoryMap === undefined ? {} : { categoryMap: config.categoryMap }),
      ...(config.staticPersona === undefined ? {} : { staticPersona: config.staticPersona }),
    };
    safeInteger(this.#config.backgroundTimeoutMs, "background timeout", 1);
    if (this.#config.backgroundTimeoutMs > 30_000)
      throw new RangeError("background timeout exceeds 30000ms");
  }

  public async start(context: MemoryProviderContext): Promise<void> {
    if (this.#running) return;
    this.#authorizationFailure = undefined;
    this.#authorizationAbort = new AbortController();
    this.#legacyDeliveryAbort = new AbortController();
    this.#healthy = false;
    this.#historyAcknowledged = false;
    if (this.#lifetime.signal.aborted) this.#lifetime = new AbortController();
    this.#context = context;
    if (!this.#configuredStore && context.stateStore !== undefined) {
      const storage = context.stateStore;
      this.#store = {
        load: async () => {
          const value = await storage.load();
          return value === undefined ? undefined : parseAdapterState(value);
        },
        save: (state) => storage.save(JSON.parse(JSON.stringify(state)) as JsonValue),
      };
    }
    const saved = await this.#store.load();
    this.#state =
      saved === undefined
        ? { version: 1, sourceCursors: {}, personaCache: {}, pending: [] }
        : parseAdapterState(saved);
    if (this.#state.pending.length > this.#config.outboxCapacity) {
      throw new Error("legacy outbox exceeds configured capacity; reconciliation required");
    }
    if (this.#state.historyGap !== undefined && this.#state.historyGap.agentId !== context.agentId)
      throw new Error("history gap belongs to another agent");
    this.#running = true;
    try {
      await this.#reportHistoryGap(this.#lifetime.signal);
      this.#assertHistoryAvailable();
      await this.#drainResourceInvalidation(this.#lifetime.signal);
      await this.#negotiate(new AbortController().signal);
      await this.#checkLegacyCheckpoint(this.#lifetime.signal);
      this.#assertHistoryAvailable();
      await this.#acquireLease();
      await this.#loadInitialPersona(context.agentId);
      await this.reconcile();
      this.#healthy = this.#config.activeSurfaceMode !== "required" || this.#lease !== undefined;
    } catch (error) {
      this.#healthy = false;
      this.#degradedReason =
        this.#state.historyGap === undefined ? "startup_unavailable" : "history_unavailable";
      if (
        this.#state.historyGap !== undefined ||
        this.#state.pendingResourceInvalidation !== undefined ||
        !this.#allowsOfflineFallback(error) ||
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
    this.#lifetime.abort(new Error("iris_provider_stopped"));
    if (this.#eventTimer !== undefined) clearTimeout(this.#eventTimer);
    if (this.#leaseTimer !== undefined) clearTimeout(this.#leaseTimer);
    if (this.#flushTimer !== undefined) clearTimeout(this.#flushTimer);
    await this.#polling;
    await this.#flushing?.catch(() => {});
    if (this.#lease !== undefined && this.#context !== undefined) {
      try {
        const lease = this.#lease;
        const context = this.#context;
        await this.#calls.run(
          "lease-release",
          new AbortController().signal,
          this.#config.backgroundTimeoutMs,
          (signal) =>
            this.#client.releaseSurfaceLease(
              lease.lease_id,
              {
                lease_epoch: lease.lease_epoch,
                holder_app_instance_id: context.appInstanceId,
                reason: "adapter_stop",
              },
              { signal },
            ),
        );
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
    MemoryQuerySchema.parse(query);
    this.#assertHistoryAvailable();
    if (this.#state.pendingResourceInvalidation !== undefined)
      throw new IrisBoundaryError("resource_invalidation_pending", true);
    const resourceEpoch = this.#resourceEpoch;
    safeInteger(options.tokenBudget, "token budget");
    safeInteger(options.deadlineMs, "deadline", 1);
    signal.throwIfAborted();
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
    const preparedRequest = MemoryRecallRequestSchema.parse({
      schemaVersion: 1,
      attemptId: randomUUID(),
      requestId: query.queryId,
      agentId: query.agentId,
      spaceId: query.spaceId,
      body: request,
    });
    const record = this.#context?.recordRecallRequest;
    if (record !== undefined) {
      await this.#call("host-recall-request", combined, (requestSignal) =>
        record(preparedRequest, requestSignal),
      );
      combined.throwIfAborted();
      this.#assertHistoryAvailable();
      if (
        resourceEpoch !== this.#resourceEpoch ||
        this.#state.pendingResourceInvalidation !== undefined
      )
        throw new IrisBoundaryError("resource_invalidation_pending", true);
    }
    const response = await this.#call("recall", combined, (requestSignal) =>
      this.#client.recall(preparedRequest.body as unknown as RecallRequest, {
        signal: requestSignal,
      }),
    );
    combined.throwIfAborted();
    this.#assertHistoryAvailable();
    if (
      resourceEpoch !== this.#resourceEpoch ||
      this.#state.pendingResourceInvalidation !== undefined
    )
      throw new IrisBoundaryError("resource_invalidation_pending", true);
    if (response.request_id !== query.queryId) throw new Error("Recall request identity mismatch");
    safeInteger(response.persona_revision, "Recall persona revision");
    if (response.candidates.length > 256) throw new Error("Recall candidate limit exceeded");
    if (
      new Set(response.candidates.map((candidate) => candidate.candidate_id)).size !==
      response.candidates.length
    ) {
      throw new Error("duplicate Recall candidate identity");
    }
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
    const contribution: IrisContextContribution = {
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
        sourceHashScheme: "iris-canonical-v1",
        sourceHashVerification: "passthrough",
        candidates: response.candidates.map((candidate) => ({
          id: candidate.candidate_id,
          providerCategory: candidate.category,
          resourceRef: candidate.resource_ref,
          scope: candidate.scope,
          ...(candidate.subject_entity_id == null
            ? {}
            : { subjectEntityId: candidate.subject_entity_id }),
          scores: candidate.scores,
          finalScore: candidate.final_score,
        })) as JsonValue,
        ...(filteredCandidateIds.length === 0 ? {} : { filteredCandidateIds }),
        ...(unknownProviderCategories.length === 0 ? {} : { unknownProviderCategories }),
        ...(response.trace === undefined ? {} : { providerTrace: response.trace as JsonValue }),
      },
    };
    ContextContributionSchema.parse(contribution);
    return contribution;
  }

  public async observe(events: readonly MemoryObserveEvent[], signal: AbortSignal): Promise<void> {
    this.#assertHistoryAvailable();
    if (events.length > 100) throw new IrisBoundaryError("observe_batch_limit", false);
    if (new Set(events.map((event) => event.eventId)).size !== events.length)
      throw new IrisBoundaryError("observe_duplicate_event", false);
    const deliverable = events.filter((event) => {
      if (event.effectState !== "committed" && event.effectState !== "partial") return false;
      if (event.role === "tool") return event.effectApplied === true;
      if (event.role !== "assistant") return true;
      return event.content !== undefined && event.content.length > 0;
    });
    if (deliverable.length === 0) return;
    for (const event of deliverable) {
      MemoryObserveEventSchema.parse(event);
      validateObservation(event);
    }
    if (signal.aborted) throw signal.reason;
    await this.#deliver(
      {
        id: `observe:${createHash("sha256")
          .update(JSON.stringify(deliverable.map((event) => event.outboxId)))
          .digest("hex")}`,
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
    this.#assertHistoryAvailable();
    MemoryUsageReportSchema.parse(report);
    decimalToSafeInteger(report.personaRevision, "Usage persona revision");
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
    signal = AbortSignal.any([signal, this.#lifetime.signal]);
    signal.throwIfAborted();
    await this.#saving;
    signal.throwIfAborted();
    this.#assertHistoryAvailable();
    if (this.#installingPersona.has(agentId))
      throw new IrisBoundaryError("persona_read_busy", true);
    const cached =
      this.#state.personaBarriers?.[agentId] === undefined
        ? this.#state.personaCache[agentId]
        : undefined;
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
        this.#assertHistoryAvailable();
        return expired;
      }
      return cached;
    }
    try {
      return await this.#refreshPersona(agentId, signal);
    } catch (error) {
      if (this.#allowsOfflineFallback(error) && this.#activateFallbackPersona(agentId))
        return this.#state.personaCache[agentId] as PersonaSnapshot;
      throw error;
    }
  }

  public subscribe(onInvalidated: (event: PersonaInvalidation) => void): { dispose(): void } {
    this.#subscribers.add(onInvalidated);
    return { dispose: () => this.#subscribers.delete(onInvalidated) };
  }

  public async reconcile(signal: AbortSignal = new AbortController().signal): Promise<void> {
    this.#assertHistoryAvailable();
    if (this.#context === undefined) return;
    for (const [stream, localCursor] of Object.entries(this.#state.sourceCursors)) {
      const agentId = this.#context.agentId;
      const remote = await this.#call("source-cursor", signal, (requestSignal) =>
        this.#client.sourceCursor(stream, agentId, { signal: requestSignal }),
      );
      if (remote.cursor_position !== null)
        safeInteger(remote.cursor_position, "remote source cursor");
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
    signal = AbortSignal.any([signal, this.#legacyDeliveryAbort.signal]);
    if (
      this.#state.pendingResourceInvalidation !== undefined ||
      this.#state.legacyInvalidated === true ||
      this.#state.historyGap !== undefined
    )
      return;
    for (const delivery of this.#state.pending) {
      if (signal.aborted) return;
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
        if (signal.aborted) return;
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
    this.#assertHistoryAvailable();
    if (delivery.kind === "usage") {
      await this.#call("delivery", signal, (requestSignal) =>
        this.#client.reportRecallUsage(
          delivery.payload.requestId,
          {
            host_cycle_id: delivery.payload.hostCycleId,
            persona_revision: decimalToSafeInteger(
              delivery.payload.personaRevision,
              "Usage persona revision",
            ),
            returned_candidate_ids: delivery.payload.returnedBlockIds,
            host_selected_candidate_ids: delivery.payload.hostSelectedBlockIds,
            model_visible_candidate_ids: delivery.payload.modelVisibleBlockIds,
            reported_at: nowIso(delivery.payload.reportedAtMs),
          },
          { idempotencyKey: delivery.payload.outboxId, signal: requestSignal },
        ),
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
      ...(event.actorExternalIdentityId === undefined
        ? {}
        : { actor_external_identity_id: event.actorExternalIdentityId }),
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
    const ack = await this.#call("delivery", signal, (requestSignal) =>
      this.#client.observeBatch(records, {
        idempotencyKey: delivery.id,
        signal: requestSignal,
        ...(this.#lease === undefined
          ? {}
          : { lease_id: this.#lease.lease_id, lease_epoch: this.#lease.lease_epoch }),
      }),
    );
    const result = ack as {
      accepted_observation_ids?: unknown;
      duplicate_observation_ids?: unknown;
      outbox_enqueued?: unknown;
    } | null;
    const accepted = result?.accepted_observation_ids;
    const duplicates = result?.duplicate_observation_ids;
    if (
      !Array.isArray(accepted) ||
      !Array.isArray(duplicates) ||
      ![...accepted, ...duplicates].every(
        (id: unknown) => typeof id === "string" && id.length > 0 && id.length <= 256,
      ) ||
      accepted.length + duplicates.length !== records.length ||
      new Set([...accepted, ...duplicates]).size !== records.length ||
      !Number.isSafeInteger(result?.outbox_enqueued) ||
      Number(result?.outbox_enqueued) < 0
    ) {
      throw new IrisBoundaryError("observe_ack_invalid", false);
    }
    const sourceCursors = { ...this.#state.sourceCursors };
    for (const event of delivery.payload) {
      if (event.sourceStream !== undefined && event.sourceCursor !== undefined) {
        const previous = sourceCursors[event.sourceStream];
        if (previous === undefined || BigInt(event.sourceCursor) > BigInt(previous)) {
          sourceCursors[event.sourceStream] = event.sourceCursor;
        }
      }
    }
    this.#state = { ...this.#state, sourceCursors };
  }

  async #negotiate(signal: AbortSignal): Promise<void> {
    const negotiated = await this.#call("negotiate", signal, (requestSignal) =>
      this.#client.negotiate(["v1"], { signal: requestSignal }),
    );
    const missing = REQUIRED_CAPABILITIES.filter((name) => !negotiated.capabilities.includes(name));
    if (
      negotiated.api_version !== "v1" ||
      negotiated.schema_version < this.#config.minimumCoreSchemaVersion ||
      negotiated.schema_version > this.#config.maximumCoreSchemaVersion ||
      missing.length > 0
    ) {
      this.#healthy = false;
      this.#degradedReason = "incompatible_core";
      throw new IrisBoundaryError("incompatible_core", false);
    }
    this.#coreCapabilities = negotiated;
    this.#healthy = true;
    this.#degradedReason = undefined;
  }

  async #acquireLease(): Promise<void> {
    if (this.#config.activeSurfaceMode === "off" || this.#context === undefined) return;
    const context = this.#context;
    try {
      const lease = await this.#call("lease-acquire", this.#lifetime.signal, (signal) =>
        this.#client.acquireSurfaceLease(
          {
            agent_id: context.agentId,
            holder_app_instance_id: context.appInstanceId,
            ttl_us: this.#config.leaseTtlMs * 1000,
            priority: this.#config.leasePriority,
            allow_preempt: this.#config.allowLeasePreempt,
            reason: "bellis_adapter_start",
          },
          { signal },
        ),
      );
      this.#assertActiveLease(lease);
      this.#lease = lease;
    } catch (error) {
      this.#degradedReason = "lease_unavailable";
      if (this.#config.activeSurfaceMode === "required") throw error;
    }
  }

  #scheduleLeaseHeartbeat(): void {
    if (this.#authorizationFailure !== undefined) return;
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
    const lifetime = this.#lifetime;
    const previous = this.#lease;
    const context = this.#context;
    try {
      const lease = await this.#call("lease-heartbeat", lifetime.signal, (signal) =>
        this.#client.heartbeatSurfaceLease(
          previous.lease_id,
          {
            lease_epoch: previous.lease_epoch,
            holder_app_instance_id: context.appInstanceId,
            ttl_us: this.#config.leaseTtlMs * 1000,
          },
          { signal },
        ),
      );
      this.#assertActiveLease(lease);
      this.#lease = lease;
      this.#healthy = true;
    } catch {
      if (lifetime !== this.#lifetime || lifetime.signal.aborted) return;
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
    } catch (error) {
      if (
        !this.#allowsOfflineFallback(error) ||
        this.#state.personaBarriers?.[agentId] !== undefined
      )
        throw error;
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
      if (!this.#activateFallbackPersona(agentId)) throw error;
    }
  }

  async #refreshPersona(agentId: string, signal: AbortSignal): Promise<PersonaSnapshot> {
    this.#assertHistoryAvailable();
    signal = AbortSignal.any([signal, this.#lifetime.signal]);
    if (this.#personaReads.has(agentId)) throw new IrisBoundaryError("persona_read_busy", true);
    this.#personaReads.add(agentId);
    const barrier = this.#state.personaBarriers?.[agentId];
    const previous = this.#state.personaCache[agentId];
    let rejectedRevision: string | undefined;
    let revoked = false;
    try {
      // An invalidation is durable before any read can resolve its barrier.
      await this.#saving;
      signal.throwIfAborted();
      const value = await this.#call("persona", signal, (requestSignal) =>
        this.#client.currentPersona(agentId, { signal: requestSignal }),
      );
      signal.throwIfAborted();
      this.#assertHistoryAvailable();
      if (barrier !== this.#state.personaBarriers?.[agentId])
        throw new IrisBoundaryError("persona_read_invalidated", true);
      if (value.revision.status !== "published") {
        safeInteger(value.revision.revision, "unpublished persona revision", 1);
        rejectedRevision = (BigInt(value.revision.revision) + 1n).toString();
        revoked = value.revision.status === "revoked";
      }
      const snapshot = mapPersona(value, this.#nowMs(), "live");
      if (snapshot.agentId !== agentId)
        throw new IrisBoundaryError("persona_agent_mismatch", false);
      if (
        (barrier !== undefined && BigInt(snapshot.revision) < BigInt(barrier.minimumRevision)) ||
        (barrier?.verifiedRevision === snapshot.revision &&
          barrier.verifiedContentHash !== snapshot.contentHash) ||
        (previous !== undefined &&
          (BigInt(snapshot.revision) < BigInt(previous.revision) ||
            (snapshot.revision === previous.revision &&
              snapshot.contentHash !== previous.contentHash)))
      )
        throw new IrisBoundaryError("persona_revision_conflict", false);
      const personaBarriers = { ...this.#state.personaBarriers };
      delete personaBarriers[agentId];
      this.#installingPersona.add(agentId);
      this.#state = {
        ...this.#state,
        personaBarriers,
        personaCache: { ...this.#state.personaCache, [agentId]: snapshot },
      };
      await this.#save();
      // Invalidation during durable cache installation also wins.
      signal.throwIfAborted();
      this.#assertHistoryAvailable();
      if (this.#state.personaBarriers?.[agentId] !== undefined)
        throw new IrisBoundaryError("persona_read_invalidated", true);
      return snapshot;
    } catch (error) {
      if (!signal.aborted && !this.#allowsOfflineFallback(error)) {
        await this.#invalidatePersona({
          agentId,
          reason: revoked ? "revoked" : "invalidated",
          ...(rejectedRevision === undefined ? {} : { revision: rejectedRevision }),
        });
      }
      throw error;
    } finally {
      this.#installingPersona.delete(agentId);
      this.#personaReads.delete(agentId);
    }
  }

  #activateFallbackPersona(agentId: string): boolean {
    if (this.#state.historyGap !== undefined) return false;
    if (this.#state.personaBarriers?.[agentId] !== undefined) return false;
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
    void this.#save().catch(() => this.#diagnostic("persona.persist_failed", {}));
    return true;
  }

  #allowsOfflineFallback(error: unknown): boolean {
    return (
      (error instanceof IrisBoundaryError && error.retryable) ||
      (error instanceof TypeError && error.message === "fetch failed")
    );
  }

  #checkPersonaCoherence(agentId: string, response: RecallResponse): void {
    const cached = this.#state.personaCache[agentId];
    const barrier = this.#state.personaBarriers?.[agentId];
    if (
      (cached !== undefined &&
        (cached.revision !== String(response.persona_revision) ||
          cached.contentHash !== response.persona_content_hash)) ||
      (barrier !== undefined && BigInt(response.persona_revision) > BigInt(barrier.minimumRevision))
    ) {
      const persisted = this.#invalidatePersona({
        agentId,
        revision: String(response.persona_revision),
        ...(response.persona_content_hash.length === 0
          ? {}
          : { contentHash: response.persona_content_hash }),
        reason: "recall-mismatch",
      });
      void persisted
        .then(() => this.#refreshPersona(agentId, new AbortController().signal))
        .catch(() => {
          this.#diagnostic("persona.refresh_failed", {});
        });
    }
  }

  async #drainResourceInvalidation(signal: AbortSignal): Promise<void> {
    const event = this.#state.pendingResourceInvalidation;
    if (event === undefined) return;
    await this.#save();
    const invalidate = this.#context?.invalidateResources;
    if (invalidate === undefined)
      throw new IrisBoundaryError("resource_invalidation_unhandled", false);
    await this.#call("host-resource-invalidation", signal, (inner) => invalidate(event, inner));
    signal.throwIfAborted();
    const { pendingResourceInvalidation: _pending, ...rest } = this.#state;
    this.#state = rest;
    try {
      await this.#save();
    } catch (error) {
      this.#state = { ...this.#state, pendingResourceInvalidation: event };
      throw error;
    }
  }

  async #invalidateResources(event: CoreEvent, signal: AbortSignal): Promise<void> {
    const refs = event.resource_refs.filter((ref) => ref.resource_type !== "persona_revision");
    if (refs.length === 0) return;
    const resources = new Map<string, { resourceRef: string; throughRevision: string | null }>();
    for (const ref of refs) {
      if (
        typeof ref.resource_type !== "string" ||
        !/^[a-z][a-z0-9_]{0,63}$/.test(ref.resource_type) ||
        typeof ref.resource_id !== "string" ||
        !ref.resource_id.length ||
        ref.resource_id.length > 512
      )
        throw new IrisBoundaryError("invalid_resource_event", false);
      const resourceRef = `iris:${encodeURIComponent(ref.resource_type)}:${encodeURIComponent(ref.resource_id)}`;
      if (ref.revision != null && typeof ref.revision !== "number")
        throw new IrisBoundaryError("invalid_resource_event", false);
      const throughRevision =
        ref.revision == null
          ? null
          : String(safeInteger(ref.revision, "event resource revision", 1));
      const previous = resources.get(resourceRef);
      resources.set(resourceRef, {
        resourceRef,
        throughRevision:
          previous?.throughRevision === null || throughRevision === null
            ? null
            : previous !== undefined && BigInt(previous.throughRevision!) > BigInt(throughRevision)
              ? previous.throughRevision
              : throughRevision,
      });
    }
    const pending = MemoryResourceInvalidationSchema.parse({
      schemaVersion: 1,
      providerId: this.id,
      agentId: this.#context!.agentId,
      eventId: event.event_id,
      cursor: event.cursor,
      resources: [...resources.values()].toSorted((a, b) =>
        a.resourceRef < b.resourceRef ? -1 : a.resourceRef > b.resourceRef ? 1 : 0,
      ),
    });
    if (Buffer.byteLength(JSON.stringify(pending)) > 65_536)
      throw new IrisBoundaryError("invalid_resource_event", false);
    this.#resourceEpoch++;
    this.#legacyDeliveryAbort.abort(new Error("legacy_delivery_invalidated"));
    this.#state = {
      ...this.#state,
      pendingResourceInvalidation: pending,
      ...(this.#state.pending.length ? { legacyInvalidated: true } : {}),
    };
    await this.#drainResourceInvalidation(signal);
  }

  #assertHistoryAvailable(): void {
    if (this.#authorizationFailure !== undefined) throw this.#authorizationFailure;
    if (this.#state.historyGap !== undefined)
      throw new IrisBoundaryError("history_unavailable", true, 410);
  }

  async #beginHistoryGap(
    reason: "history_unavailable" | "checkpoint_missing",
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    if (this.#state.historyGap === undefined) {
      const checkpoint = {
        schemaVersion: 1 as const,
        providerId: this.id,
        agentId: this.#context!.agentId,
        cursor: this.#state.eventCursor ?? "0",
        ...(this.#state.eventId === undefined ? {} : { eventId: this.#state.eventId }),
        reason,
      };
      const gap = MemoryHistoryGapSchema.parse({
        ...checkpoint,
        gapId: createHash("sha256")
          .update(stableJson([this.#context!.appInstanceId, checkpoint]))
          .digest("hex"),
      });
      this.#state = { ...this.#state, historyGap: gap };
      this.#resourceEpoch++;
      this.#legacyDeliveryAbort.abort(new Error("history_unavailable"));
      this.#healthy = false;
      this.#degradedReason = "history_unavailable";
    }
    await this.#reportHistoryGap(signal);
  }

  async #reportHistoryGap(signal: AbortSignal): Promise<void> {
    const gap = this.#state.historyGap;
    if (gap === undefined || this.#historyAcknowledged) return;
    this.#healthy = false;
    this.#degradedReason = "history_unavailable";
    // Both durable participants are attempted, even if one fails. Calling the
    // host immediately installs its read barrier while the adapter save runs.
    const saved = this.#save();
    const notified = this.#call("host-history-gap", signal, async (inner) => {
      const notify = this.#context?.historyUnavailable;
      if (notify === undefined) throw new IrisBoundaryError("history_gap_unhandled", false);
      await notify(gap, inner);
    });
    const results = await Promise.allSettled([saved, notified]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
    signal.throwIfAborted();
    this.#historyAcknowledged = true;
  }

  async #checkLegacyCheckpoint(signal: AbortSignal): Promise<void> {
    if (
      this.#coreCapabilities?.capabilities.includes("events.checkpoint.v1") &&
      this.#state.eventCursor !== undefined &&
      this.#state.eventCursor !== "0" &&
      this.#state.eventId === undefined
    )
      await this.#beginHistoryGap("checkpoint_missing", signal);
  }

  async #readEvents(signal: AbortSignal): Promise<readonly CoreEvent[]> {
    if (!this.#coreCapabilities?.capabilities.includes("events.sse.v1")) return [];
    try {
      return await this.#call("events", signal, (inner) =>
        this.#client.events({
          ...(this.#state.eventCursor === undefined ? {} : { after: this.#state.eventCursor }),
          ...(this.#coreCapabilities?.capabilities.includes("events.checkpoint.v1") &&
          this.#state.eventId !== undefined
            ? { afterEventId: this.#state.eventId }
            : {}),
          signal: inner,
        }),
      );
    } catch (error) {
      if (
        !(error instanceof IrisBoundaryError) ||
        error.code !== "history_unavailable" ||
        error.status !== 410
      )
        throw error;
      await this.#beginHistoryGap("history_unavailable", signal);
      return [];
    }
  }

  #scheduleEventPoll(): void {
    if (!this.#running || this.#historyAcknowledged || this.#authorizationFailure !== undefined)
      return;
    this.#eventTimer = setTimeout(() => {
      this.#polling = this.#pollEvents().finally(() => {
        this.#polling = undefined;
      });
    }, this.#config.eventPollMs);
    this.#eventTimer.unref();
  }

  async #pollEvents(): Promise<void> {
    if (!this.#running || this.#context === undefined) return;
    const lifetime = this.#lifetime;
    try {
      await this.#drainResourceInvalidation(lifetime.signal);
      await this.#reportHistoryGap(lifetime.signal);
      if (this.#state.historyGap !== undefined) return;
      await this.#checkLegacyCheckpoint(lifetime.signal);
      if (this.#state.historyGap !== undefined) return;
      const events = await this.#readEvents(lifetime.signal);
      if (this.#state.historyGap !== undefined) return;
      let refreshed = false;
      for (const event of events) {
        lifetime.signal.throwIfAborted();
        if (
          typeof event.cursor !== "string" ||
          !/^[1-9][0-9]{0,18}$/.test(event.cursor) ||
          BigInt(event.cursor) > 9223372036854775807n ||
          typeof event.event_id !== "string" ||
          !/^[!-~]{1,512}$/.test(event.event_id)
        )
          throw new IrisBoundaryError("invalid_event_checkpoint", false);
        if (event.event_type === "revision.invalidated.v1")
          await this.#invalidateResources(event, lifetime.signal);
        if (
          event.event_type === "persona.revised.v1" ||
          (event.event_type === "revision.invalidated.v1" &&
            event.resource_refs.some((ref) => ref.resource_type === "persona_revision"))
        ) {
          const revisions =
            event.event_type === "persona.revised.v1"
              ? event.resource_refs
                  .filter((ref) => ref.resource_type === "persona_revision")
                  .map((ref) => {
                    if (typeof ref.revision !== "number")
                      throw new Error("invalid event persona revision");
                    return safeInteger(ref.revision, "event persona revision", 1);
                  })
              : [];
          await this.#invalidatePersona({
            agentId: this.#context.agentId,
            reason: event.event_type === "persona.revised.v1" ? "revised" : "invalidated",
            cursor: event.cursor,
            ...(revisions.length === 0 ? {} : { revision: String(Math.max(...revisions)) }),
          });
          await this.#refreshPersona(this.#context.agentId, lifetime.signal);
          refreshed = true;
        }
        // A failed refresh must leave this event available for the next poll.
        const previousCursor = this.#state.eventCursor;
        const previousId = this.#state.eventId;
        this.#state = { ...this.#state, eventCursor: event.cursor, eventId: event.event_id };
        try {
          await this.#save();
        } catch (error) {
          // Keep the pair together in memory as well as storage. Replaying an
          // already acknowledged invalidation is idempotent at the host.
          const { eventCursor: _cursor, eventId: _id, ...rest } = this.#state;
          this.#state = {
            ...rest,
            ...(previousCursor === undefined ? {} : { eventCursor: previousCursor }),
            ...(previousId === undefined ? {} : { eventId: previousId }),
          };
          throw error;
        }
      }
      if (events.length > 0) await this.#save();
      // Revalidate transient state and cover finite-stream gaps or a Core without
      // event support. This bounded read runs outside the foreground Cycle.
      if (!refreshed) await this.#refreshPersona(this.#context.agentId, lifetime.signal);
    } catch {
      this.#diagnostic("events.poll_failed", {});
    } finally {
      if (lifetime === this.#lifetime) this.#scheduleEventPoll();
    }
  }

  #invalidatePersona(event: PersonaInvalidation): Promise<void> {
    const personaCache = { ...this.#state.personaCache };
    const previous = personaCache[event.agentId];
    const existing = this.#state.personaBarriers?.[event.agentId];
    const minimumRevision = [
      BigInt(existing?.minimumRevision ?? "1"),
      BigInt(event.revision ?? "1"),
      BigInt(previous?.revision ?? "0") + (event.reason === "revoked" ? 1n : 0n),
    ]
      .reduce((highest, revision) => (revision > highest ? revision : highest))
      .toString();
    const barrier: PersonaReadBarrier = {
      minimumRevision,
      reason: existing?.reason === "revoked" ? "revoked" : event.reason,
      ...(previous === undefined
        ? existing?.verifiedRevision === undefined
          ? {}
          : {
              verifiedRevision: existing.verifiedRevision,
              verifiedContentHash: existing.verifiedContentHash,
            }
        : { verifiedRevision: previous.revision, verifiedContentHash: previous.contentHash }),
      ...(event.cursor === undefined
        ? existing?.cursor === undefined
          ? {}
          : { cursor: existing.cursor }
        : { cursor: event.cursor }),
    };
    delete personaCache[event.agentId];
    this.#state = {
      ...this.#state,
      personaCache,
      personaBarriers: { ...this.#state.personaBarriers, [event.agentId]: barrier },
    };
    const persisted = this.#save();
    for (const subscriber of this.#subscribers) subscriber(event);
    return persisted;
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
    return [...produced].toSorted();
  }

  #scheduleFlush(delayMs: number): void {
    if (!this.#running || this.#authorizationFailure !== undefined) return;
    if (this.#flushTimer !== undefined) clearTimeout(this.#flushTimer);
    this.#flushTimer = setTimeout(() => {
      void this.flushPending();
    }, delayMs);
    this.#flushTimer.unref();
  }

  #save(): Promise<void> {
    const snapshot = structuredClone(this.#state);
    const store = this.#store;
    this.#saving = this.#saving.catch(() => {}).then(() => store.save(snapshot));
    return this.#saving;
  }

  async #call<T>(
    key: string,
    parent: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.#authorizationFailure !== undefined) throw this.#authorizationFailure;
    const lifetime = this.#lifetime;
    try {
      return await this.#calls.run(
        key,
        AbortSignal.any([parent, lifetime.signal, this.#authorizationAbort.signal]),
        this.#config.backgroundTimeoutMs,
        operation,
      );
    } catch (error) {
      if (
        this.#context !== undefined &&
        lifetime === this.#lifetime &&
        !lifetime.signal.aborted &&
        this.#authorizationFailure === undefined &&
        error instanceof IrisBoundaryError &&
        (error.status === 401 ||
          error.status === 403 ||
          (error.status === 404 && error.code === "access_denied"))
      ) {
        this.#authorizationFailure = new IrisBoundaryError(
          "authorization_unavailable",
          false,
          error.status,
        );
        this.#healthy = false;
        this.#degradedReason = "authorization_unavailable";
        this.#authorizationAbort.abort(this.#authorizationFailure);
        this.#legacyDeliveryAbort.abort(this.#authorizationFailure);
        clearTimeout(this.#eventTimer);
        clearTimeout(this.#leaseTimer);
        clearTimeout(this.#flushTimer);
        await this.#invalidatePersona({ agentId: this.#context.agentId, reason: "invalidated" });
      }
      throw error;
    }
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

export {
  IrisToolBoundary,
  IrisToolOutcomeUnknown,
  freezeIrisToolRequest,
  type IrisToolRequest,
} from "./tool-boundary.js";

export { IrisRecallVerifier, type IrisRecallVerifierConfig } from "./recall-verifier.js";
