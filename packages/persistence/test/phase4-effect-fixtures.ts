import { createHash, randomUUID } from "node:crypto";
import {
  ScenePlanSchema,
  ContextManifestSchema,
  type StageEffectReceipt,
  type AudioSegmentBinding,
  type MemoryPolicyStamp,
  type MemoryOutputTarget,
} from "@bellis/contracts";
import type { PersistenceClient } from "../src/index.js";
import { context } from "./phase4-fixtures.js";
import { SESSION_ID, TRACE } from "./helpers.js";
export const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export const target = {
  providerId: "iris",
  agentId: "agent",
  spaceId: "space",
  sourceStream: "output",
  privacyLabels: ["space:space"],
};
export function fixture(lane: "audio" | "subtitle" = "audio", segmentCount = 2) {
  const cueId = randomUUID();
  const text = segmentCount === 2 ? "第一句。第二句。" : "\0".repeat(2000);
  const plan = ScenePlanSchema.parse({
    schemaVersion: 1,
    scene: {
      schemaVersion: 1,
      sceneId: randomUUID(),
      cycleId: randomUUID(),
      groups: [{ schemaVersion: 1, groupId: randomUUID(), lanes: [lane], level: "hard" }],
      deadlineMs: 500,
      interruptPolicy: "fade",
    },
    speech: { schemaVersion: 1, text, purpose: "answer", interruptible: true },
    cues: [
      {
        schemaVersion: 1,
        cueId,
        lane,
        anchor: "scene_start",
        offsetMs: 0,
        intent: { speechRef: "plan" },
      },
    ],
    effects: {
      schemaVersion: 1,
      sessionId: SESSION_ID,
      connectionGeneration: randomUUID(),
      contentHash: hash(text),
      textLength: text.length,
      segments: Array.from({ length: segmentCount }, (_, index) => {
        const start = segmentCount === 2 ? index * 4 : index;
        const end =
          segmentCount === 2 ? start + 4 : index === segmentCount - 1 ? text.length : index + 1;
        return {
          segmentId: randomUUID(),
          cueId,
          lane,
          start,
          end,
          textHash: hash(text.slice(start, end)),
        };
      }),
    },
  });
  const effects = plan.effects!;
  const streamId = randomUUID();
  return {
    plan,
    preparation: { schemaVersion: 1 as const, plan, targets: [target] as MemoryOutputTarget[] },
    binding(index = 0): AudioSegmentBinding {
      return {
        schemaVersion: 1,
        sessionId: SESSION_ID,
        connectionGeneration: effects.connectionGeneration,
        sceneId: plan.scene.sceneId,
        cueId,
        segmentId: effects.segments[index]!.segmentId,
        contentHash: effects.contentHash,
        streamId,
        sampleRateHz: 48000,
        startSample: index * 1920,
        endSample: (index + 1) * 1920,
      };
    },
    receipt(index = 0): StageEffectReceipt {
      const common = {
        schemaVersion: 1 as const,
        sessionId: SESSION_ID,
        connectionGeneration: effects.connectionGeneration,
        sceneId: plan.scene.sceneId,
        cueId,
        segmentId: effects.segments[index]!.segmentId,
        contentHash: effects.contentHash,
        receiptId: randomUUID(),
        start: effects.segments[index]!.start,
        end: effects.segments[index]!.end,
        appliedAtStageUs: "20000",
      };
      return lane === "audio"
        ? {
            ...common,
            lane,
            boundary: "worklet_rendered",
            streamId,
            renderedSamples: (index + 1) * 1920,
          }
        : { ...common, lane, boundary: "subtitle_applied" };
    },
  };
}
export async function adopt(
  client: PersistenceClient,
  f: ReturnType<typeof fixture>,
  index = 0,
  policy?: MemoryPolicyStamp,
) {
  const adopted = context(f.plan.scene.cycleId);
  adopted.usage = [];
  adopted.manifest.providers = [];
  if (policy !== undefined) adopted.manifest.policy = policy;
  adopted.manifest = ContextManifestSchema.parse(adopted.manifest);
  adopted.manifestDigest = hash(JSON.stringify(adopted.manifest));
  await client.phase3AdoptCycle({
    sessionId: SESSION_ID,
    cycleId: f.plan.scene.cycleId,
    turnId: randomUUID(),
    batchId: randomUUID(),
    cycleIndex: index,
    watermarkFrom: BigInt(index + 1),
    watermarkTo: BigInt(index + 1),
    next: "finish",
    degraded: false,
    packetDigest: "d".repeat(64),
    toolRuns: [],
    context: adopted,
    trace: TRACE,
  });
}
export async function commit(client: PersistenceClient, f: ReturnType<typeof fixture>) {
  await client.commitScene({
    sessionId: SESSION_ID,
    sceneId: f.plan.scene.sceneId,
    cycleId: f.plan.scene.cycleId,
    scene: f.plan.scene,
    plan: f.plan,
    idempotencyKey: f.plan.scene.sceneId,
    requestFingerprint: hash(JSON.stringify(f.plan)),
    watermarks: [],
    outbox: [],
    trace: TRACE,
  });
}
export const confirm = (client: PersistenceClient, receipt: StageEffectReceipt) =>
  client.phase4ConfirmEffect({
    sessionId: SESSION_ID,
    connectionGeneration: receipt.connectionGeneration,
    receipt,
  });
