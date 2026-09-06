import { z } from "zod";

import { DecimalStringSchema } from "../common/decimal-string.js";
import { JsonValueSchema, extensibleJsonObject, type JsonValue } from "../common/json-value.js";

export type { JsonValue } from "../common/json-value.js";

export const MEMORY_CONTRACT_VERSION = 1 as const;

export const MemoryPurposeSchema = z.enum(["reply", "planning", "reflection", "tool"]);
export type MemoryPurpose = z.infer<typeof MemoryPurposeSchema>;

export const ContextCategorySchema = z.enum(["viewer", "relationship", "fact", "episode", "task"]);
export type ContextCategory = z.infer<typeof ContextCategorySchema>;

export const ContextPlacementSchema = z.enum(["working", "memory"]);
export type ContextPlacement = z.infer<typeof ContextPlacementSchema>;

export const ContextBlockSchema = extensibleJsonObject({
  id: z.string().min(1).max(256),
  revision: DecimalStringSchema,
  contentHash: z.string().min(1).max(256),
  text: z.string().max(65_536),
  category: ContextCategorySchema,
  providerCategory: z.string().min(1).max(128).optional(),
  placement: ContextPlacementSchema,
  priority: z.number().finite(),
  confidence: z.number().min(0).max(1).optional(),
  tokenEstimate: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative().optional(),
  privacyScope: z.string().min(1).max(256),
  privacyLabels: z.array(z.string().min(1).max(256)).optional(),
  conflictHint: z.enum(["conflicts", "redundant"]).optional(),
  sourceRefs: z.array(z.string().min(1).max(1024)),
});
export type ContextBlock = z.infer<typeof ContextBlockSchema>;

export const MemoryActorSchema = extensibleJsonObject({
  provider: z.string().min(1).max(128),
  externalId: z.string().min(1).max(512),
  realm: z.string().min(1).max(256).optional(),
  weight: z.number().min(0).max(1).optional(),
});
export type MemoryActor = z.infer<typeof MemoryActorSchema>;

export const MemoryQuerySchema = extensibleJsonObject({
  schemaVersion: z.literal(MEMORY_CONTRACT_VERSION),
  queryId: z.string().min(1).max(256),
  agentId: z.string().min(1).max(256),
  spaceId: z.string().min(1).max(256),
  spaceGroupId: z.string().min(1).max(256).nullable().optional(),
  sessionId: z.string().min(1).max(256).nullable().optional(),
  actors: z.array(MemoryActorSchema).min(1).max(256),
  topic: z.string().min(1),
  purpose: MemoryPurposeSchema,
  privacyScope: z.string().min(1).max(256),
  requestedPrivacyLabels: z.array(z.string().min(1).max(256)).optional(),
  categories: z.array(ContextCategorySchema).optional(),
  minimumWatermark: DecimalStringSchema.nullable().optional(),
  allowPartial: z.boolean().optional(),
  includeTrace: z.boolean().optional(),
});
export type MemoryQuery = z.infer<typeof MemoryQuerySchema>;

export const MemoryDegradationSchema = extensibleJsonObject({
  route: z.string().min(1).max(128),
  reasonCode: z.string().min(1).max(128),
  retryable: z.boolean(),
  fallback: z.string().min(1).max(256),
});
export type MemoryDegradation = z.infer<typeof MemoryDegradationSchema>;

export const ContextContributionSchema = extensibleJsonObject({
  schemaVersion: z.literal(MEMORY_CONTRACT_VERSION),
  providerId: z.string().min(1).max(128),
  requestId: z.string().min(1).max(256),
  mappingVersion: z.number().int().positive().optional(),
  priorityDerivationVersion: z.number().int().positive().optional(),
  blocks: z.array(ContextBlockSchema).max(256),
  returnedBlockIds: z.array(z.string().min(1).max(256)).optional(),
  sourceWatermark: DecimalStringSchema.optional(),
  completedRoutes: z.array(z.string().min(1).max(128)).optional(),
  degradedRoutes: z.array(MemoryDegradationSchema).optional(),
  partial: z.boolean().optional(),
  cacheUntil: z.number().int().nonnegative().nullable().optional(),
  nextWakeAt: z.number().int().nonnegative().nullable().optional(),
  personaRevision: DecimalStringSchema.optional(),
  personaContentHash: z.string().max(256).optional(),
  audit: extensibleJsonObject({
    droppedCandidateIds: z.array(z.string().min(1).max(256)),
    providerTrace: JsonValueSchema.nullable().optional(),
  }).optional(),
});
export type ContextContribution = z.infer<typeof ContextContributionSchema>;

export const MemoryProviderCapabilitiesSchema = extensibleJsonObject({
  schemaVersion: z.literal(MEMORY_CONTRACT_VERSION),
  providerVersion: z.string().min(1).max(64),
  mappingVersion: z.number().int().positive().optional(),
  healthy: z.boolean(),
  degradedReason: z.string().min(1).max(256).optional(),
  categories: z.array(ContextCategorySchema),
  placements: z.array(ContextPlacementSchema),
  observe: z.boolean(),
  usageReport: z.boolean(),
  persona: z.boolean(),
  activeSurfaceMode: z.enum(["off", "advisory", "required"]).optional(),
  coreApiVersion: z.string().min(1).max(32).optional(),
  coreSchemaVersion: z.number().int().positive().optional(),
});
export type MemoryProviderCapabilities = z.infer<typeof MemoryProviderCapabilitiesSchema>;

export const MemoryObserveEventSchema = extensibleJsonObject({
  schemaVersion: z.literal(MEMORY_CONTRACT_VERSION),
  eventId: z.string().min(1).max(256),
  outboxId: z.string().min(1).max(256),
  agentId: z.string().min(1).max(256),
  spaceId: z.string().min(1).max(256).optional(),
  spaceGroupId: z.string().min(1).max(256).optional(),
  sessionId: z.string().min(1).max(256).optional(),
  role: z.enum(["user", "assistant", "tool", "system", "external"]),
  kind: z.string().min(1).max(128),
  occurredAtMs: z.number().int().nonnegative(),
  committedAtMs: z.number().int().nonnegative(),
  sourceStream: z.string().min(1).max(256).optional(),
  sourceCursor: DecimalStringSchema.optional(),
  effectState: z.enum(["committed", "partial"]),
  effectApplied: z.boolean().optional(),
  content: z.string().optional(),
  structuredPayload: extensibleJsonObject({}).optional(),
  privacyLabels: z.array(z.string().min(1).max(256)).optional(),
  effectProof: extensibleJsonObject({}).optional(),
});
export type MemoryObserveEvent = z.infer<typeof MemoryObserveEventSchema>;

export const MemoryUsageReportSchema = extensibleJsonObject({
  schemaVersion: z.literal(MEMORY_CONTRACT_VERSION),
  requestId: z.string().min(1).max(256),
  hostCycleId: z.string().min(1).max(256),
  outboxId: z.string().min(1).max(256),
  personaRevision: DecimalStringSchema,
  returnedBlockIds: z.array(z.string().min(1).max(256)),
  hostSelectedBlockIds: z.array(z.string().min(1).max(256)),
  modelVisibleBlockIds: z.array(z.string().min(1).max(256)),
  reportedAtMs: z.number().int().nonnegative(),
});
export type MemoryUsageReport = z.infer<typeof MemoryUsageReportSchema>;

export const PersonaFieldsSchema = z.record(z.string(), JsonValueSchema);
export type PersonaFields = z.infer<typeof PersonaFieldsSchema>;

export const PersonaStateSchema = z.strictObject({
  fields: PersonaFieldsSchema,
  baseline: PersonaFieldsSchema,
  expiresAt: z.number().int().nonnegative(),
});
export type PersonaState = z.infer<typeof PersonaStateSchema>;

export const PersonaSnapshotSchema = extensibleJsonObject({
  agentId: z.string().min(1).max(256),
  revision: DecimalStringSchema,
  contentHash: z.string().min(1).max(256),
  policyMode: z.enum(["locked", "manual", "bounded_auto"]),
  core: PersonaFieldsSchema,
  traits: PersonaFieldsSchema,
  narrative: PersonaFieldsSchema,
  state: PersonaStateSchema.nullable(),
  effectiveFrom: z.number().int().nonnegative(),
  fetchedAt: z.number().int().nonnegative(),
  origin: z.enum(["live", "verified-cache", "static-fallback"]),
});
export type PersonaSnapshot = z.infer<typeof PersonaSnapshotSchema>;

export const PersonaInvalidationSchema = extensibleJsonObject({
  agentId: z.string().min(1).max(256),
  revision: DecimalStringSchema.optional(),
  contentHash: z.string().min(1).max(256).optional(),
  reason: z.enum(["revised", "invalidated", "recall-mismatch", "revoked"]),
  cursor: DecimalStringSchema.optional(),
});
export type PersonaInvalidation = z.infer<typeof PersonaInvalidationSchema>;

export interface Disposable {
  dispose(): void;
}

export interface MemoryProviderContext {
  readonly appInstanceId: string;
  readonly agentId: string;
  readonly nowMs?: () => number;
  readonly diagnostic?: (event: string, fields: Readonly<Record<string, JsonValue>>) => void;
}

export interface PersonaSourceContext extends MemoryProviderContext {}

export interface MemoryProvider {
  readonly id: string;
  capabilities(signal: AbortSignal): Promise<MemoryProviderCapabilities>;
  provideContext(
    query: MemoryQuery,
    options: { readonly tokenBudget: number; readonly deadlineMs: number },
    signal: AbortSignal,
  ): Promise<ContextContribution>;
  /** Resolve only after remote durable acceptance; host Outbox owns retry on rejection. */
  observe?(events: readonly MemoryObserveEvent[], signal: AbortSignal): Promise<void>;
  /** Same acknowledgment boundary as observe; queuing in memory is not success. */
  reportUsage?(report: MemoryUsageReport, signal: AbortSignal): Promise<void>;
  start?(ctx: MemoryProviderContext): Promise<void>;
  stop?(): Promise<void>;
}

export interface PersonaSource {
  readonly id: string;
  start?(ctx: PersonaSourceContext): Promise<void>;
  stop?(): Promise<void>;
  current(agentId: string, signal: AbortSignal): Promise<PersonaSnapshot>;
  subscribe?(onInvalidated: (event: PersonaInvalidation) => void): Disposable;
}
