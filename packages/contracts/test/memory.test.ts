import { describe, expect, it } from "vitest";

import {
  ContextBlockSchema,
  ContextContributionSchema,
  MemoryObserveEventSchema,
  MemoryProviderCapabilitiesSchema,
  MemoryQuerySchema,
  MemoryUsageReportSchema,
  PersonaSnapshotSchema,
} from "../src/memory/index.js";

const block = {
  id: "cand:0123456789abcdef",
  revision: "2",
  contentHash: "abc123",
  text: "A remembered fact",
  category: "fact",
  providerCategory: "preference",
  placement: "memory",
  priority: 1,
  tokenEstimate: 4,
  privacyScope: "space:main",
  privacyLabels: ["space:main"],
  sourceRefs: ["iris:claim:claim-1@2"],
} as const;

describe("memory plugin contract", () => {
  it("accepts the frozen query, block and contribution shapes", () => {
    expect(
      MemoryQuerySchema.safeParse({
        schemaVersion: 1,
        queryId: "query-1",
        agentId: "agent-1",
        spaceId: "space-1",
        actors: [{ provider: "chat", externalId: "viewer-1" }],
        topic: "hello",
        purpose: "reply",
        privacyScope: "space:main",
      }).success,
    ).toBe(true);
    expect(ContextBlockSchema.safeParse(block).success).toBe(true);
    expect(
      ContextContributionSchema.safeParse({
        schemaVersion: 1,
        providerId: "iris",
        requestId: "query-1",
        mappingVersion: 1,
        priorityDerivationVersion: 1,
        blocks: [block],
        returnedBlockIds: [block.id],
        sourceWatermark: "10",
        completedRoutes: ["claims"],
        degradedRoutes: [],
        partial: false,
        cacheUntil: null,
        nextWakeAt: null,
        personaRevision: "1",
        personaContentHash: "hash",
        audit: { droppedCandidateIds: [] },
      }).success,
    ).toBe(true);
  });

  it("rejects unknown host categories instead of guessing", () => {
    expect(ContextBlockSchema.safeParse({ ...block, category: "preference" }).success).toBe(false);
  });

  it("freezes capability, observe and usage envelopes", () => {
    expect(
      MemoryProviderCapabilitiesSchema.safeParse({
        schemaVersion: 1,
        providerVersion: "0.1.0",
        mappingVersion: 1,
        healthy: true,
        categories: ["fact"],
        placements: ["working", "memory"],
        observe: true,
        usageReport: true,
        persona: true,
        activeSurfaceMode: "off",
      }).success,
    ).toBe(true);
    expect(
      MemoryObserveEventSchema.safeParse({
        schemaVersion: 1,
        eventId: "event-1",
        outboxId: "outbox-1",
        agentId: "agent-1",
        role: "assistant",
        kind: "message.text",
        occurredAtMs: 1,
        committedAtMs: 2,
        effectState: "partial",
        content: "played prefix",
      }).success,
    ).toBe(true);
    expect(
      MemoryUsageReportSchema.safeParse({
        schemaVersion: 1,
        requestId: "query-1",
        hostCycleId: "cycle-1",
        outboxId: "outbox-2",
        personaRevision: "1",
        returnedBlockIds: [block.id],
        hostSelectedBlockIds: [block.id],
        modelVisibleBlockIds: [block.id],
        reportedAtMs: 3,
      }).success,
    ).toBe(true);
  });

  it("accepts bounded structured persona data without prompt text", () => {
    expect(
      PersonaSnapshotSchema.safeParse({
        agentId: "agent-1",
        revision: "3",
        contentHash: "hash-3",
        policyMode: "manual",
        core: { name: "Iris" },
        traits: { calm: true },
        narrative: {},
        state: null,
        effectiveFrom: 1,
        fetchedAt: 2,
        origin: "live",
      }).success,
    ).toBe(true);
  });
});

it("a retrieval-only provider can contribute without persona, routes or lease metadata", () => {
  const value = ContextContributionSchema.parse({
    schemaVersion: 1,
    providerId: "local",
    requestId: "query-1",
    blocks: [block],
  });
  expect(value.personaRevision).toBeUndefined();
  expect(value.audit).toBeUndefined();
  expect(
    MemoryProviderCapabilitiesSchema.safeParse({
      schemaVersion: 1,
      providerVersion: "1.0",
      healthy: true,
      categories: ["fact"],
      placements: ["memory"],
      observe: false,
      usageReport: false,
      persona: false,
    }).success,
  ).toBe(true);
});
