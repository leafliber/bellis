import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { writeFile, rename } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { startConfiguredIrisRuntime } from "./start-iris-runtime.mjs";

export async function runCredentialRevocationProbe(
  baseUrl,
  credential,
  directory,
  schemaVersion,
  operatorKey,
  publicClient,
) {
  const headers = { origin: baseUrl, "x-imc-console": "1", "content-type": "application/json" };
  const login = await fetch(`${baseUrl}/console/v1/auth/login`, {
    method: "POST",
    headers,
    body: JSON.stringify({ key: operatorKey }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(login.status, 200, "operator login");
  const session = (await login.json()).data;
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const authenticated = { ...headers, cookie, "x-imc-csrf": session.csrf_token };
  const list = await fetch(`${baseUrl}/console/v1/service-credentials`, {
    headers: authenticated,
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(list.status, 200);
  const target = (await list.json()).data.find((row) => row.id === credential.credential_id);
  assert.ok(target, "test application credential must be listed");
  const dataDirectory = join(directory, "credential-readiness");
  const tokenPath = join(directory, "rotation-token");
  const configPath = join(directory, "rotation-config.json");
  const sessionId = randomUUID();
  const configuration = {
    schemaVersion: 1,
    iris: {
      enabled: true,
      baseUrl,
      allowedOrigins: [baseUrl],
      credential: { kind: "file", path: tokenPath },
      appInstanceId: target.app_instance_id,
      agentId: credential.agent_id,
      spaceId: credential.space_id,
      identityScope: "profile:credential-probe",
      privacyRevision: "1",
      scope: { kind: "space", acknowledgeCrossSession: true },
      actors: [{ provider: "bellis-test", externalId: "viewer" }],
      publicLabels: [`space:${credential.space_id}`],
      coreSchema: { minimum: schemaVersion, maximum: schemaVersion },
      refreshIntervalMs: 100,
    },
    runtime: {
      dataDirectory,
      runtimeVersion: "0.1.0-credential-probe",
      port: 0,
      phase2: { enabled: true, sessionId },
      phase3: { enabled: true, sessionId },
    },
  };
  await writeFile(tokenPath, credential.token + "\n", { mode: 0o600, flag: "wx" });
  await writeFile(configPath, JSON.stringify(configuration), { mode: 0o600, flag: "wx" });
  const facts = () => {
    // Only Bellis' own audit DB is inspected; Core is accessed via public APIs.
    const db = new DatabaseSync(join(dataDirectory, "state.db"), { readOnly: true });
    try {
      return {
        requests: db
          .prepare(
            "SELECT attempt_id, request_json, request_digest FROM phase4_recall_requests ORDER BY attempt_id",
          )
          .all(),
        manifests: db
          .prepare(
            "SELECT manifest_id, manifest_json, manifest_digest FROM phase4_context_manifests ORDER BY manifest_id",
          )
          .all(),
        usage: db
          .prepare(
            "SELECT outbox_id, payload_json, status FROM outbox WHERE topic='memory.usage.v1' ORDER BY outbox_id",
          )
          .all(),
      };
    } finally {
      db.close();
    }
  };
  let runtime = await startConfiguredIrisRuntime(configPath);
  const contextInput = () => ({
    requestId: randomUUID(),
    model: "fixture",
    provider: "fixture",
    tools: [],
    instructions: "Credential probe",
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
  });
  const assertUnavailable = async (oldContext) => {
    const until = Date.now() + 10000;
    while (runtime.status.ready && Date.now() < until) await delay(25);
    assert.equal(runtime.status.phase, "unavailable");
    assert.equal(runtime.memory.readiness.reason, "persona_unavailable");
    assert.equal(oldContext.signal.aborted, true);
    assert.throws(() => oldContext.assertCurrent());
    const origin = `http://127.0.0.1:${runtime.status.port}`;
    assert.equal(
      (
        await fetch(`${origin}/api/v1/health/ready`, {
          headers: { origin },
          signal: AbortSignal.timeout(5000),
        })
      ).status,
      503,
    );
    assert.equal(
      (
        await fetch(`${origin}/api/v1/health/live`, {
          headers: { origin },
          signal: AbortSignal.timeout(5000),
        })
      ).status,
      200,
    );
    await assert.rejects(
      runtime.memory.build(contextInput(), AbortSignal.timeout(5000)),
      (error) => error.message === "persona_not_ready",
    );
  };
  let context;
  try {
    const origin = `http://127.0.0.1:${runtime.status.port}`;
    const ready = () =>
      fetch(`${origin}/api/v1/health/ready`, {
        headers: { origin },
        signal: AbortSignal.timeout(5000),
      });
    assert.equal((await ready()).status, 200);
    const anchor = (
      await publicClient.events({ after: "0", signal: AbortSignal.timeout(5000) })
    ).at(-1)?.cursor;
    if (anchor !== undefined) {
      const until = Date.now() + 10000;
      let checkpoint;
      while (Date.now() < until) {
        checkpoint = await runtime.memory.history.phase4ReadProviderState({
          scopeKey: runtime.memory.policyStamp.scopeKey,
          providerId: "iris",
        });
        if (BigInt(checkpoint?.state.eventCursor ?? "0") >= BigInt(anchor)) break;
        await delay(25);
      }
      assert.ok(
        BigInt(checkpoint?.state.eventCursor ?? "0") >= BigInt(anchor),
        "initial external events must be acknowledged before rotation",
      );
    }

    context = await runtime.memory.build(contextInput(), AbortSignal.timeout(5000));
    const ingested = await runtime.phase3.ingest({
      schemaVersion: 1,
      id: randomUUID(),
      kind: "danmaku",
      source: "trusted-rotation-probe",
      occurredAt: Date.now(),
      priority: 100,
      payload: { userId: "viewer", text: "已确认片段" },
    });
    assert.equal(ingested.result, "accepted");
    const adoptedUntil = Date.now() + 10000;
    let originalFacts;
    while (Date.now() < adoptedUntil) {
      originalFacts = facts();
      if (
        originalFacts.manifests.length === 1 &&
        originalFacts.usage.length === 1 &&
        originalFacts.usage[0].status === "delivered"
      )
        break;
      await delay(50);
    }
    assert.equal(originalFacts.manifests.length, 1, "rotation requires a real adopted Manifest");
    assert.equal(originalFacts.usage.length, 1);
    assert.equal(originalFacts.usage[0].status, "delivered", "original Usage must reach Core ACK");
    assert.ok(originalFacts.requests.length >= 2, "original prepared requests must be retained");
    const reauth = await fetch(`${baseUrl}/console/v1/auth/reauth`, {
      method: "POST",
      headers: authenticated,
      body: JSON.stringify({ key: operatorKey }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(reauth.status, 200, "operator reauthentication");
    assert.equal(context.signal.aborted, false, "context must still be current before rotation");
    context.assertCurrent();
    const rotated = await fetch(
      `${baseUrl}/console/v1/service-credentials/${credential.credential_id}:rotate`,
      {
        method: "POST",
        headers: { ...authenticated, "idempotency-key": randomUUID() },
        body: JSON.stringify({
          expected_revision: target.revision,
          overlap_seconds: 0,
          reason_code: "credential_rotation",
        }),
        signal: AbortSignal.timeout(5000),
      },
    );
    assert.equal(rotated.status, 201, "public credential rotation");
    const successor = (await rotated.json()).data;
    assert.equal(successor.secret_available, true);
    assert.ok(
      typeof successor.secret === "string" && successor.secret.length > 0,
      "new credential must be returned once",
    );
    assert.equal(successor.key.rotated_from_id, credential.credential_id);
    assert.equal(successor.key.app_instance_id, target.app_instance_id);
    await assertUnavailable(context);
    assert.deepEqual(facts(), originalFacts);
    context.dispose();
    context = undefined;
    await runtime.close();
    // Keeping the obsolete file must not reopen the old cached Persona.
    await assert.rejects(
      startConfiguredIrisRuntime(configPath),
      (error) => error.message === "iris_runtime_start_failed",
    );
    assert.deepEqual(facts(), originalFacts);
    const replacement = tokenPath + ".next";
    await writeFile(replacement, successor.secret + "\n", { mode: 0o600, flag: "wx" });
    await rename(replacement, tokenPath);
    runtime = await startConfiguredIrisRuntime(configPath);
    assert.equal(runtime.status.ready, true);
    assert.equal(runtime.memory.readiness.reason, "ready");
    assert.deepEqual(
      facts(),
      originalFacts,
      "restart must retain exact original request/Manifest/Usage records",
    );
    const originalUsage = originalFacts.usage[0];
    const replay = await runtime.memory.publish(
      {
        outboxId: originalUsage.outbox_id,
        topic: "memory.usage.v1",
        payload: JSON.parse(originalUsage.payload_json),
      },
      AbortSignal.timeout(5000),
    );
    assert.equal(replay.ok, true, "successor credential must replay the original Usage identity");
    assert.deepEqual(facts(), originalFacts);
    context = await runtime.memory.build(contextInput(), AbortSignal.timeout(5000));
    assert.equal(context.adoption.manifest.providers[0].outcome, "ok");
    const beforeRevoke = facts();
    assert.equal(
      context.signal.aborted,
      false,
      "new context must still be current before revocation",
    );
    context.assertCurrent();
    const revoked = await fetch(
      `${baseUrl}/console/v1/service-credentials/${successor.key.id}:revoke`,
      {
        method: "POST",
        headers: { ...authenticated, "idempotency-key": randomUUID() },
        body: JSON.stringify({
          expected_revision: successor.key.revision,
          reason_code: "credential_revocation",
        }),
        signal: AbortSignal.timeout(5000),
      },
    );
    assert.equal(revoked.status, 200, "public successor credential revocation");
    await assertUnavailable(context);
    assert.deepEqual(facts(), beforeRevoke);
    return {
      status: "passed",
      authority: "installed-Core-public-console-service-credential-revoke",
      oldContextCancelled: true,
      liveStatus: 200,
      readyBefore: 200,
      readyAfter: 503,
      rotation: {
        status: "passed",
        overlapSeconds: 0,
        obsoleteCredentialRestart: "rejected",
        secretReplacement: "private-file-atomic-rename",
        sameDirectoryRestart: "ready",
        newRecall: "passed",
        originalUsageReplayWithSuccessor: "accepted-same-body-and-id",
        preservedRequests: originalFacts.requests.length,
        preservedManifests: originalFacts.manifests.length,
        preservedAcknowledgedUsage: originalFacts.usage.length,
      },
      personaFallback: "blocked",
      scope:
        "Actual public zero-overlap credential rotation, obsolete-file refusal, private-file replacement, same-directory restart and successor revocation; not overlap rotation, automatic hot reload, cross-process global fencing or every permission-change variant",
    };
  } finally {
    context?.dispose();
    await runtime.close();
  }
}
