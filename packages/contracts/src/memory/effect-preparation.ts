import { z } from "zod";
import { MemoryInputObservationSchema } from "./input-observation.js";
import { ScenePlanSchema } from "../scene/scene-plan.js";

/** Host-only projection target. Never supplied by Stage or the model. */
export const MemoryOutputTargetSchema = MemoryInputObservationSchema.omit({
  actorExternalIdentityId: true,
  role: true,
  content: true,
});
export type MemoryOutputTarget = z.infer<typeof MemoryOutputTargetSchema>;

export const EffectPreparationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  plan: ScenePlanSchema,
  targets: z.array(MemoryOutputTargetSchema).max(8),
});
export type EffectPreparation = z.infer<typeof EffectPreparationSchema>;
