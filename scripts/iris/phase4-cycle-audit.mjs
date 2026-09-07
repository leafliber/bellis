import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const stable = (value) =>
  Array.isArray(value)
    ? `[${value.map(stable).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);

/** Test operator reads the real host DB Worker; this never opens a Core database. */
export async function auditAdoptedCycles(persistence, adoptions, requests, usages, recalls) {
  assert.equal(
    adoptions.length,
    requests.length,
    "every model request must have one durable adoption",
  );
  assert.equal(
    usages.length,
    adoptions.length,
    "every adopted Iris cycle must have a Core Usage ACK",
  );
  const cycles = [];
  const seen = new Set();
  for (const { sessionId, cycleId } of adoptions) {
    assert.ok(!seen.has(cycleId));
    seen.add(cycleId);
    const saved = await persistence.phase4ReadContextManifest(sessionId, cycleId);
    assert.ok(saved, "adopted Manifest must exist in DB Worker");
    const { manifest, manifestDigest } = saved;
    assert.equal(hash(JSON.stringify(manifest)), manifestDigest);
    const request = requests.find((item) => item.cycleId === cycleId);
    assert.ok(request);
    assert.equal(request.requestId, manifest.modelRequestId);
    assert.equal(request.metadata.contextManifestId, manifest.manifestId);
    assert.equal(request.metadata.promptEpoch, manifest.promptEpoch);
    assert.equal(
      hash(
        stable({
          instructions: request.instructions,
          prompt: request.prompt,
          tools: request.tools,
        }),
      ),
      manifest.promptHash,
    );
    assert.ok(manifest.budget.estimatedInputTokens <= manifest.budget.maxInputTokens);
    assert.equal(manifest.providers.length, 1);
    const provider = manifest.providers[0];
    assert.equal(provider.providerId, "iris");
    assert.equal(
      provider.outcome,
      "ok",
      "every continuous cycle must call the real Recall path successfully",
    );
    assert.equal(provider.personaRevision, manifest.persona.revision);
    const usage = usages.find((item) => item.hostCycleId === cycleId);
    assert.ok(usage);
    assert.equal(usage.requestId, provider.requestId);
    assert.equal(usage.personaRevision, manifest.persona.revision);
    assert.deepEqual(usage.returnedBlockIds, provider.returned);
    assert.deepEqual(usage.hostSelectedBlockIds, provider.hostSelected);
    assert.deepEqual(usage.modelVisibleBlockIds, provider.modelVisible);
    const recall = recalls.find((item) => item.requestId === provider.requestId);
    assert.ok(recall, "Manifest must match an actual successful Recall response");
    assert.equal(recall.personaRevision, provider.personaRevision);
    for (const block of manifest.blocks.filter((item) => item.result === "included")) {
      assert.ok(block.sourceRefs.length > 0);
      const source = recall.blocks.find((item) => item.id === block.blockId);
      assert.ok(source);
      assert.equal(block.contentHash, source.contentHash);
      assert.equal(block.revision, source.revision);
      assert.deepEqual(block.sourceRefs, source.sourceRefs);
      assert.match(block.modelTextHash, /^[0-9a-f]{64}$/);
      assert.equal(block.sourceHashScheme, "iris-canonical-v1");
      assert.notEqual(block.sourceHashVerification, "failed");
    }
    cycles.push({
      cycleId,
      manifestId: manifest.manifestId,
      manifestDigest,
      promptEpoch: manifest.promptEpoch,
      personaRevision: manifest.persona.revision,
      personaHash: manifest.persona.contentHash,
      recallPersonaRevision: provider.personaRevision,
      recallRequestId: provider.requestId,
      estimatedInputTokens: manifest.budget.estimatedInputTokens,
      maxInputTokens: manifest.budget.maxInputTokens,
      returned: provider.returned,
      hostSelected: provider.hostSelected,
      modelVisible: provider.modelVisible,
      usageOutboxId: usage.outboxId,
    });
  }
  assert.equal(new Set(cycles.map((item) => item.usageOutboxId)).size, cycles.length);
  return cycles;
}
