import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { auditAdoptedCycles } from "../iris/phase4-cycle-audit.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const request = {
    cycleId: "cycle",
    requestId: "model",
    instructions: "instructions",
    prompt: "prompt",
    tools: [],
    metadata: { promptEpoch: "epoch", contextManifestId: "manifest" },
  };
  const provider = {
    providerId: "iris",
    outcome: "ok",
    requestId: "recall",
    personaRevision: "1",
    returned: ["block"],
    hostSelected: ["block"],
    modelVisible: ["block"],
  };
  const source = {
    id: "block",
    revision: "1",
    contentHash: "short-core-hash",
    sourceRefs: ["iris:claim:one"],
  };
  const manifest = {
    manifestId: "manifest",
    modelRequestId: "model",
    promptEpoch: "epoch",
    promptHash: hash('{"instructions":"instructions","prompt":"prompt","tools":[]}'),
    persona: { revision: "1", contentHash: "persona" },
    budget: { estimatedInputTokens: 10, maxInputTokens: 20 },
    providers: [provider],
    blocks: [
      {
        blockId: "block",
        revision: source.revision,
        contentHash: source.contentHash,
        sourceRefs: source.sourceRefs,
        modelTextHash: "a".repeat(64),
        sourceHashScheme: "iris-canonical-v1",
        sourceHashVerification: "passthrough",
        result: "included",
      },
    ],
  };
  const saved = { manifest, manifestDigest: hash(JSON.stringify(manifest)) };
  const usage = {
    hostCycleId: "cycle",
    requestId: "recall",
    personaRevision: "1",
    returnedBlockIds: ["block"],
    hostSelectedBlockIds: ["block"],
    modelVisibleBlockIds: ["block"],
    outboxId: "usage",
  };
  const recall = { requestId: "recall", personaRevision: "1", blocks: [structuredClone(source)] };
  return {
    saved,
    request,
    usage,
    recall,
    run() {
      return auditAdoptedCycles(
        { phase4ReadContextManifest: async () => saved },
        [{ sessionId: "session", cycleId: "cycle" }],
        [request],
        [usage],
        [recall],
      );
    },
  };
}

test("audit accepts an opaque Core hash only when it matches the actual Recall", async () => {
  const value = fixture();
  assert.equal((await value.run()).length, 1);
  value.recall.blocks[0].contentHash = "changed";
  await assert.rejects(value.run());
});
test("audit rejects a model request that differs from the durable prompt", async () => {
  const value = fixture();
  value.request.prompt += " altered";
  await assert.rejects(value.run());
});
test("audit rejects changed Usage selection even after a successful ACK", async () => {
  const value = fixture();
  value.usage.modelVisibleBlockIds = [];
  await assert.rejects(value.run());
});
test("audit rejects a rewritten Manifest and a valid-digest over-budget Manifest", async () => {
  const value = fixture();
  value.saved.manifest.budget.estimatedInputTokens = 21;
  await assert.rejects(value.run());
  value.saved.manifestDigest = hash(JSON.stringify(value.saved.manifest));
  await assert.rejects(value.run());
});
test("audit rejects a valid-digest Persona/Recall revision mismatch", async () => {
  const value = fixture();
  value.saved.manifest.persona.revision = "2";
  value.saved.manifestDigest = hash(JSON.stringify(value.saved.manifest));
  await assert.rejects(value.run());
});
