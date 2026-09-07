import { isMemoryResourceBlocked } from "../../packages/contracts/dist/index.js";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createPersistenceClient } from "../../packages/persistence/dist/index.js";
import { Phase4MemoryHost } from "../../apps/runtime/dist/index.js";
import { IrisMemoryProvider, checkedIrisFetch } from "../../providers/memory-iris/dist/src/index.js";

/** External public deletion -> Core Worker SSE -> Provider durable pending -> host tombstone. */
export async function runResourceInvalidationProbe(
  baseUrl,
  credential,
  client,
  directory,
  schemaVersion,
  options = {},
) {
  const dataDirectory = join(
      directory,
      options.correction ? "bellis-external-correction" : "bellis-external-invalidation",
    ),
    sessionId = randomUUID();
  let persistence = createPersistenceClient({ dataDirectory });
  const appInstanceId = "external-invalidation-probe",
    identityScope = "profile:probe",
    privacyScope = `space:${credential.space_id}`;
  const providerScope = createHash("sha256")
    .update(
      JSON.stringify([
        appInstanceId,
        credential.agent_id,
        credential.space_id,
        identityScope,
        privacyScope,
      ]),
    )
    .digest("hex");
  const iris = new IrisMemoryProvider({
    baseUrl,
    bearerToken: credential.token,
    minimumCoreSchemaVersion: schemaVersion,
    maximumCoreSchemaVersion: schemaVersion,
    eventPollMs: 25,
  });
  let stops = 0,
    prepared,
    resumeWorker;
  const memory = new Phase4MemoryHost(
    {
      appInstanceId,
      agentId: credential.agent_id,
      spaceId: credential.space_id,
      identityScope,
      privacyScope,
      privacyRevision: "1",
      publicLabels: [privacyScope],
      scope: { kind: "space", acknowledgeCrossSession: true },
      personaSource: iris,
      providers: [{ provider: iris, hashScheme: "iris-canonical-v1" }],
      actors: () => [{ provider: "bellis-test", externalId: "viewer" }],
    },
    sessionId,
    persistence,
    async () => {
      stops++;
    },
  );
  try {
    await persistence.migrate();
    await persistence.ensureSession({
      sessionId,
      createdAtMs: Date.now(),
      trace: { traceId: "1".repeat(32) },
    });
    await memory.start();
    const now = Date.now() * 1000;
    const observed = await client.observeBatch(
      [
        {
          agent_id: credential.agent_id,
          space_id: credential.space_id,
          actor_external_identity_id: credential.actor_external_identity_id,
          role: "user",
          kind: "message.text",
          content: "The probe agent likes white tea.",
          privacy_labels: [privacyScope],
          idempotency_key: randomUUID(),
          occurred_us: now,
          committed_us: now,
          effect_state: "committed",
        },
      ],
      { idempotencyKey: randomUUID() },
    );
    const claim = await client.rememberClaim(
      {
        agent_id: credential.agent_id,
        space_id: credential.space_id,
        subject_is_self: true,
        predicate: "probe.external_tea",
        value: "white tea",
        canonical_text: "The probe agent likes white tea.",
        privacy_labels: [privacyScope],
        source_authority: "user_statement",
        evidence: [
          {
            source_type: "observation",
            source_id: observed.accepted_observation_ids[0],
            relation: "supports",
            source_authority: "user_statement",
          },
        ],
      },
      { idempotencyKey: randomUUID() },
    );
    // Consume prior events from other sub-probes before freezing the old Context.
    await delay(250);
    const contextRequest = {
      requestId: randomUUID(),
      model: "fixture",
      provider: "fixture",
      tools: [],
      instructions: "External invalidation fixture",
      snapshot: {
        schemaVersion: 1,
        turnId: randomUUID(),
        cycleId: randomUUID(),
        cycleIndex: 0,
        maxCyclesPerTurn: 4,
        batch: {
          schemaVersion: 1,
          id: randomUUID(),
          watermarkFrom: "0",
          watermarkTo: "0",
          highlights: [],
          topics: [],
          urgentSignals: [],
          tokenEstimate: 0,
        },
        pendingToolResults: [],
        recentSpeech: [],
        toolResultsTruncated: false,
      },
    };
    prepared = await memory.build(contextRequest, new AbortController().signal);
    const before = memory.policyStamp.generation;
    let replayRequest, originalUsage, originalUsageAck;
    const checkBatch = async (expected) => {
      const response = await checkedIrisFetch()(`${baseUrl}/v1/recall:revalidate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          schema_version: 1,
          deadline_at: new Date(Date.now() + 10000).toISOString(),
          requests: [{ ...replayRequest, deadline_at: "2000-01-01T00:00:00Z" }],
        }),
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.deepEqual(result.results, [{ request_id: replayRequest.request_id, status: expected }]);
      assert.equal(result.schema_version, 1);
      assert.ok(Number.isFinite(Date.parse(result.checked_at)));
      assert.equal(JSON.stringify(result).includes(claim.claim_id), false);
    };
    if (options.revalidateRecall) {
      replayRequest = {
        schema_version: 1,
        request_id: randomUUID(),
        scope: { agent_id: credential.agent_id, space_id: credential.space_id },
        actors: [{ provider: "bellis-test", external_id: "viewer" }],
        topic: "white tea",
        purpose: "reply",
        token_budget: 16000,
        deadline_at: new Date(Date.now() + 10000).toISOString(),
        allow_partial: true,
      };
      const first = await client.recall(replayRequest);
      assert.ok(first.candidates.some((item) => item.resource_ref.resource_id === claim.claim_id));
      const unchanged = await client.recall({ ...replayRequest, deadline_at: new Date(Date.now() + 10000).toISOString() });
      assert.deepEqual(unchanged.candidates, first.candidates);
      originalUsage = {
        host_cycle_id: randomUUID(),
        persona_revision: first.persona_revision,
        returned_candidate_ids: first.candidates.map((item) => item.candidate_id),
        host_selected_candidate_ids: [],
        model_visible_candidate_ids: [],
        reported_at: new Date().toISOString(),
      };
      originalUsageAck = await client.reportRecallUsage(replayRequest.request_id, originalUsage, { idempotencyKey: `usage:${replayRequest.request_id}` });
      if (options.revalidateBatch) await checkBatch("valid");
    }
    if (options.correction) {
      resumeWorker = await options.pauseWorker();
      const input = {
        expected_revision: 1,
        mode: "supersede",
        value: "black tea",
        canonical_text: "The probe agent likes black tea.",
        evidence: [
          {
            source_type: "observation",
            source_id: observed.accepted_observation_ids[0],
            relation: "corrects",
            source_authority: "user_statement",
          },
        ],
        reason: "authorized public correction probe",
      };
      const key = { idempotencyKey: randomUUID() };
      const corrected = await client.correctClaim(claim.claim_id, input, key);
      assert.equal(corrected.revision, 2);
      assert.equal((await client.correctClaim(claim.claim_id, input, key)).revision, 2);
      if (options.revalidateRecall) {
        await assert.rejects(
          client.recall({ ...replayRequest, deadline_at: new Date(Date.now() + 10000).toISOString() }),
          (error) => error.status === 409 && error.code === "conflict",
        );
        const replayedUsage = await client.reportRecallUsage(replayRequest.request_id, originalUsage, { idempotencyKey: `usage:${replayRequest.request_id}` });
        assert.equal(replayedUsage.report_id, originalUsageAck.report_id);
        assert.deepEqual(replayedUsage.stages, originalUsageAck.stages);
        if (options.revalidateBatch) await checkBatch("unavailable");
      }
    } else {
      const deleted = await client.forgetMemory(
        {
          selector: { kind: "resource", resource_type: "claim", resource_id: claim.claim_id },
          erase_content: true,
          reason: "external authorized probe cleanup",
        },
        { idempotencyKey: randomUUID() },
      );
      assert.equal(deleted.erased_count, 1);
    }
    const resourceRef = `iris:claim:${encodeURIComponent(claim.claim_id)}`;
    let policy, metadata;
    for (let index = 0; index < 400; index++) {
      policy = await persistence.phase4ReadMemoryPolicy(memory.policyStamp.scopeKey);
      metadata = await persistence.phase4ReadProviderState({
        scopeKey: providerScope,
        providerId: "iris",
      });
      if (
        policy.tombstones.some((item) => item.resourceRef === resourceRef) &&
        metadata?.state.eventCursor &&
        !metadata.state.pendingResourceInvalidation
      )
        break;
      await delay(25);
    }
    if (
      !policy.tombstones.some(
        (item) =>
          item.resourceRef === resourceRef &&
          item.throughRevision === (options.correction ? "1" : null),
      )
    ) {
      const events = await client.events({ after: "0" });
      const capabilities = await client.negotiate(["v1"]);
      console.error(
        "resource-invalidation diagnostic",
        JSON.stringify({
          eventTypes: events.map((item) => item.event_type),
          targetEventFound: events.some((item) =>
            item.resource_refs.some((ref) => ref.resource_id === claim.claim_id),
          ),
          eventsCapability: capabilities.capabilities.includes("events.sse.v1"),
          policyGeneration: policy.generation,
          adapterCursor: metadata?.state.eventCursor,
          pending: metadata?.state.pendingResourceInvalidation,
          stops,
        }),
      );
    }
    assert.ok(
      policy.tombstones.some(
        (item) =>
          item.resourceRef === resourceRef &&
          item.throughRevision === (options.correction ? "1" : null),
      ),
    );
    assert.ok(policy.generation > before);
    assert.equal(policy.blocked, false);
    assert.equal(prepared.signal.aborted, true);
    assert.ok(stops > 0);
    const events = await client.events({ after: "0" });
    const delivered = events.find(
      (event) =>
        event.event_type === "revision.invalidated.v1" &&
        event.resource_refs.some(
          (ref) => ref.resource_type === "claim" && ref.resource_id === claim.claim_id,
        ),
    );
    assert.ok(delivered);
    assert.ok(BigInt(metadata.state.eventCursor) >= BigInt(delivered.cursor));
    if (options.correction) {
      assert.equal(
        delivered.resource_refs.find((ref) => ref.resource_id === claim.claim_id).revision,
        1,
      );
      assert.equal(events.filter((event) => event.event_id === delivered.event_id).length, 1);
      assert.equal(isMemoryResourceBlocked(policy.tombstones, "iris", [resourceRef], "1"), true);
      assert.equal(isMemoryResourceBlocked(policy.tombstones, "iris", [resourceRef], "2"), false);
      assert.equal((await client.getClaim(claim.claim_id)).revision, 2);
      await resumeWorker();
      resumeWorker = undefined;
      let included = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        const fresh = await memory.build(
          {
            ...contextRequest,
            requestId: randomUUID(),
            snapshot: { ...contextRequest.snapshot, cycleId: randomUUID() },
          },
          new AbortController().signal,
        );
        try {
          included = fresh.adoption.manifest.blocks.some(
            (block) =>
              block.providerId === "iris" &&
              block.result === "included" &&
              block.revision === "2" &&
              block.sourceRefs.some(
                (ref) => ref === resourceRef || ref.startsWith(`${resourceRef}@`),
              ),
          );
          assert.equal(
            fresh.adoption.manifest.blocks.some(
              (block) =>
                block.providerId === "iris" &&
                block.result === "included" &&
                block.revision === "1" &&
                block.sourceRefs.some(
                  (ref) => ref === resourceRef || ref.startsWith(`${resourceRef}@`),
                ),
            ),
            false,
          );
          if (included) assert.ok(fresh.request.prompt.includes("black tea"));
        } finally {
          fresh.dispose?.();
        }
        if (included) break;
        await delay(100);
      }
      assert.ok(included, "Corrected revision must reach the next model-visible Context");
    } else {
      await assert.rejects(client.getClaim(claim.claim_id), (error) => error.status === 404);
    }
    prepared.dispose();
    await memory.stop();
    await persistence.close();
    persistence = createPersistenceClient({ dataDirectory });
    await persistence.migrate();
    assert.deepEqual(await persistence.phase4ReadMemoryPolicy(policy.scopeKey), policy);
    const recovered = await persistence.phase4ReadProviderState({
      scopeKey: providerScope,
      providerId: "iris",
    });
    assert.ok(BigInt(recovered.state.eventCursor) >= BigInt(delivered.cursor));
    const currentEvents = await client.events({ after: "0" });
    assert.equal(
      currentEvents.find((event) => event.cursor === recovered.state.eventCursor)?.event_id,
      recovered.state.eventId,
    );
    assert.equal(typeof recovered.state.eventId, "string");
    return {
      status: "passed",
      source: options.correction
        ? "external-public-correct-canonical-transaction-SSE"
        : "external-public-Forget-and-real-Core-Worker-SSE",
      eventType: delivered.event_type,
      durableCursor: recovered.state.eventCursor,
      contextCancelled: true,
      permanentTombstone: !options.correction,
      ...(options.correction
        ? {
            throughRevision: "1",
            newRevisionAllowed: true,
            correctedRevisionModelVisible: true,
            coreWorkerStoppedDuringCorrectionAndHostAck: true,
            originalKeyReplayEvents: 1,
            ...(options.revalidateRecall ? { recallReplay: "unchanged-replay-stable-corrected-replay-409", originalUsage: "same-report-id-and-counts-after-rejected-recall" } : {}),
            ...(options.revalidateBatch ? { batchRevalidation: "public-http-valid-before-correction-unavailable-after-original-deadline-expired-no-body-returned" } : {}),
          }
        : {}),
      workerRestart: "policy-and-provider-cursor-preserved",
      generationBefore: before,
      generationAfter: policy.generation,
      stops,
      scope: options.correction
        ? "Public Claim supersede while Core Worker is stopped -> finite old-revision tombstone and Context cancellation; not full history revalidation or other resource update notifications"
        : "Received public deletion event only; no SSE history-gap or ordinary-correction notification proof",
    };
  } finally {
    await resumeWorker?.();
    prepared?.dispose();
    await memory.stop();
    await persistence.close();
  }
}
