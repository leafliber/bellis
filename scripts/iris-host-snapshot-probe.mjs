import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { cp, readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { startRuntime } from "../apps/runtime/dist/index.js";
import { IrisMemoryProvider, checkedIrisFetch } from "../providers/memory-iris/dist/src/index.js";
import { loadInstalledIrisSdk } from "./iris-installed-sdk.mjs";
import { contextInput, waitFor } from "./iris-snapshot-restore-probe.mjs";

export async function closedDirectoryDigest(directory) {
  const files = [];
  const visit = async (relative = "") => {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const name = join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else {
        assert.ok(entry.isFile(), "Closed test backup must not contain special files");
        files.push([
          name,
          createHash("sha256")
            .update(await readFile(join(directory, name)))
            .digest("hex"),
        ]);
      }
    }
  };
  await visit();
  files.sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256").update(JSON.stringify(files)).digest("hex");
}

/** A cold copy of Bellis-owned state, while the external Core keeps newer facts. */
export async function runHostSnapshotProbe(baseUrl, credential, client, directory, schemaVersion) {
  const { AsyncIrisMemoryClient } = await loadInstalledIrisSdk();
  const dataDirectory = join(directory, "host-older-snapshot");
  const backupDirectory = join(directory, "host-closed-backup");
  const newerDirectory = join(directory, "host-newer-retained");
  const sessionId = randomUUID();
  const privacyScope = `space:${credential.space_id}`;
  const canary = `HOST_RESTORE_CANARY_${randomUUID()}`;
  let holdEvents = false,
    lastRecall,
    runtime,
    beforeContext,
    restoredContext;
  const eventRequests = [];
  const transport = checkedIrisFetch(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/events") {
      while (holdEvents) await delay(10, undefined, { signal: init.signal });
      const headers = new Headers(init.headers);
      eventRequests.push({
        cursor: headers.get("last-event-id"),
        eventId: headers.get("x-iris-after-event-id"),
      });
    }
    if (url.pathname === "/v1/recall") lastRecall = JSON.parse(init.body);
    return fetch(input, init);
  });
  const start = () => {
    const iris = new IrisMemoryProvider({
      client: new AsyncIrisMemoryClient(baseUrl, {
        bearerToken: credential.token,
        fetch: transport,
      }),
      minimumCoreSchemaVersion: schemaVersion,
      maximumCoreSchemaVersion: schemaVersion,
      eventPollMs: 25,
      backgroundTimeoutMs: 30000,
    });
    return startRuntime({
      config: {
        runtimeVersion: "0.1.0-host-snapshot-probe",
        dataDirectory,
        port: 0,
        phase2: { enabled: true, sessionId },
        phase3: { enabled: true, sessionId },
      },
      memory: {
        appInstanceId: "host-snapshot-probe",
        agentId: credential.agent_id,
        spaceId: credential.space_id,
        identityScope: "profile:host-snapshot",
        privacyScope,
        privacyRevision: "1",
        publicLabels: [privacyScope],
        scope: { kind: "space", acknowledgeCrossSession: true },
        personaSource: iris,
        providers: [{ provider: iris, hashScheme: "iris-canonical-v1" }],
        actors: () => [{ provider: "bellis-test", externalId: "viewer" }],
        refreshIntervalMs: 60000,
      },
    });
  };
  const state = async () =>
    (
      await runtime.memory.history.phase4ReadProviderState({
        scopeKey: runtime.memory.policyStamp.scopeKey,
        providerId: "iris",
      })
    )?.state;
  const policy = () =>
    runtime.memory.history.phase4ReadMemoryPolicy(runtime.memory.policyStamp.scopeKey);
  const audit = () => {
    const db = new DatabaseSync(join(dataDirectory, "state.db"), { readOnly: true });
    try {
      return {
        manifests: db
          .prepare(
            "SELECT manifest_id, manifest_json, manifest_digest FROM phase4_context_manifests ORDER BY manifest_id",
          )
          .all(),
        outbox: db
          .prepare("SELECT outbox_id, topic, payload_json, status FROM outbox ORDER BY outbox_id")
          .all(),
      };
    } finally {
      db.close();
    }
  };
  try {
    const now = Date.now() * 1000;
    const observed = await client.observeBatch(
      [
        {
          agent_id: credential.agent_id,
          space_id: credential.space_id,
          actor_external_identity_id: credential.actor_external_identity_id,
          role: "user",
          kind: "message.text",
          content: "Trusted backup fixture source.",
          privacy_labels: [privacyScope],
          idempotency_key: randomUUID(),
          occurred_us: now,
          committed_us: now,
          effect_state: "committed",
        },
      ],
      { idempotencyKey: randomUUID() },
    );
    const evidence = [
      {
        source_type: "observation",
        source_id: observed.accepted_observation_ids[0],
        relation: "supports",
        source_authority: "user_statement",
      },
    ];
    const remember = {
      agent_id: credential.agent_id,
      space_id: credential.space_id,
      subject_is_self: true,
      predicate: "probe.host_snapshot",
      value: canary,
      canonical_text: canary,
      privacy_labels: [privacyScope],
      source_authority: "user_statement",
      evidence,
    };
    const rememberKey = { idempotencyKey: randomUUID() };
    const claim = await client.rememberClaim(remember, rememberKey);
    await client.correctClaim(
      claim.claim_id,
      {
        expected_revision: 1,
        mode: "supersede",
        value: canary,
        canonical_text: canary,
        evidence: evidence.map((item) => ({ ...item, relation: "corrects" })),
        reason: "authorized snapshot fixture",
      },
      { idempotencyKey: randomUUID() },
    );
    const baseline = (await client.events({ after: "0", signal: AbortSignal.timeout(5000) })).at(
      -1,
    );
    assert.ok(baseline);
    const resourceRef = `iris:claim:${encodeURIComponent(claim.claim_id)}`;
    runtime = await start();
    await waitFor(async () => (await state())?.eventCursor === baseline.cursor);
    const ingested = await runtime.phase3.ingest({
      schemaVersion: 1,
      id: randomUUID(),
      kind: "danmaku",
      source: "trusted-host-snapshot",
      occurredAt: Date.now(),
      priority: 100,
      payload: { userId: "viewer", text: "Remember preferences" },
    });
    assert.equal(ingested.result, "accepted");
    await waitFor(() =>
      audit().outbox.some((row) => row.topic === "memory.usage.v1" && row.status === "delivered"),
    );
    await waitFor(async () => {
      beforeContext?.dispose();
      beforeContext = await runtime.memory.build(contextInput(), AbortSignal.timeout(5000));
      return beforeContext.request.prompt.includes(canary);
    });
    const originalRecall = structuredClone(lastRecall);
    const originalFacts = audit();
    assert.equal(originalFacts.manifests.length, 1);
    assert.ok(
      JSON.parse(originalFacts.manifests[0].manifest_json).blocks.some(
        (block) =>
          block.result === "included" &&
          block.sourceRefs.some((ref) => ref === resourceRef || ref.startsWith(`${resourceRef}@`)),
      ),
    );
    const originalPolicy = await policy();
    const originalCheckpoint = {
      cursor: (await state()).eventCursor,
      eventId: (await state()).eventId,
    };
    beforeContext.dispose();
    beforeContext = undefined;
    await runtime.close();
    const backupDigest = await closedDirectoryDigest(dataDirectory);
    await cp(dataDirectory, backupDirectory, { recursive: true, errorOnExist: true, force: false });
    assert.equal(await closedDirectoryDigest(backupDirectory), backupDigest);

    const deletion = {
      selector: { kind: "resource", resource_type: "claim", resource_id: claim.claim_id },
      erase_content: true,
      reason: "authorized host backup fixture deletion",
    };
    const deletionKey = { idempotencyKey: randomUUID() };
    const receipt = await client.forgetMemory(deletion, deletionKey);
    assert.equal(receipt.erased_count, 1);
    const deleted = async () =>
      assert.rejects(client.getClaim(claim.claim_id), (error) => error.status === 404);
    await deleted();
    runtime = await start();
    const hasDeletion = async () =>
      (await policy()).tombstones.some(
        (item) => item.resourceRef === resourceRef && item.throughRevision === null,
      );
    await waitFor(hasDeletion);
    await waitFor(async () => !(await state()).pendingResourceInvalidation);
    const currentPolicy = await policy();
    const deletionCheckpoint = {
      cursor: (await state()).eventCursor,
      eventId: (await state()).eventId,
    };
    assert.ok(currentPolicy.generation > originalPolicy.generation);
    assert.ok(BigInt(deletionCheckpoint.cursor) > BigInt(originalCheckpoint.cursor));
    await runtime.close();
    // Both Runtime-owned DB Workers are closed before any directory is copied or moved.
    await rename(dataDirectory, newerDirectory);
    await cp(backupDirectory, dataDirectory, { recursive: true, errorOnExist: true, force: false });
    assert.equal(await closedDirectoryDigest(dataDirectory), backupDigest);
    assert.deepEqual(audit(), originalFacts);

    eventRequests.length = 0;
    holdEvents = true;
    runtime = await start();
    assert.equal((await policy()).generation, originalPolicy.generation);
    assert.equal(await hasDeletion(), false);
    restoredContext = await runtime.memory.build(contextInput(), AbortSignal.timeout(5000));
    assert.equal(restoredContext.request.prompt.includes(canary), false);
    assert.equal(
      restoredContext.adoption.manifest.blocks.some(
        (block) =>
          block.result === "included" &&
          block.sourceRefs.some((ref) => ref === resourceRef || ref.startsWith(`${resourceRef}@`)),
      ),
      false,
    );
    await assert.rejects(
      client.recall({ ...originalRecall, deadline_at: new Date(Date.now() + 5000).toISOString() }),
      (error) => error.status === 409 && error.code === "conflict",
    );
    await assert.rejects(
      client.rememberClaim(remember, rememberKey),
      (error) => error.status === 404 && error.code === "not_found",
    );
    await deleted();
    holdEvents = false;
    await waitFor(hasDeletion);
    await waitFor(
      async () =>
        (await state()).eventCursor === deletionCheckpoint.cursor &&
        !(await state()).pendingResourceInvalidation,
    );
    assert.deepEqual(eventRequests[0], originalCheckpoint);
    assert.equal(restoredContext.signal.aborted, true);
    assert.throws(() => restoredContext.assertCurrent());
    restoredContext.dispose();
    restoredContext = undefined;
    const reconciledPolicy = await policy();
    assert.equal(reconciledPolicy.generation, currentPolicy.generation);
    assert.deepEqual(audit(), originalFacts);
    const usage = originalFacts.outbox.find((row) => row.topic === "memory.usage.v1");
    assert.deepEqual(
      await runtime.memory.publish(
        { outboxId: usage.outbox_id, topic: usage.topic, payload: JSON.parse(usage.payload_json) },
        AbortSignal.timeout(5000),
      ),
      { ok: false, errorCode: "privacy_revoked", retryable: false },
    );
    assert.deepEqual(await client.forgetMemory(deletion, deletionKey), receipt);
    await runtime.close();
    eventRequests.length = 0;
    runtime = await start();
    await waitFor(async () =>
      eventRequests.some(
        (item) =>
          item.cursor === deletionCheckpoint.cursor && item.eventId === deletionCheckpoint.eventId,
      ),
    );
    assert.deepEqual(eventRequests[0], deletionCheckpoint);
    assert.equal((await policy()).generation, reconciledPolicy.generation);
    assert.equal(await hasDeletion(), true);
    assert.equal(runtime.memory.historyRecoveryRequired, false);
    assert.equal(runtime.status.ready, true);
    restoredContext = await runtime.memory.build(contextInput(), AbortSignal.timeout(5000));
    assert.equal(restoredContext.request.prompt.includes(canary), false);
    await deleted();
    assert.deepEqual(audit(), originalFacts);
    return {
      status: "passed",
      backupDigest,
      originalCheckpoint,
      deletionCheckpoint,
      generationBeforeBackup: originalPolicy.generation,
      generationAfterDeletion: currentPolicy.generation,
      exactClosedDirectoryRestored: true,
      canaryVisibleBeforeDeletion: true,
      canaryVisibleAfterRestore: false,
      oldRecallReplay: "409-conflict",
      rememberReplay: "404-not-found-original-key-does-not-resurrect-canonical",
      restoredUsage: "privacy-revoked-after-event-catch-up",
      originalManifestAndOutboxPreserved: true,
      secondRestart: "tombstone-and-checkpoint-stable",
      scope:
        "Bellis cold backup restored after Core Claim deletion; live Recall and original-key replay, normal SSE catch-up. Not every resource type, pending Observe snapshot or Core/Bellis simultaneous restore.",
    };
  } finally {
    holdEvents = false;
    beforeContext?.dispose();
    restoredContext?.dispose();
    await runtime?.close();
  }
}
