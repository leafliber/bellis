import { createHash } from "node:crypto";
import {
  AudioSegmentBindingSchema,
  ContextManifestSchema,
  EffectPreparationSchema,
  ScenePlanSchema,
  SpeechIntentSchema,
  StageEffectReceiptSchema,
  type AudioSegmentBinding,
  type EffectPreparation,
  type StageEffectReceipt,
  type StageEffectAck,
  type MemoryPolicyStamp,
} from "@bellis/contracts";
import { PersistenceError } from "../errors.js";
import { observationPressure, writeObservation } from "./phase4-observe.js";
import { readText, type SqliteDatabase } from "./sqlite-port.js";
import { assertContextPolicy, assertMemoryPolicy } from "./phase4-memory-policy.js";
import type { CompletionCounts, CompletionKind } from "../completion-budget.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const invalid = () => new PersistenceError("invalid_request", "invalid output effect");

function consumeCompletion(
  db: SqliteDatabase,
  sceneId: string,
  kind: Exclude<CompletionKind, "close">,
): void {
  const column = kind === "binding" ? "bindings_remaining" : "confirmations_remaining";
  const result = db
    .prepare(
      `UPDATE phase4_completion_reservations SET ${column} = ${column} - 1 WHERE scene_id = ? AND ${column} > 0`,
    )
    .run(sceneId);
  if (Number(result.changes) !== 1)
    throw new PersistenceError("storage_not_ready", "effect completion reservation unavailable");
}

function transaction<T>(db: SqliteDatabase, body: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = body();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function confirmationTransaction<T>(
  db: SqliteDatabase,
  body: () => T,
  beforeCommit?: () => Promise<void>,
): Promise<T> {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = body();
    if (beforeCommit) await beforeCommit();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function readPreparation(
  db: SqliteDatabase,
  sessionId: string,
  sceneId: string,
  allowClosed = false,
): EffectPreparation {
  const row = db
    .prepare(
      "SELECT preparation_json, preparation_digest, closed FROM phase4_effect_preparations WHERE session_id = ? AND scene_id = ?",
    )
    .get(sessionId, sceneId);
  if (row === undefined || (!allowClosed && row.closed !== 0)) throw invalid();
  const text = readText(row, "preparation_json");
  if (hash(text) !== readText(row, "preparation_digest"))
    throw new PersistenceError("record_invalid", "effect preparation digest mismatch");
  return EffectPreparationSchema.parse(JSON.parse(text));
}

function segmentText(preparation: EffectPreparation, start: number, end: number): string {
  return SpeechIntentSchema.parse(preparation.plan.speech).text.slice(start, end);
}

function reservation(preparation: EffectPreparation, start: number, end: number): number {
  const textBytes = Buffer.byteLength(segmentText(preparation, start, end));
  return preparation.targets.reduce(
    (total, target) => total + Buffer.byteLength(JSON.stringify(target)) + textBytes + 4096,
    0,
  );
}

export function prepareEffects(
  db: SqliteDatabase,
  value: EffectPreparation,
  nowMs: number,
  assertAdmission?: () => void,
  assertReservation?: (counts: CompletionCounts) => void,
): void {
  const input = EffectPreparationSchema.parse(value);
  const plan = input.plan;
  const effects = plan.effects;
  if (effects === undefined) throw invalid();
  const speech = SpeechIntentSchema.parse(plan.speech);
  if (
    effects.contentHash !== hash(speech.text) ||
    effects.textLength !== speech.text.length ||
    new Set(input.targets.map((target) => target.providerId)).size !== input.targets.length ||
    input.targets.some((target) => Buffer.byteLength(JSON.stringify(target)) > 8192)
  )
    throw invalid();
  let end = 0;
  const ids = new Set<string>();
  for (const segment of effects.segments) {
    if (
      segment.start !== end ||
      segment.end <= segment.start ||
      segment.end > speech.text.length ||
      ids.has(segment.segmentId) ||
      segment.textHash !== hash(speech.text.slice(segment.start, segment.end)) ||
      Buffer.from(speech.text.slice(segment.start, segment.end)).toString("utf8") !==
        speech.text.slice(segment.start, segment.end) ||
      !plan.cues.some((cue) => cue.cueId === segment.cueId && cue.lane === segment.lane)
    )
      throw invalid();
    ids.add(segment.segmentId);
    end = segment.end;
  }
  if (
    end !== speech.text.length ||
    new Set(effects.segments.map((segment) => segment.lane)).size !== 1
  )
    throw invalid();
  const encoded = JSON.stringify(input);
  const digest = hash(encoded);
  transaction(db, () => {
    const existing = db
      .prepare(
        "SELECT preparation_digest, closed FROM phase4_effect_preparations WHERE scene_id = ?",
      )
      .get(plan.scene.sceneId);
    if (existing !== undefined) {
      if (readText(existing, "preparation_digest") !== digest || existing.closed !== 0)
        throw new PersistenceError("idempotency_conflict", "effect preparation changed");
      return;
    }
    assertAdmission?.();
    const adopted = db
      .prepare(
        "SELECT manifest_json, manifest_digest FROM phase4_context_manifests WHERE session_id = ? AND cycle_id = ?",
      )
      .get(effects.sessionId, plan.scene.cycleId);
    if (adopted === undefined) throw invalid();
    if (hash(readText(adopted, "manifest_json")) !== readText(adopted, "manifest_digest"))
      throw new PersistenceError("record_invalid", "context manifest digest mismatch");
    const manifest = ContextManifestSchema.parse(JSON.parse(readText(adopted, "manifest_json")));
    assertContextPolicy(db, manifest);
    if (
      input.targets.some(
        (target) => JSON.stringify(target.policy) !== JSON.stringify(manifest.policy),
      )
    )
      throw invalid();
    if (input.targets.some((target) => target.agentId !== manifest.persona.agentId))
      throw invalid();
    const bytes = effects.segments.reduce(
      (sum, segment) => sum + reservation(input, segment.start, segment.end),
      0,
    );
    const count = effects.segments.length * input.targets.length;
    const p = observationPressure(db);
    if (
      p.activePlans >= 4 ||
      p.pendingCount + p.reservedCount + count > 11_024 ||
      p.pendingBytes + p.reservedBytes + bytes > 32 * 1024 * 1024
    )
      throw new PersistenceError("database_busy", "output effect reservation unavailable");
    const counts = {
      bindings: effects.segments.filter((segment) => segment.lane === "audio").length,
      confirmations: effects.segments.length,
      closes: 1,
    };
    assertReservation?.(counts);
    db.prepare(`INSERT INTO phase4_effect_preparations
      (scene_id, session_id, cycle_id, connection_generation, preparation_json, preparation_digest, reserved_events, reserved_bytes, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      plan.scene.sceneId,
      effects.sessionId,
      plan.scene.cycleId,
      effects.connectionGeneration,
      encoded,
      digest,
      count,
      bytes,
      nowMs,
    );
    db.prepare(
      "INSERT INTO phase4_completion_reservations (scene_id, bindings_remaining, confirmations_remaining) VALUES (?, ?, ?)",
    ).run(plan.scene.sceneId, counts.bindings, counts.confirmations);
  });
}

export function bindAudioSegment(db: SqliteDatabase, value: AudioSegmentBinding): void {
  const binding = AudioSegmentBindingSchema.parse(value);
  transaction(db, () => {
    const preparation = readPreparation(db, binding.sessionId, binding.sceneId);
    const effects = preparation.plan.effects!;
    const index = effects.segments.findIndex((segment) => segment.segmentId === binding.segmentId);
    const segment = effects.segments[index];
    if (
      segment?.lane !== "audio" ||
      segment.cueId !== binding.cueId ||
      effects.connectionGeneration !== binding.connectionGeneration ||
      effects.contentHash !== binding.contentHash ||
      binding.endSample <= binding.startSample ||
      binding.startSample % 960 !== 0 ||
      binding.endSample % 960 !== 0
    )
      throw invalid();
    const encoded = JSON.stringify(binding);
    const existing = db
      .prepare(
        "SELECT binding_json FROM phase4_effect_bindings WHERE scene_id = ? AND segment_id = ?",
      )
      .get(binding.sceneId, binding.segmentId);
    if (existing !== undefined) {
      if (readText(existing, "binding_json") !== encoded)
        throw new PersistenceError("idempotency_conflict", "audio segment binding changed");
      return;
    }
    // Synthesis is sequential. Require the previous durable binding, never fill a guessed gap.
    const previous =
      index === 0
        ? undefined
        : db
            .prepare(
              "SELECT binding_json FROM phase4_effect_bindings WHERE scene_id = ? AND segment_id = ?",
            )
            .get(binding.sceneId, effects.segments[index - 1]!.segmentId);
    const previousBinding =
      previous === undefined
        ? undefined
        : AudioSegmentBindingSchema.parse(JSON.parse(readText(previous, "binding_json")));
    if (
      index === 0
        ? binding.startSample !== 0
        : previousBinding === undefined ||
          previousBinding.endSample !== binding.startSample ||
          previousBinding.streamId !== binding.streamId
    )
      throw invalid();
    db.prepare(
      "INSERT INTO phase4_effect_bindings(scene_id, segment_id, binding_json, binding_digest) VALUES (?, ?, ?, ?)",
    ).run(binding.sceneId, binding.segmentId, encoded, hash(encoded));
    consumeCompletion(db, binding.sceneId, "binding");
  });
}

export interface ConfirmEffectInput {
  readonly sessionId: string;
  readonly connectionGeneration: string;
  readonly receipt: StageEffectReceipt;
}

export function confirmEffect(
  db: SqliteDatabase,
  input: ConfirmEffectInput,
  nowMs: number,
  leaseNowMs: number,
  beforeCommit?: () => Promise<void>,
): Promise<StageEffectAck> {
  const receipt = StageEffectReceiptSchema.parse(input.receipt);
  if (
    receipt.sessionId !== input.sessionId ||
    receipt.connectionGeneration !== input.connectionGeneration
  )
    throw invalid();
  return confirmationTransaction<StageEffectAck>(
    db,
    () => {
      const adopted = db
        .prepare(`SELECT m.manifest_json, m.manifest_digest FROM phase4_effect_preparations AS p
      JOIN phase4_context_manifests AS m ON m.session_id = p.session_id AND m.cycle_id = p.cycle_id
      WHERE p.session_id = ? AND p.scene_id = ?`)
        .get(input.sessionId, receipt.sceneId);
      if (adopted === undefined) throw invalid();
      if (hash(readText(adopted, "manifest_json")) !== readText(adopted, "manifest_digest"))
        throw invalid();
      try {
        assertContextPolicy(
          db,
          ContextManifestSchema.parse(JSON.parse(readText(adopted, "manifest_json"))),
          true,
        );
      } catch (error) {
        if (!(error instanceof PersistenceError) || error.code !== "invalid_request") throw error;
        return {
          schemaVersion: 1,
          sessionId: input.sessionId,
          connectionGeneration: input.connectionGeneration,
          sceneId: receipt.sceneId,
          receiptId: receipt.receiptId,
          outcome: "rejected",
          reason: "privacy_revoked",
        };
      }
      const encoded = JSON.stringify(receipt);
      const sameId = db
        .prepare("SELECT receipt_json FROM phase4_effect_receipts WHERE receipt_id = ?")
        .get(receipt.receiptId);
      if (sameId !== undefined && readText(sameId, "receipt_json") !== encoded)
        throw new PersistenceError("idempotency_conflict", "effect receipt identity changed");
      const preparation = readPreparation(
        db,
        input.sessionId,
        receipt.sceneId,
        sameId !== undefined,
      );
      const effects = preparation.plan.effects!;
      const segment = effects.segments.find((item) => item.segmentId === receipt.segmentId);
      if (
        segment === undefined ||
        effects.connectionGeneration !== input.connectionGeneration ||
        effects.contentHash !== receipt.contentHash ||
        segment.cueId !== receipt.cueId ||
        segment.lane !== receipt.lane ||
        segment.start !== receipt.start ||
        segment.end !== receipt.end
      )
        throw invalid();
      const committed = db
        .prepare(
          "SELECT plan_json FROM scenes WHERE session_id = ? AND scene_id = ? AND cycle_id = ?",
        )
        .get(input.sessionId, receipt.sceneId, preparation.plan.scene.cycleId);
      if (committed === undefined || typeof committed.plan_json !== "string") throw invalid();
      const committedPlan = ScenePlanSchema.parse(JSON.parse(readText(committed, "plan_json")));
      if (
        JSON.stringify(committedPlan.effects) !== JSON.stringify(effects) ||
        SpeechIntentSchema.parse(committedPlan.speech).text !==
          SpeechIntentSchema.parse(preparation.plan.speech).text ||
        !committedPlan.cues.some((cue) => cue.cueId === receipt.cueId && cue.lane === receipt.lane)
      )
        throw invalid();
      if (receipt.lane === "audio") {
        const row = db
          .prepare(
            "SELECT binding_json, binding_digest FROM phase4_effect_bindings WHERE scene_id = ? AND segment_id = ?",
          )
          .get(receipt.sceneId, receipt.segmentId);
        if (
          row === undefined ||
          hash(readText(row, "binding_json")) !== readText(row, "binding_digest")
        )
          throw invalid();
        const binding = AudioSegmentBindingSchema.parse(JSON.parse(readText(row, "binding_json")));
        if (binding.streamId !== receipt.streamId || receipt.renderedSamples < binding.endSample)
          throw invalid();
      }
      const duplicate =
        db
          .prepare(
            "SELECT receipt_id FROM phase4_effect_receipts WHERE scene_id = ? AND segment_id = ?",
          )
          .get(receipt.sceneId, receipt.segmentId) !== undefined;
      if (!duplicate) {
        const text = segmentText(preparation, segment.start, segment.end);
        db.prepare(`INSERT INTO phase4_effect_receipts
        (receipt_id, session_id, scene_id, segment_id, receipt_json, receipt_digest, confirmed_text, confirmed_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          receipt.receiptId,
          input.sessionId,
          receipt.sceneId,
          receipt.segmentId,
          encoded,
          hash(encoded),
          text,
          nowMs,
        );
        const partial = effects.segments.length > 1;
        for (const target of preparation.targets)
          writeObservation(
            db,
            {
              sessionId: input.sessionId,
              factKey: hash(JSON.stringify(["effect", receipt.sceneId, receipt.segmentId])),
              target,
              leaseNowMs,
              fact: {
                role: "assistant",
                kind: "message.text",
                occurredAtMs: nowMs,
                committedAtMs: nowMs,
                content: text,
                effectState: partial ? "partial" : "committed",
                ...(partial
                  ? {
                      effectProof: {
                        confirmed_range: {
                          unit: "utf16",
                          start: segment.start,
                          end: segment.end,
                          scene_id: receipt.sceneId,
                          segment_id: receipt.segmentId,
                          content_hash: effects.contentHash,
                          lane: receipt.lane,
                        },
                      },
                    }
                  : {}),
              },
            },
            true,
          );
        db.prepare(
          "UPDATE phase4_effect_preparations SET reserved_events = reserved_events - ?, reserved_bytes = reserved_bytes - ? WHERE scene_id = ?",
        ).run(
          preparation.targets.length,
          reservation(preparation, segment.start, segment.end),
          receipt.sceneId,
        );
        consumeCompletion(db, receipt.sceneId, "confirmation");
      }
      return {
        schemaVersion: 1,
        sessionId: receipt.sessionId,
        connectionGeneration: receipt.connectionGeneration,
        sceneId: receipt.sceneId,
        receiptId: receipt.receiptId,
        outcome: duplicate ? "duplicate" : "recorded",
        reason: null,
      };
    },
    beforeCommit,
  );
}

export function closeEffects(db: SqliteDatabase, sessionId: string, sceneId: string): void {
  transaction(db, () => {
    const row = db
      .prepare(
        "SELECT closed FROM phase4_effect_preparations WHERE session_id = ? AND scene_id = ?",
      )
      .get(sessionId, sceneId);
    if (row === undefined) return;
    if (row.closed === 0)
      db.prepare(
        "UPDATE phase4_effect_preparations SET closed = 1, reserved_events = 0, reserved_bytes = 0 WHERE session_id = ? AND scene_id = ?",
      ).run(sessionId, sceneId);
    if (
      db.prepare("SELECT 1 FROM phase4_completion_reservations WHERE scene_id = ?").get(sceneId) !==
      undefined
    )
      db.prepare("DELETE FROM phase4_completion_reservations WHERE scene_id = ?").run(sceneId);
  });
}

/** New Worker means old Stage generations cannot resume. Keep facts, not permits. */
export function closeRecoveredEffects(
  db: SqliteDatabase,
  withReservedClose: (sceneId: string, close: () => void) => void,
): void {
  if (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'phase4_effect_preparations'",
      )
      .get() === undefined
  )
    return;
  if (
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'phase4_completion_reservations'",
      )
      .get() === undefined
  ) {
    // Historical schemas have no completion credits. Do not manufacture a
    // privileged allowance for them, or issue a write when nothing is active.
    if (
      db.prepare("SELECT 1 FROM phase4_effect_preparations WHERE closed = 0 LIMIT 1").get() !==
      undefined
    )
      transaction(db, () => {
        db.prepare(
          "UPDATE phase4_effect_preparations SET closed = 1, reserved_events = 0, reserved_bytes = 0 WHERE closed = 0",
        ).run();
      });
    return;
  }
  const rows = db
    .prepare(`SELECT p.session_id, p.scene_id, r.scene_id IS NOT NULL AS has_credit
    FROM phase4_effect_preparations AS p LEFT JOIN phase4_completion_reservations AS r ON r.scene_id = p.scene_id
    WHERE p.closed = 0 OR r.scene_id IS NOT NULL ORDER BY p.scene_id`)
    .all();
  // Each Scene owns one bounded close transaction. A partial boot failure can
  // safely retry: committed closes have no remaining row or credit to consume.
  for (const row of rows) {
    const sceneId = readText(row, "scene_id");
    const close = () => closeEffects(db, readText(row, "session_id"), sceneId);
    if (row.has_credit === 1) withReservedClose(sceneId, close);
    else close();
  }
}

export interface ConfirmedSpeech {
  readonly cycleId: string;
  readonly receiptId: string;
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly confirmedAtMs: number;
}
export function readConfirmedSpeech(
  db: SqliteDatabase,
  sessionId: string,
  limit: number,
  policy?: MemoryPolicyStamp,
): ConfirmedSpeech[] {
  if (policy !== undefined) assertMemoryPolicy(db, policy);
  return db
    .prepare(`SELECT r.receipt_id, r.confirmed_text, r.confirmed_at_ms, r.receipt_json, r.receipt_digest, p.cycle_id
    FROM phase4_effect_receipts r JOIN phase4_effect_preparations p ON p.scene_id = r.scene_id
    LEFT JOIN phase4_context_manifests m ON m.session_id = p.session_id AND m.cycle_id = p.cycle_id
    WHERE r.session_id = ? AND (? IS NULL OR (json_extract(m.manifest_json, '$.policy.scopeKey') = ?
      AND json_extract(m.manifest_json, '$.policy.generation') = ?))
    ORDER BY r.confirmed_at_ms DESC, r.rowid DESC LIMIT ?`)
    .all(
      sessionId,
      policy?.scopeKey ?? null,
      policy?.scopeKey ?? null,
      policy?.generation ?? null,
      limit,
    )
    .toReversed()
    .map((row) => {
      if (hash(readText(row, "receipt_json")) !== readText(row, "receipt_digest"))
        throw new PersistenceError("record_invalid", "effect receipt digest mismatch");
      const receipt = StageEffectReceiptSchema.parse(JSON.parse(readText(row, "receipt_json")));
      const preparation = readPreparation(db, sessionId, receipt.sceneId, true);
      const text = segmentText(preparation, receipt.start, receipt.end);
      if (receipt.sessionId !== sessionId || text !== readText(row, "confirmed_text"))
        throw new PersistenceError("record_invalid", "confirmed speech content mismatch");
      return {
        cycleId: readText(row, "cycle_id"),
        receiptId: readText(row, "receipt_id"),
        text,
        start: receipt.start,
        end: receipt.end,
        confirmedAtMs: Number(row.confirmed_at_ms),
      };
    });
}
