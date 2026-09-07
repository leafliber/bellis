import { createHash, randomUUID } from "node:crypto";
import {
  AudioSegmentBindingSchema,
  ScenePlanSchema,
  SpeechIntentSchema,
  PHASE_2_PCM_FRAME_BYTES,
  PHASE_2_PCM_SAMPLES_PER_FRAME,
  type AudioSegmentBinding,
  type ScenePlan,
  type SpeechIntent,
} from "@bellis/contracts";
import type { SpeechProvider } from "../performance/speech-provider.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Fixed sentence policy v1. Preserve every UTF-16 code unit, including spacing,
 * closers and punctuation. At most 32 segments; the final segment owns the tail. */
export function speechSegmentRanges(text: string): readonly { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  let start = 0;
  for (let index = 0; index < text.length && ranges.length < 31; index++) {
    const char = text[index]!;
    if (!/[。！？.!?\n]/u.test(char)) continue;
    if (char === "." && /\d/u.test(text[index - 1] ?? "") && /\d/u.test(text[index + 1] ?? ""))
      continue;
    let end = index + 1;
    while (end < text.length && /[。！？.!?\s”’"'）)\]】]/u.test(text[end]!)) end++;
    ranges.push({ start, end });
    start = end;
    index = end - 1;
  }
  if (start < text.length) ranges.push({ start, end: text.length });
  return ranges;
}

export function prepareSpeechEffects(
  plan: ScenePlan,
  context: {
    sessionId: string;
    connectionGeneration: string;
    newId?: () => string;
  },
): ScenePlan {
  const speech = SpeechIntentSchema.safeParse(plan.speech);
  if (!speech.success) return plan;
  const cue =
    plan.cues.find((item) => item.lane === "audio") ??
    plan.cues.find((item) => item.lane === "subtitle");
  if (cue === undefined) return plan;
  const text = speech.data.text;
  return ScenePlanSchema.parse({
    ...plan,
    // Confirmation requires the designated output lane. Phase 3's zero-budget
    // best-effort default may otherwise commit a subtitle while dropping audio.
    scene: {
      ...plan.scene,
      groups: plan.scene.groups.map((group) =>
        group.lanes.includes(cue.lane) ? { ...group, level: "hard" } : group,
      ),
    },
    effects: {
      schemaVersion: 1,
      sessionId: context.sessionId,
      connectionGeneration: context.connectionGeneration,
      contentHash: hash(text),
      textLength: text.length,
      segments: speechSegmentRanges(text).map((range) => ({
        ...range,
        segmentId: context.newId?.() ?? randomUUID(),
        cueId: cue.cueId,
        lane: cue.lane,
        textHash: hash(text.slice(range.start, range.end)),
      })),
    },
  });
}

/** One-frame lookahead withholds each segment's last PCM frame until synthesis
 * has completed and its binding is durably accepted. A failed/cancelled segment
 * has no binding and can never be mistaken for confirmed complete text. */
export async function* streamSpeechEffectSegments(input: {
  plan: ScenePlan;
  speech: SpeechIntent;
  streamId: string;
  provider: SpeechProvider;
  signal: AbortSignal;
  bind: (binding: AudioSegmentBinding, signal: AbortSignal) => Promise<void>;
}): AsyncGenerator<Uint8Array> {
  const effects = input.plan.effects;
  if (effects === undefined) {
    yield* input.provider.stream(input.speech, input.signal);
    return;
  }
  if (hash(input.speech.text) !== effects.contentHash) throw new Error("effect_speech_changed");
  let samples = 0;
  for (const segment of effects.segments) {
    input.signal.throwIfAborted();
    if (segment.lane !== "audio") throw new Error("effect_audio_lane_mismatch");
    const text = input.speech.text.slice(segment.start, segment.end);
    if (!text || hash(text) !== segment.textHash) throw new Error("effect_segment_changed");
    const startSample = samples;
    let held: Uint8Array | null = null;
    for await (const frame of input.provider.stream(
      SpeechIntentSchema.parse({ ...input.speech, text }),
      input.signal,
    )) {
      input.signal.throwIfAborted();
      if (frame.byteLength !== PHASE_2_PCM_FRAME_BYTES) throw new Error("effect_pcm_frame_invalid");
      // Copy before yielding: provider iterators may reuse their own frame buffer.
      const next = frame.slice();
      if (held !== null) yield held;
      held = next;
      samples += PHASE_2_PCM_SAMPLES_PER_FRAME;
      if (samples > 28_800_000) throw new Error("effect_audio_duration_exceeded");
    }
    input.signal.throwIfAborted();
    if (held === null) throw new Error("effect_segment_has_no_audio");
    await input.bind(
      AudioSegmentBindingSchema.parse({
        schemaVersion: 1,
        sessionId: effects.sessionId,
        connectionGeneration: effects.connectionGeneration,
        sceneId: input.plan.scene.sceneId,
        cueId: segment.cueId,
        segmentId: segment.segmentId,
        contentHash: effects.contentHash,
        streamId: input.streamId,
        sampleRateHz: 48000,
        startSample,
        endSample: samples,
      }),
      input.signal,
    );
    input.signal.throwIfAborted();
    yield held;
  }
}
