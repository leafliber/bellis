import { z } from "zod";
import { DecimalStringSchema } from "../common/decimal-string.js";
import { MemoryTombstoneSchema } from "./policy.js";

/** Refs-only trusted provider notification; agentId identifies the configured host target. */
export const MemoryResourceInvalidationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  providerId: z.string().min(1).max(128),
  agentId: z.string().min(1).max(256),
  eventId: z.string().min(1).max(512),
  cursor: DecimalStringSchema,
  resources: z
    .array(MemoryTombstoneSchema.omit({ providerId: true }))
    .min(1)
    .max(256),
});
export type MemoryResourceInvalidation = z.infer<typeof MemoryResourceInvalidationSchema>;
