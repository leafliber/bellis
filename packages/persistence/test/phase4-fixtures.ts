import { createHash, randomUUID } from "node:crypto";
import { ContextManifestSchema, type ContextAdoption } from "@bellis/contracts";
import { SESSION_ID } from "./helpers.js";

export function context(cycleId: string): ContextAdoption {
  const requestId = randomUUID();
  const manifest = ContextManifestSchema.parse({
    schemaVersion: 1,
    manifestId: randomUUID(),
    sessionId: SESSION_ID,
    cycleId,
    modelRequestId: requestId,
    identityScope: "profile:one",
    privacyScope: "space:one",
    privacyRevision: "1",
    generation: 0,
    promptEpoch: "a".repeat(64),
    promptHash: "b".repeat(64),
    recordedAtMs: 1,
    persona: {
      sourceId: "iris",
      agentId: "agent",
      revision: "2",
      contentHash: "persona-hash",
      rendererVersion: 1,
    },
    budget: {
      estimator: "utf8-upper-bound-v1",
      maxInputTokens: 1000,
      estimatedInputTokens: 500,
      memoryTokens: 100,
      localTruncated: false,
    },
    providers: [
      {
        providerId: "iris",
        outcome: "ok",
        requestId,
        personaRevision: "1",
        returned: ["one", "filtered"],
        hostSelected: ["one"],
        modelVisible: ["one"],
      },
    ],
    blocks: [],
  });
  return {
    manifest,
    manifestDigest: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    usage: [
      {
        providerId: "iris",
        report: {
          schemaVersion: 1,
          requestId,
          hostCycleId: cycleId,
          outboxId: randomUUID(),
          personaRevision: "1",
          returnedBlockIds: ["one", "filtered"],
          hostSelectedBlockIds: ["one"],
          modelVisibleBlockIds: ["one"],
          reportedAtMs: 1,
        },
      },
    ],
  };
}
