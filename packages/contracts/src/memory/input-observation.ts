import { z } from "zod";
import { MemoryPolicyStampSchema } from "./policy.js";

/** Trusted ingress mapping, evaluated by the host before durable Signal acceptance.
 * This is never accepted from a model packet or from Stage. The DB allocates all
 * event IDs, Outbox IDs and source cursors together with the accepted Signal.
 */
export const MemoryInputObservationSchema = z.strictObject({
  policy: MemoryPolicyStampSchema.optional(),
  providerId: z.string().min(1).max(128),
  agentId: z.string().min(1).max(256),
  spaceId: z.string().min(1).max(256),
  coreSessionId: z.string().min(1).max(256).optional(),
  actorExternalIdentityId: z.string().min(1).max(256),
  sourceStream: z.string().min(1).max(256),
  role: z.enum(["user", "external"]),
  content: z.string().min(1).max(65_536),
  privacyLabels: z.array(z.string().min(1).max(256)).min(1).max(32),
});
export type MemoryInputObservation = z.infer<typeof MemoryInputObservationSchema>;
