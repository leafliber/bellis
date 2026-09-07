import { z } from "zod";
import { DecimalStringSchema } from "../common/decimal-string.js";
import { UuidSchema } from "../common/ids.js";

const ScopeKey = z.string().regex(/^[a-f0-9]{64}$/);
const Generation = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const MemoryPolicyStampSchema = z.strictObject({
  scopeKey: ScopeKey,
  generation: Generation,
});
export type MemoryPolicyStamp = z.infer<typeof MemoryPolicyStampSchema>;

export const MemoryTombstoneSchema = z.strictObject({
  providerId: z.string().min(1).max(128),
  /** Provider canonical resource reference, without its revision suffix. */
  resourceRef: z.string().min(1).max(1024),
  /** null is a permanent deletion; otherwise only this and older revisions are denied. */
  throughRevision: DecimalStringSchema.nullable(),
});
export type MemoryTombstone = z.infer<typeof MemoryTombstoneSchema>;

export const MemoryPolicySnapshotSchema = z.strictObject({
  ...MemoryPolicyStampSchema.shape,
  privacyRevision: z.string().min(1).max(256),
  blocked: z.boolean(),
  historyBlocked: z.literal(true).optional(),
  tombstones: z.array(MemoryTombstoneSchema).max(4096),
});
export type MemoryPolicySnapshot = z.infer<typeof MemoryPolicySnapshotSchema>;

/** Trusted host operation. This object is never accepted from a model or Stage. */
export const MemoryPolicyChangeSchema = z.strictObject({
  scopeKey: ScopeKey,
  expectedGeneration: Generation,
  changeId: UuidSchema,
  privacyRevision: z.string().min(1).max(256),
  blocked: z.boolean(),
  reason: z.enum(["privacy", "forget", "resource-invalidated"]),
  tombstones: z.array(MemoryTombstoneSchema).max(256),
});
export type MemoryPolicyChange = z.infer<typeof MemoryPolicyChangeSchema>;

export function isMemoryResourceBlocked(
  tombstones: readonly MemoryTombstone[],
  providerId: string,
  refs: readonly string[],
  revision: string,
): boolean {
  return tombstones.some(
    (item) =>
      item.providerId === providerId &&
      refs.some((ref) => {
        if (ref !== item.resourceRef && !ref.startsWith(`${item.resourceRef}@`)) return false;
        const referencedRevision = /@([0-9]+)$/.exec(ref)?.[1] ?? revision;
        return (
          item.throughRevision === null ||
          BigInt(referencedRevision) <= BigInt(item.throughRevision)
        );
      }),
  );
}
