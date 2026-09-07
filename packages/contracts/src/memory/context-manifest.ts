import { LocalInputVisibilitySchema } from "./local-input-visibility.js";
import { z } from "zod";
import { DecimalStringSchema } from "../common/decimal-string.js";
import { UuidSchema } from "../common/ids.js";
import { MemoryUsageReportSchema } from "./index.js";
import { MemoryPolicyStampSchema } from "./policy.js";

const Id = z.string().min(1).max(256);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);

/** Digest-only audit: this record cannot reconstruct the full private prompt. */
export const ContextManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  manifestId: UuidSchema,
  sessionId: UuidSchema,
  cycleId: UuidSchema,
  modelRequestId: Id,
  identityScope: Id,
  privacyScope: Id,
  privacyRevision: Id,
  policy: MemoryPolicyStampSchema.optional(),
  /** Pre-budget privacy decisions; no excluded source text. */
  localInputs: LocalInputVisibilitySchema.extend({ topicsSuppressed: z.boolean() }).optional(),
  generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  promptEpoch: Hash,
  promptHash: Hash,
  recordedAtMs: z.number().int().nonnegative(),
  persona: z.strictObject({
    sourceId: Id,
    agentId: Id,
    revision: DecimalStringSchema,
    contentHash: Id,
    rendererVersion: z.literal(1),
  }),
  budget: z.strictObject({
    estimator: z.literal("utf8-upper-bound-v1"),
    maxInputTokens: z.number().int().positive(),
    estimatedInputTokens: z.number().int().nonnegative(),
    memoryTokens: z.number().int().nonnegative(),
    localTruncated: z.boolean(),
  }),
  providers: z
    .array(
      z.strictObject({
        providerId: Id,
        outcome: z.enum(["ok", "timeout", "failed", "no_actor", "busy"]),
        requestId: Id.optional(),
        personaRevision: DecimalStringSchema.optional(),
        returned: z.array(Id).max(256),
        hostSelected: z.array(Id).max(256),
        modelVisible: z.array(Id).max(256),
      }),
    )
    .max(8),
  blocks: z
    .array(
      z.strictObject({
        providerId: Id,
        blockId: Id,
        revision: DecimalStringSchema,
        contentHash: Id,
        textHash: Hash,
        normalizedHash: Hash,
        modelTextHash: Hash.optional(),
        sourceHashScheme: z.enum(["iris-canonical-v1", "sha256-text-v1"]),
        sourceHashVerification: z.enum(["passthrough", "verified", "failed"]),
        privacyScope: Id,
        sourceRefs: z.array(z.string().max(1024)).max(64),
        result: z.enum([
          "included",
          "privacy",
          "expired",
          "duplicate",
          "budget",
          "invalid",
          "tombstone",
        ]),
      }),
    )
    .max(2048),
});
export type ContextManifest = z.infer<typeof ContextManifestSchema>;

export const ContextAdoptionSchema = z.strictObject({
  manifest: ContextManifestSchema,
  manifestDigest: Hash,
  usage: z
    .array(
      z.strictObject({
        providerId: Id,
        report: MemoryUsageReportSchema,
      }),
    )
    .max(8),
});
export type ContextAdoption = z.infer<typeof ContextAdoptionSchema>;
