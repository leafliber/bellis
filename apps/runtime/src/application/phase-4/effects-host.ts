import {
  StageEffectReceiptSchema,
  StageEffectReleaseSchema,
  StageEffectSealSchema,
  type StageEffectSeal,
  type AudioSegmentBinding,
  type MemoryOutputTarget,
  type ScenePlan,
} from "@bellis/contracts";
import type { PersistenceClient } from "@bellis/persistence";
import type { ControlChannel } from "../phase-2/stage-port-adapter.js";
import { prepareSpeechEffects } from "./speech-effects.js";

export interface SpeechEffectsPort {
  prepare(plan: ScenePlan, sessionId: string, generation: string, traceId: string): ScenePlan;
  ready(plan: ScenePlan, signal: AbortSignal): Promise<void>;
  bind(binding: AudioSegmentBinding, signal: AbortSignal): Promise<void>;
  receive(payload: unknown, sessionId: string, generation: string): void;
  finish(sceneId: string): void;
  sent(sceneId: string): void;
  release(payload: unknown, sessionId: string, generation: string): void;
  disconnect(): void;
  close(): Promise<void>;
}
interface Prepared {
  readonly plan: ScenePlan;
  readonly traceId: string;
  readonly ready: Promise<void>;
  readonly bindings: Map<string, AudioSegmentBinding>;
  readonly bindingWrites: Set<Promise<void>>;
  seal?: StageEffectSeal;
  sealing?: Promise<void>;
  sent: boolean;
  terminal: boolean;
  timer?: ReturnType<typeof setTimeout>;
}
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", aborted, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

/** Owns durable effect permits for one Stage transport. Stage never selects text,
 * memory targets, or the trusted connection generation used by the DB request. */
export class Phase4EffectsHost implements SpeechEffectsPort {
  readonly #prepared = new Map<string, Prepared>();
  readonly #receiving = new Set<string>();
  #closed = false;
  readonly options: {
    persistence: PersistenceClient;
    channel: ControlChannel;
    targets: () => readonly MemoryOutputTarget[];
    onError: (code: string) => void;
  };
  constructor(options: Phase4EffectsHost["options"]) {
    this.options = options;
  }

  prepare(plan: ScenePlan, sessionId: string, generation: string, traceId: string): ScenePlan {
    if (this.#closed || this.#prepared.size >= 4) throw new Error("effect_capacity_unavailable");
    const frozen = prepareSpeechEffects(plan, { sessionId, connectionGeneration: generation });
    if (frozen.effects === undefined) return frozen;
    const ready = this.options.persistence.phase4PrepareEffects({
      schemaVersion: 1,
      plan: frozen,
      targets: [...this.options.targets()],
    });
    void ready.catch(() => this.options.onError("effect_preparation_failed"));
    this.#prepared.set(frozen.scene.sceneId, {
      plan: frozen,
      traceId,
      ready,
      sent: false,
      terminal: false,
      bindings: new Map(),
      bindingWrites: new Set(),
    });
    return frozen;
  }
  async ready(plan: ScenePlan, signal: AbortSignal): Promise<void> {
    if (plan.effects === undefined) return;
    const record = this.#prepared.get(plan.scene.sceneId);
    if (record === undefined) throw new Error("effect_preparation_missing");
    await abortable(record.ready, signal);
    if (
      this.#closed ||
      this.options.channel.activeConnectionId?.() !== plan.effects.connectionGeneration
    )
      throw new Error("effect_connection_changed");
    signal.throwIfAborted();
  }
  async bind(binding: AudioSegmentBinding, signal: AbortSignal): Promise<void> {
    const record = this.#prepared.get(binding.sceneId);
    if (record === undefined) throw new Error("effect_preparation_missing");
    await this.ready(record.plan, signal);
    if (record.terminal) throw new Error("effect_synthesis_closed");
    const write = this.options.persistence.phase4BindAudioSegment(binding).then(() => {
      record.bindings.set(binding.segmentId, binding);
    });
    record.bindingWrites.add(write);
    void write.finally(() => record.bindingWrites.delete(write)).catch(() => {});
    await abortable(write, signal);
    signal.throwIfAborted();
    if (
      this.options.channel.activeConnectionId?.() !== binding.connectionGeneration ||
      !this.options.channel.enqueueServerMessage({
        type: "scene.effect.binding",
        payload: binding,
        trace: { traceId: record.traceId },
      })
    )
      throw new Error("effect_binding_send_failed");
  }
  receive(payload: unknown, sessionId: string, generation: string): void {
    const parsed = StageEffectReceiptSchema.safeParse(payload);
    if (!parsed.success || this.#closed) return;
    const receipt = parsed.data;
    const record = this.#prepared.get(receipt.sceneId);
    if (
      record === undefined ||
      receipt.sessionId !== sessionId ||
      receipt.connectionGeneration !== generation ||
      this.#receiving.size >= 128 ||
      this.#receiving.has(receipt.receiptId)
    )
      return;
    this.#receiving.add(receipt.receiptId);
    void this.options.persistence
      .phase4ConfirmEffect({ sessionId, connectionGeneration: generation, receipt })
      .then(
        (ack) => {
          if (this.options.channel.activeConnectionId?.() === generation)
            this.options.channel.enqueueServerMessage({
              type: "scene.effect.ack",
              payload: ack,
              trace: { traceId: record.traceId },
            });
        },
        (error) => {
          const code =
            error !== null && typeof error === "object" && "code" in error ? error.code : null;
          this.options.onError("effect_confirmation_failed");
          if (
            (code === "invalid_request" || code === "idempotency_conflict") &&
            this.options.channel.activeConnectionId?.() === generation
          )
            this.options.channel.enqueueServerMessage({
              type: "scene.effect.ack",
              payload: {
                schemaVersion: 1,
                sessionId,
                connectionGeneration: generation,
                sceneId: receipt.sceneId,
                receiptId: receipt.receiptId,
                outcome: "rejected",
                reason: "invalid_effect",
              },
              trace: { traceId: record.traceId },
            });
        },
      )
      .finally(() => this.#receiving.delete(receipt.receiptId));
  }
  finish(sceneId: string): void {
    const record = this.#prepared.get(sceneId);
    if (record !== undefined) record.terminal = true;
    if (record === undefined || record.timer !== undefined) return;
    if (record.sent) {
      if (record.sealing !== undefined) return;
      record.sealing = Promise.allSettled(record.bindingWrites).then(() => {
        const effects = record.plan.effects!;
        record.seal = StageEffectSealSchema.parse({
          schemaVersion: 1,
          sessionId: effects.sessionId,
          connectionGeneration: effects.connectionGeneration,
          sceneId,
          bindings: effects.segments.flatMap((segment) => {
            const binding = record.bindings.get(segment.segmentId);
            return binding === undefined ? [] : [binding];
          }),
        });
        this.#sendSeal(sceneId, record);
      });
      void record.sealing.catch(() => this.options.onError("effect_seal_failed"));
      return;
    }
    // Only undispatched/disconnected permits expire locally. Dispatched effects
    // retain capacity until Stage has durable ACKs and requests release.
    record.timer = setTimeout(() => {
      delete record.timer;
      void this.#release(sceneId, record).catch(() => {
        this.options.onError("effect_close_failed");
        if (!this.#closed) this.finish(sceneId);
      });
    }, 2000);
    record.timer.unref();
  }
  #sendSeal(sceneId: string, record: Prepared): void {
    if (
      this.#closed ||
      !record.sent ||
      record.seal === undefined ||
      this.#prepared.get(sceneId) !== record ||
      this.options.channel.activeConnectionId?.() !== record.plan.effects!.connectionGeneration
    )
      return;
    this.options.channel.enqueueServerMessage({
      type: "scene.effect.seal",
      payload: record.seal,
      trace: { traceId: record.traceId },
    });
    record.timer = setTimeout(() => {
      delete record.timer;
      this.#sendSeal(sceneId, record);
    }, 250);
    record.timer.unref();
  }
  async #release(sceneId: string, record: Prepared): Promise<void> {
    if (record.timer !== undefined) {
      clearTimeout(record.timer);
      delete record.timer;
    }
    await record.ready.catch(() => undefined);
    await this.options.persistence.phase4CloseEffects(record.plan.effects!.sessionId, sceneId);
    if (this.#prepared.get(sceneId) === record) this.#prepared.delete(sceneId);
  }
  sent(sceneId: string): void {
    const record = this.#prepared.get(sceneId);
    if (record !== undefined) record.sent = true;
  }
  release(payload: unknown, sessionId: string, generation: string): void {
    const parsed = StageEffectReleaseSchema.safeParse(payload);
    if (
      !parsed.success ||
      this.#closed ||
      parsed.data.sessionId !== sessionId ||
      parsed.data.connectionGeneration !== generation
    )
      return;
    const value = parsed.data;
    const record = this.#prepared.get(value.sceneId);
    if (record !== undefined && !record.terminal) return;
    if (
      record !== undefined &&
      (record.plan.effects!.sessionId !== sessionId ||
        record.plan.effects!.connectionGeneration !== generation)
    )
      return;
    const key = `release:${value.sceneId}`;
    if (this.#receiving.size >= 128 || this.#receiving.has(key)) return;
    this.#receiving.add(key);
    void (record === undefined ? Promise.resolve() : this.#release(value.sceneId, record))
      .then(
        () => {
          if (this.options.channel.activeConnectionId?.() === generation)
            this.options.channel.enqueueServerMessage({
              type: "scene.effect.released",
              payload: value,
              trace: { traceId: record?.traceId ?? value.sceneId.replaceAll("-", "") },
            });
        },
        () => this.options.onError("effect_release_failed"),
      )
      .finally(() => this.#receiving.delete(key));
  }
  disconnect(): void {
    for (const [sceneId, record] of this.#prepared) {
      if (record.timer !== undefined) {
        clearTimeout(record.timer);
        delete record.timer;
      }
      record.sent = false;
      this.finish(sceneId);
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all(
      [...this.#prepared].map(async ([sceneId, record]) => {
        if (record.timer !== undefined) clearTimeout(record.timer);
        await this.#release(sceneId, record);
      }),
    );
  }
}
