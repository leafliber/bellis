import { z } from "zod";
import { UuidSchema } from "../common/ids.js";
import { DecimalStringSchema } from "../common/decimal-string.js";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const OffsetSchema = z.number().int().min(0).max(65_536);
const SamplesSchema = z.number().int().min(0).max(28_800_000); // 10 minutes @48kHz.

/** Text ranges are UTF-16 offsets into the frozen plan speech, never timestamps. */
export const EffectSegmentSchema = z.strictObject({
  segmentId: UuidSchema,
  cueId: UuidSchema,
  lane: z.enum(["audio", "subtitle"]),
  start: OffsetSchema,
  end: OffsetSchema,
  textHash: HashSchema,
});
export type EffectSegment = z.infer<typeof EffectSegmentSchema>;

/** One designated confirmation Lane per semantic segment. */
export const SpeechEffectPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sessionId: UuidSchema,
  connectionGeneration: UuidSchema,
  contentHash: HashSchema,
  textLength: OffsetSchema,
  segments: z.array(EffectSegmentSchema).min(1).max(32),
});
export type SpeechEffectPlan = z.infer<typeof SpeechEffectPlanSchema>;

const identity = {
  sessionId: UuidSchema,
  connectionGeneration: UuidSchema,
  sceneId: UuidSchema,
  cueId: UuidSchema,
  segmentId: UuidSchema,
  contentHash: HashSchema,
};

/** Issued only after a complete segment has been synthesized. It does not prove
 * playback. The host persists this mapping before sending it to Stage. */
export const AudioSegmentBindingSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ...identity,
  streamId: UuidSchema,
  sampleRateHz: z.literal(48_000),
  startSample: SamplesSchema,
  endSample: SamplesSchema,
});
export type AudioSegmentBinding = z.infer<typeof AudioSegmentBindingSchema>;

const receipt = {
  schemaVersion: z.literal(1),
  ...identity,
  receiptId: UuidSchema,
  start: OffsetSchema,
  end: OffsetSchema,
  appliedAtStageUs: DecimalStringSchema,
};
export const StageEffectReceiptSchema = z.discriminatedUnion("lane", [
  z.strictObject({
    ...receipt,
    lane: z.literal("audio"),
    boundary: z.literal("worklet_rendered"),
    streamId: UuidSchema,
    renderedSamples: SamplesSchema,
  }),
  z.strictObject({
    ...receipt,
    lane: z.literal("subtitle"),
    boundary: z.literal("subtitle_applied"),
  }),
]);
export type StageEffectReceipt = z.infer<typeof StageEffectReceiptSchema>;

/** This ACK means effect+Observe were durably committed, not merely received. */
export const StageEffectAckSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sessionId: UuidSchema,
  connectionGeneration: UuidSchema,
  sceneId: UuidSchema,
  receiptId: UuidSchema,
  outcome: z.enum(["recorded", "duplicate", "rejected"]),
  reason: z.enum(["invalid_effect", "privacy_revoked"]).nullable(),
});
export type StageEffectAck = z.infer<typeof StageEffectAckSchema>;

/** Stage sends release only after its generated receipts have durable ACKs.
 * Runtime echoes released only after closing the unused capacity reservation. */
export const StageEffectReleaseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sessionId: UuidSchema,
  connectionGeneration: UuidSchema,
  sceneId: UuidSchema,
});
export type StageEffectRelease = z.infer<typeof StageEffectReleaseSchema>;

/** Runtime closes synthesis with its complete durable binding prefix. Stage
 * waits for this message and receipt ACKs before releasing terminal state. */
export const StageEffectSealSchema = StageEffectReleaseSchema.extend({
  bindings: z.array(AudioSegmentBindingSchema).max(32),
});
export type StageEffectSeal = z.infer<typeof StageEffectSealSchema>;
