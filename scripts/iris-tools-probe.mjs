import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { IrisToolBoundary, freezeIrisToolRequest } from "../providers/memory-iris/dist/src/index.js";
import { runPreparedIrisWriteProbe } from "./iris-prepared-tool-probe.mjs";
import { runCoordinatedForgetProbe } from "./iris-forget-probe.mjs";

/** Public SDK/HTTP transport acceptance. Host Tool Runtime authorization is a separate gate. */
export async function runIrisToolsProbe(baseUrl, credential, client, directory, coreSchemaVersion = 14) {
  const boundary = new IrisToolBoundary({ baseUrl, bearerToken: credential.token });
  const signal = AbortSignal.timeout(20_000);
  const now = Date.now() * 1000;
  const observed = await client.observeBatch([{
    idempotency_key: randomUUID(), agent_id: credential.agent_id, space_id: credential.space_id,
    actor_external_identity_id: credential.actor_external_identity_id,
    role: "user", kind: "message.text", content: "For this test, remember that the agent likes jasmine tea.",
    occurred_us: now, committed_us: now, effect_state: "committed",
    privacy_labels: [`space:${credential.space_id}`],
  }], { signal, idempotencyKey: randomUUID() });
  const source = observed.accepted_observation_ids[0];
  assert.equal(typeof source, "string");
  const remember = freezeIrisToolRequest({ operation: "remember", idempotencyKey: `bellis-tool:${randomUUID()}`, record: {
    agent_id: credential.agent_id, space_id: credential.space_id, subject_is_self: true,
    predicate: "probe.favorite_tea", value: "jasmine tea", canonical_text: "The agent likes jasmine tea.",
    category: "preference", source_authority: "user_statement", privacy_labels: [`space:${credential.space_id}`],
    evidence: [{ source_type: "observation", source_id: source, relation: "supports", source_authority: "user_statement" }],
  } });
  // The server commits and returns success; the caller loses that response.
  let lostResponse = false;
  const lossy = new IrisToolBoundary({ baseUrl, bearerToken: credential.token, transport: async (url, init) => {
    const response = await fetch(url, init);
    if (response.ok && !lostResponse) {
      lostResponse = true;
      await response.body?.cancel();
      throw new Error("injected response loss after server success");
    }
    return response;
  } });
  const prepared = await runPreparedIrisWriteProbe(remember, lossy, directory, baseUrl, credential, coreSchemaVersion);
  assert.equal(lostResponse, true);
  const saved = await boundary.execute(prepared.request, signal);
  const duplicate = await boundary.execute(prepared.request, signal);
  assert.equal(duplicate.claim_id, saved.claim_id);
  assert.equal(duplicate.revision, saved.revision);
  const search = { operation: "memory_search", record: { agent_id: credential.agent_id, space_id: credential.space_id, query: "jasmine tea", limit: 20 } };
  let found = false;
  const searchReasons = new Set();
  for (let i = 0; i < 50; i++) {
    const result = await boundary.execute(search, signal).catch(error => {
      if (error.code === "not_ready" || error.status >= 500) { searchReasons.add(error.reasonCode ?? error.code); return { results: [] }; }
      throw error;
    });
    if (result.results.some(row => row.resource_ref.resource_id === saved.claim_id)) { found = true; break; }
    await delay(100);
  }
  // Preserve this missing gate while still verifying independent write/replay operations.
  const correct = freezeIrisToolRequest({ operation: "correct", claimId: saved.claim_id, idempotencyKey: `bellis-tool:${randomUUID()}`, record: {
    expected_revision: saved.revision, mode: "supersede", value: "oolong tea", canonical_text: "The agent likes oolong tea.", reason: "trusted probe correction",
    evidence: [{ source_type: "observation", source_id: source, relation: "corrects", source_authority: "explicit_correction" }],
  } });
  const corrected = await boundary.execute(correct, signal);
  assert.equal(corrected.revision, saved.revision + 1);
  assert.equal((await boundary.execute(correct, signal)).revision, corrected.revision);
  await assert.rejects(boundary.execute({ ...correct, idempotencyKey: `bellis-tool:${randomUUID()}` }, signal), error => error.status === 409 && error.code !== "tool_outcome_unknown");
  const coordinatedForget = await runCoordinatedForgetProbe(baseUrl, credential, directory, corrected, coreSchemaVersion);
  const forgotten = coordinatedForget.result;
  assert.equal(forgotten.target_count, 1);
  assert.equal(forgotten.erased_count, 1);
  assert.equal(forgotten.protected_skipped, 0);
  assert.equal(forgotten.held_skipped, 0);
  assert.deepEqual(await boundary.execute(coordinatedForget.request, signal), forgotten);
  let after;
  for (let i = 0; i < 50; i++) {
    after = await boundary.execute({ ...search, record: { ...search.record, query: "oolong tea" } }, signal).catch(error => {
      if (error.code === "not_ready" || error.status >= 500) { searchReasons.add(error.reasonCode ?? error.code); return undefined; }
      throw error;
    });
    if (after !== undefined) break;
    await delay(100);
  }
  if (after !== undefined) assert.equal(after.results.some(row => row.resource_ref.resource_id === saved.claim_id), false);
  const deleted = await client.getClaim(saved.claim_id).catch(error => {
    assert.equal(error.status, 404);
    return null;
  });
  assert.ok(deleted === null || deleted.status === "tombstoned");
  return { status: found && after !== undefined ? "passed" : "incomplete", preparedWrite: prepared.evidence, coordinatedForget: coordinatedForget.evidence, searchReasons: [...searchReasons], scope: "Public SDK transport plus trusted prepared remember fixture; production authorization/privacy barriers and Legal Hold not covered", surfaceMode: "off", remember: "accepted-and-original-key-replayed", responseLoss: "unknown-then-original-key-reconciled", search: found ? "remembered-claim-found" : "not-ready-or-missing", correct: "revision-increment-and-original-key-replay", staleRevision: "definite-409-rejection", forget: { target: forgotten.target_count, erased: forgotten.erased_count, protected: forgotten.protected_skipped, held: forgotten.held_skipped, duplicate: "same-result", searchAfter: after === undefined ? "not-ready" : "absent", claimReadAfter: deleted === null ? "not-found" : "tombstoned" } };
}
