import {
  AudioSegmentBindingSchema,
  StageEffectAckSchema,
  StageEffectReleaseSchema,
  StageEffectSealSchema,
  type StageEffectSeal,
  type StageEffectRelease,
  SpeechEffectPlanSchema,
  type AudioSegmentBinding,
  type ScenePlan,
  type SpeechEffectPlan,
  type StageEffectReceipt,
  type MonotonicClock,
} from "@bellis/contracts";

const sha256 = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
};
const splitsSurrogate = (text: string, offset: number): boolean =>
  offset > 0 &&
  offset < text.length &&
  /[\uD800-\uDBFF]/u.test(text[offset - 1]!) &&
  /[\uDC00-\uDFFF]/u.test(text[offset]!);

interface TrackedScene {
  readonly plan: SpeechEffectPlan;
  readonly bindings: Map<string, AudioSegmentBinding>;
  readonly emitted: Set<string>;
  committed: boolean;
  finished: boolean;
  seal: StageEffectSeal | null;
  invalid: boolean;
  renderedSamples: number;
  renderedAtUs: bigint;
}

/** Bounded, connection-local receipts. No synthesis, free text, or inferred
 * progress. Runtime's durable ACK is separate from transport receipt/Scene end. */
export class StageEffectTracker {
  readonly #scenes = new Map<string, TrackedScene>();
  readonly #earlyBindings = new Map<string, AudioSegmentBinding>();
  readonly #earlyConflicts = new Set<string>();
  readonly #releasing = new Map<string, { payload: StageEffectRelease; sentAtUs: bigint | null }>();
  readonly #pending = new Map<string, { receipt: StageEffectReceipt; sentAtUs: bigint | null }>();
  #generation = 0;
  constructor(
    readonly options: {
      sessionId: string;
      clock: MonotonicClock;
      send: (type: string, payload: StageEffectReceipt | StageEffectRelease) => boolean;
      newId?: () => string;
    },
  ) {}

  get pendingCount(): number {
    return this.#pending.size;
  }

  async prepare(scene: ScenePlan): Promise<boolean> {
    if (scene.effects === undefined) return true;
    const generation = this.#generation;
    const parsed = SpeechEffectPlanSchema.safeParse(scene.effects);
    const speech = scene.speech as { text?: unknown } | undefined;
    if (!parsed.success || typeof speech?.text !== "string") return false;
    const plan = parsed.data;
    const text = speech.text;
    if (
      plan.sessionId !== this.options.sessionId ||
      plan.textLength !== text.length ||
      plan.contentHash !== (await sha256(text))
    )
      return false;
    let offset = 0;
    const ids = new Set<string>();
    for (const segment of plan.segments) {
      if (
        ids.has(segment.segmentId) ||
        segment.start !== offset ||
        segment.end <= segment.start ||
        segment.end > text.length ||
        splitsSurrogate(text, segment.end) ||
        !scene.cues.some((cue) => cue.cueId === segment.cueId && cue.lane === segment.lane) ||
        segment.textHash !== (await sha256(text.slice(segment.start, segment.end)))
      )
        return false;
      ids.add(segment.segmentId);
      offset = segment.end;
    }
    if (offset !== text.length || generation !== this.#generation) return false;
    const existing = this.#scenes.get(scene.scene.sceneId);
    if (existing !== undefined) return JSON.stringify(existing.plan) === JSON.stringify(plan);
    // Reserve all potential receipts before allowing prepare; pending ACKs keep
    // their reservation, so backpressure precedes any new visible output.
    const reserved = [...this.#scenes.values()].reduce(
      (sum, item) => sum + item.plan.segments.length,
      0,
    );
    if (this.#scenes.size + this.#releasing.size >= 4 || reserved + plan.segments.length > 128)
      return false;
    this.#scenes.set(scene.scene.sceneId, {
      plan,
      bindings: new Map(),
      emitted: new Set(),
      committed: false,
      finished: false,
      seal: null,
      invalid: this.#earlyConflicts.delete(scene.scene.sceneId),
      renderedSamples: 0,
      renderedAtUs: 0n,
    });
    for (const [key, binding] of this.#earlyBindings) {
      if (binding.sceneId !== scene.scene.sceneId) continue;
      this.#earlyBindings.delete(key);
      this.bindAudio(binding);
    }
    return true;
  }

  commit(sceneId: string): void {
    const record = this.#scenes.get(sceneId);
    if (record !== undefined && !record.finished) record.committed = true;
  }

  bindAudio(value: unknown): void {
    const parsed = AudioSegmentBindingSchema.safeParse(value);
    if (!parsed.success || parsed.data.sessionId !== this.options.sessionId) return;
    const binding = parsed.data;
    if (
      binding.endSample <= binding.startSample ||
      binding.startSample % 960 !== 0 ||
      binding.endSample % 960 !== 0
    )
      return;
    const record = this.#scenes.get(binding.sceneId);
    if (record === undefined) {
      if (this.#releasing.has(binding.sceneId)) return;
      const key = `${binding.sceneId}:${binding.segmentId}`;
      const existing = this.#earlyBindings.get(key);
      if (existing !== undefined) {
        if (JSON.stringify(existing) !== JSON.stringify(binding))
          this.#earlyConflicts.add(binding.sceneId);
      } else if (this.#earlyBindings.size < 128) this.#earlyBindings.set(key, binding);
      return;
    }
    const index = record.plan.segments.findIndex(
      (segment) => segment.segmentId === binding.segmentId,
    );
    const segment = record.plan.segments[index];
    if (
      segment?.lane !== "audio" ||
      segment.cueId !== binding.cueId ||
      record.plan.contentHash !== binding.contentHash ||
      record.plan.connectionGeneration !== binding.connectionGeneration
    )
      return;
    if (
      record.seal !== null &&
      !record.seal.bindings.some((item) => item.segmentId === binding.segmentId)
    ) {
      record.invalid = true;
      return;
    }
    const existing = record.bindings.get(binding.segmentId);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(binding)) record.invalid = true;
      return;
    }
    const previous = record.bindings.get(record.plan.segments[index - 1]?.segmentId ?? "");
    const next = record.bindings.get(record.plan.segments[index + 1]?.segmentId ?? "");
    if (
      (index === 0 && binding.startSample !== 0) ||
      (previous !== undefined && previous.endSample !== binding.startSample) ||
      (next !== undefined && binding.endSample !== next.startSample) ||
      [...record.bindings.values()].some((item) => item.streamId !== binding.streamId)
    ) {
      record.invalid = true;
      return;
    }
    record.bindings.set(binding.segmentId, binding);
    this.#confirmAudio(binding.sceneId, record);
  }

  audioRendered(sceneId: string, samples: number, atUs: bigint): void {
    const record = this.#scenes.get(sceneId);
    if (record === undefined || !record.committed || record.invalid || record.finished) return;
    if (
      !Number.isSafeInteger(samples) ||
      samples < record.renderedSamples ||
      samples > 28_800_000 ||
      atUs < 0n
    ) {
      record.invalid = true;
      return;
    }
    record.renderedSamples = samples;
    record.renderedAtUs = atUs;
    this.#confirmAudio(sceneId, record);
  }

  #confirmAudio(sceneId: string, record: TrackedScene): void {
    if (!record.committed || record.invalid) return;
    for (const segment of record.plan.segments) {
      const binding = record.bindings.get(segment.segmentId);
      // Require a contiguous binding prefix, even if later Control messages arrive first.
      if (
        segment.lane !== "audio" ||
        binding === undefined ||
        binding.endSample > record.renderedSamples
      )
        break;
      this.#emit(
        sceneId,
        record,
        segment.segmentId,
        {
          lane: "audio",
          boundary: "worklet_rendered",
          streamId: binding.streamId,
          renderedSamples: record.renderedSamples,
        },
        record.renderedAtUs,
      );
    }
  }

  subtitleApplied(sceneId: string, start: number, end: number, atUs: bigint): void {
    const record = this.#scenes.get(sceneId);
    if (
      record === undefined ||
      !record.committed ||
      record.finished ||
      record.invalid ||
      start !== 0 ||
      end !== record.plan.textLength ||
      atUs < 0n
    )
      return;
    for (const segment of record.plan.segments) {
      if (segment.lane === "subtitle")
        this.#emit(
          sceneId,
          record,
          segment.segmentId,
          { lane: "subtitle", boundary: "subtitle_applied" },
          atUs,
        );
    }
  }

  #emit(
    sceneId: string,
    record: TrackedScene,
    segmentId: string,
    proof:
      | { lane: "audio"; boundary: "worklet_rendered"; streamId: string; renderedSamples: number }
      | { lane: "subtitle"; boundary: "subtitle_applied" },
    atUs: bigint,
  ): void {
    if (record.emitted.has(segmentId)) return;
    const segment = record.plan.segments.find((item) => item.segmentId === segmentId)!;
    const receipt: StageEffectReceipt = Object.freeze({
      schemaVersion: 1,
      sessionId: record.plan.sessionId,
      connectionGeneration: record.plan.connectionGeneration,
      sceneId,
      cueId: segment.cueId,
      segmentId,
      contentHash: record.plan.contentHash,
      receiptId: this.options.newId?.() ?? crypto.randomUUID(),
      start: segment.start,
      end: segment.end,
      appliedAtStageUs: atUs.toString(),
      ...proof,
    });
    record.emitted.add(segmentId);
    this.#pending.set(receipt.receiptId, { receipt, sentAtUs: null });
    this.flush();
  }

  flush(): void {
    for (const sceneId of this.#scenes.keys()) this.#collect(sceneId);
    const now = this.options.clock.nowUs();
    for (const pending of this.#releasing.values()) {
      if (pending.sentAtUs !== null && now - pending.sentAtUs < 250_000n) continue;
      if (this.options.send("scene.effect.release", pending.payload)) pending.sentAtUs = now;
    }
    for (const pending of this.#pending.values()) {
      if (pending.sentAtUs !== null && now - pending.sentAtUs < 250_000n) continue;
      if (this.options.send("scene.effect.receipt", pending.receipt)) pending.sentAtUs = now;
    }
  }

  acknowledge(value: unknown): void {
    const parsed = StageEffectAckSchema.safeParse(value);
    if (!parsed.success) return;
    const ack = parsed.data;
    const pending = this.#pending.get(ack.receiptId);
    if (
      pending === undefined ||
      ack.sessionId !== pending.receipt.sessionId ||
      ack.connectionGeneration !== pending.receipt.connectionGeneration ||
      ack.sceneId !== pending.receipt.sceneId
    )
      return;
    this.#pending.delete(ack.receiptId);
    this.#collect(ack.sceneId);
  }

  seal(value: unknown): void {
    const parsed = StageEffectSealSchema.safeParse(value);
    if (!parsed.success) return;
    const seal = parsed.data;
    const record = this.#scenes.get(seal.sceneId);
    if (
      record === undefined ||
      seal.sessionId !== record.plan.sessionId ||
      seal.connectionGeneration !== record.plan.connectionGeneration
    )
      return;
    if (record.seal !== null) {
      if (JSON.stringify(record.seal) !== JSON.stringify(seal)) record.invalid = true;
      return;
    }
    for (let index = 0; index < seal.bindings.length; index++) {
      const binding = seal.bindings[index]!;
      const segment = record.plan.segments[index];
      const previous = seal.bindings[index - 1];
      if (
        segment?.lane !== "audio" ||
        binding.segmentId !== segment.segmentId ||
        binding.cueId !== segment.cueId ||
        binding.sceneId !== seal.sceneId ||
        binding.sessionId !== seal.sessionId ||
        binding.connectionGeneration !== seal.connectionGeneration ||
        binding.contentHash !== record.plan.contentHash ||
        binding.startSample !== (previous?.endSample ?? 0) ||
        binding.endSample <= binding.startSample ||
        binding.endSample % 960 !== 0 ||
        (previous !== undefined && previous.streamId !== binding.streamId)
      ) {
        record.invalid = true;
        return;
      }
    }
    if (
      [...record.bindings].some(
        ([id, binding]) =>
          !seal.bindings.some(
            (item) => item.segmentId === id && JSON.stringify(item) === JSON.stringify(binding),
          ),
      )
    ) {
      record.invalid = true;
      return;
    }
    // Complete final prefix repairs arbitrary Control-vs-Media delivery delay.
    // This is synthesis metadata, never proof that its samples were rendered.
    for (const binding of seal.bindings) this.bindAudio(binding);
    record.seal = seal;
    this.#collect(seal.sceneId);
  }

  finish(sceneId: string): void {
    const record = this.#scenes.get(sceneId);
    if (record !== undefined) {
      record.finished = true;
    }
    this.#collect(sceneId);
  }

  #collect(sceneId: string): void {
    const record = this.#scenes.get(sceneId);
    if (
      record?.finished &&
      record.seal !== null &&
      ![...this.#pending.values()].some((item) => item.receipt.sceneId === sceneId)
    ) {
      this.#releasing.set(sceneId, {
        payload: {
          schemaVersion: 1,
          sessionId: record.plan.sessionId,
          connectionGeneration: record.plan.connectionGeneration,
          sceneId,
        },
        sentAtUs: null,
      });
      this.#scenes.delete(sceneId);
    }
  }

  releaseUnprepared(plan: ScenePlan): void {
    const effects = plan.effects;
    if (
      effects === undefined ||
      effects.sessionId !== this.options.sessionId ||
      this.#releasing.size >= 4 ||
      this.#scenes.has(plan.scene.sceneId)
    )
      return;
    this.#releasing.set(plan.scene.sceneId, {
      payload: {
        schemaVersion: 1,
        sessionId: effects.sessionId,
        connectionGeneration: effects.connectionGeneration,
        sceneId: plan.scene.sceneId,
      },
      sentAtUs: null,
    });
    this.flush();
  }

  released(value: unknown): void {
    const parsed = StageEffectReleaseSchema.safeParse(value);
    if (!parsed.success) return;
    const pending = this.#releasing.get(parsed.data.sceneId);
    if (pending !== undefined && JSON.stringify(pending.payload) === JSON.stringify(parsed.data))
      this.#releasing.delete(parsed.data.sceneId);
  }

  clear(): void {
    this.#generation++;
    this.#scenes.clear();
    this.#pending.clear();
    this.#releasing.clear();
    this.#earlyBindings.clear();
    this.#earlyConflicts.clear();
  }
}
