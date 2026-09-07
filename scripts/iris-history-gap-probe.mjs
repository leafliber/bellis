import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadInstalledIrisSdk } from "./iris-installed-sdk.mjs";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { createPersistenceClient } from "../packages/persistence/dist/index.js";
import { Phase4MemoryHost, startRuntime } from "../apps/runtime/dist/index.js";
import {
  IrisMemoryProvider,
  IrisRecallVerifier,
  checkedIrisFetch,
} from "../providers/memory-iris/dist/src/index.js";

/** Production Provider sends an intentionally divergent persisted identity to Core. */
export async function runHistoryGapProbe(baseUrl, credential, client, directory, schemaVersion) {
  const { metadata, modulePath, AsyncIrisMemoryClient } = await loadInstalledIrisSdk();
  const anchor = (await client.events({ after: "0", signal: AbortSignal.timeout(5000) })).at(-1);
  assert.ok(anchor, "Public invalidation probe must create an event anchor");
  const original = { eventCursor: anchor.cursor, eventId: `divergent-history:${randomUUID()}` };
  const dataDirectory = join(directory, "bellis-history-gap");
  const sessionId = randomUUID(),
    appInstanceId = "history-gap-probe",
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
  let persistence = createPersistenceClient({ dataDirectory }),
    memory,
    built,
    recoveryVerifier,
    recoveryWorker,
    maintenanceMemory,
    maintenanceRuntime;
  let verificationCalls = 0;
  let releaseEvents,
    eventCalls = 0,
    responseStatus,
    observedRecallBody,
    stops = 0;
  const held = new Promise((resolve) => {
    releaseEvents = resolve;
  });
  const candidate = new AsyncIrisMemoryClient(baseUrl, {
    bearerToken: credential.token,
    fetch: checkedIrisFetch(async (input, init) => {
      if (new URL(String(input)).pathname === "/v1/recall")
        observedRecallBody = JSON.parse(init.body);
      const response = await fetch(input, init);
      if (new URL(String(input)).pathname.endsWith("/v1/events")) responseStatus = response.status;
      return response;
    }),
  });
  const port = new Proxy(candidate, {
    get(target, key) {
      if (key === "events")
        return async (options) => {
          eventCalls++;
          await held;
          assert.equal(options.after, original.eventCursor);
          assert.equal(options.afterEventId, original.eventId);
          return target.events(options);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const makeMemoryOptions = () => {
    const iris = new IrisMemoryProvider({
      client: port,
      minimumCoreSchemaVersion: schemaVersion,
      maximumCoreSchemaVersion: schemaVersion,
      eventPollMs: 25,
    });
    return {
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
    };
  };
  const makeMemory = () =>
    new Phase4MemoryHost(makeMemoryOptions(), sessionId, persistence, async () => {
      stops++;
    });
  const startMaintenanceRuntime = async () => {
    const historyRecovery = { verifiers: [recoveryVerifier], intervalMs: 100, timeoutMs: 10000 };
    maintenanceRuntime = await startRuntime({
      memory: { ...makeMemoryOptions(), historyRecovery },
      persistenceClient: persistence,
      config: {
        dataDirectory,
        runtimeVersion: "0.1.0-history-recovery",
        port: 0,
        phase2: { enabled: true, sessionId },
        phase3: { enabled: true, sessionId },
      },
    });
    maintenanceMemory = maintenanceRuntime.memory;
    recoveryWorker = maintenanceMemory.startHistoryRecovery(recoveryVerifier, historyRecovery);
    assert.equal(maintenanceRuntime.status.phase, "recovering");
    assert.equal(maintenanceRuntime.phase3, null);
    const origin = `http://127.0.0.1:${maintenanceRuntime.status.port}`;
    assert.equal(
      (await fetch(`${origin}/api/v1/health/live`, { headers: { origin } })).status,
      200,
    );
    assert.equal(
      (await fetch(`${origin}/api/v1/health/ready`, { headers: { origin } })).status,
      503,
    );
    assert.equal(
      (
        await fetch(`${origin}/api/v1/auth/exchange`, {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({ startupToken: maintenanceRuntime.issueStartupToken().token }),
        })
      ).status,
      503,
    );
  };
  const request = {
    requestId: randomUUID(),
    model: "fixture",
    provider: "fixture",
    tools: [],
    instructions: "History-gap fixture",
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
  const outbox = () => {
    const db = new DatabaseSync(join(dataDirectory, "state.db"), { readOnly: true });
    try {
      return db
        .prepare(
          "SELECT outbox_id, topic, payload_json, attempts, status FROM outbox ORDER BY outbox_id",
        )
        .all();
    } finally {
      db.close();
    }
  };
  try {
    await persistence.migrate();
    await persistence.ensureSession({
      sessionId,
      createdAtMs: Date.now(),
      trace: { traceId: "1".repeat(32) },
    });
    await persistence.phase4WriteProviderState({
      scopeKey: providerScope,
      providerId: "iris",
      expectedRevision: 0,
      state: { version: 1, sourceCursors: {}, personaCache: {}, pending: [], ...original },
    });
    memory = makeMemory();
    await memory.start();
    built = await memory.build(request, new AbortController().signal);
    assert.ok(
      built.adoption?.usage.length,
      `Real Recall must create original Usage: ${JSON.stringify(built.adoption?.manifest.providers)}`,
    );
    await persistence.phase3AdoptCycle({
      sessionId,
      cycleId: request.snapshot.cycleId,
      turnId: request.snapshot.turnId,
      batchId: request.snapshot.batch.id,
      cycleIndex: 0,
      watermarkFrom: 0n,
      watermarkTo: 0n,
      next: "finish",
      degraded: false,
      packetDigest: "d".repeat(64),
      toolRuns: [],
      context: built.adoption,
      trace: { traceId: "1".repeat(32) },
    });
    const before = outbox();
    assert.ok(before.length > 0);
    releaseEvents();
    let policy, state;
    for (let n = 0; n < 200; n++) {
      policy = await persistence.phase4ReadMemoryPolicy(memory.policyStamp.scopeKey);
      state = (
        await persistence.phase4ReadProviderState({ scopeKey: providerScope, providerId: "iris" })
      ).state;
      if (policy.historyBlocked && state.historyGap && built.signal.aborted) break;
      await delay(25);
    }
    assert.equal(responseStatus, 410);
    assert.equal(policy.historyBlocked, true);
    assert.equal(policy.generation, 0);
    assert.equal(state.historyGap.cursor, original.eventCursor);
    assert.equal(state.historyGap.eventId, original.eventId);
    assert.equal(state.eventCursor, original.eventCursor);
    assert.equal(state.eventId, original.eventId);
    assert.equal(built.signal.aborted, true);
    assert.ok(stops > 0);
    assert.deepEqual(outbox(), before);
    assert.deepEqual(
      await persistence.claimOutbox({ limit: 10, leaseMs: 1000, ownerInstanceId: "gap" }),
      [],
    );
    await assert.rejects(
      memory.build(request, new AbortController().signal),
      /memory_privacy_blocked/,
    );
    const inventory = await persistence.phase4BeginHistoryInventory({
      runId: randomUUID(),
      scopeKey: policy.scopeKey,
      providerId: "iris",
      gapId: state.historyGap.gapId,
      generation: policy.generation,
    });
    const kinds = [],
      savedRequests = [];
    for (let after = 0; after < inventory.itemCount; after++) {
      const page = await persistence.phase4ReadHistoryInventoryPage({
        runId: inventory.runId,
        after,
        limit: 1,
      });
      assert.equal(page.items.length, 1);
      const descriptor = page.items[0];
      const item = await persistence.phase4ReadHistoryInventoryItem({
        runId: inventory.runId,
        ordinal: descriptor.ordinal,
      });
      assert.equal(
        createHash("sha256").update(JSON.stringify(item.body)).digest("hex"),
        descriptor.digest,
      );
      kinds.push(item.kind);
      if (item.kind === "recall_request") savedRequests.push(item);
    }
    assert.deepEqual(kinds, ["manifest", "provider_state", "recall_request", "usage"]);
    assert.equal(savedRequests.length, 1);
    await memory.stop();
    await persistence.close();
    persistence = createPersistenceClient({ dataDirectory });
    await persistence.migrate();
    assert.deepEqual(await persistence.phase4ReadMemoryPolicy(policy.scopeKey), policy);
    memory = makeMemory();
    await assert.rejects(memory.start(), (error) => error.code === "history_unavailable");
    assert.equal(eventCalls, 1);
    assert.deepEqual(outbox(), before);
    const recoveredInventory = await persistence.phase4ReadHistoryInventoryPage({
      runId: inventory.runId,
      after: inventory.itemCount,
      limit: 64,
    });
    assert.deepEqual(recoveredInventory.inventory, inventory);
    assert.equal(recoveredInventory.done, true);
    assert.equal((await persistence.phase4ReadMemoryPolicy(policy.scopeKey)).historyBlocked, true);
    const recoveredRequest = await persistence.phase4ReadHistoryInventoryItem({
      runId: inventory.runId,
      ordinal: savedRequests[0].ordinal,
    });
    assert.deepEqual(recoveredRequest, savedRequests[0]);
    assert.deepEqual(recoveredRequest.body.request.body, observedRecallBody);
    const makeVerifier = () =>
      new IrisRecallVerifier({
        baseUrl,
        bearerToken: credential.token,
        agentId: credential.agent_id,
        spaceId: credential.space_id,
        minimumCoreSchemaVersion: schemaVersion,
        maximumCoreSchemaVersion: schemaVersion,
        fetch: async (input, init) => {
          if (new URL(String(input)).pathname === "/v1/recall:revalidate") {
            verificationCalls++;
            assert.deepEqual(JSON.parse(init.body).requests, [observedRecallBody]);
          }
          return fetch(input, init);
        },
      });
    const waitBackground = async (minimumAttempts = 1) => {
      const until = Date.now() + 10000;
      while (Date.now() < until) {
        const status = recoveryWorker.status;
        if (!status.pending && status.attempts >= minimumAttempts && status.lastResult)
          return status.lastResult;
        await delay(20);
      }
      throw new Error("history background verification timed out");
    };
    recoveryVerifier = makeVerifier();
    await startMaintenanceRuntime();
    const verificationProgress = await waitBackground();
    assert.deepEqual(verificationProgress, {
      runId: inventory.runId,
      inventoryDigest: inventory.inventoryDigest,
      validRequests: 1,
      unavailableRequests: 0,
      uncheckedItems: 3,
      status: "incomplete",
    });
    assert.equal(verificationCalls, 1);
    assert.deepEqual(await waitBackground(2), verificationProgress);
    assert.equal(verificationCalls, 1);
    const verifiedPage = await persistence.phase4ReadHistoryVerificationPage({
      runId: inventory.runId,
      after: 0,
      limit: 64,
    });
    const recordedVerdicts = verifiedPage.items
      .filter((item) => item.verification !== null)
      .map((item) => item.verification);
    assert.equal(recordedVerdicts.length, 1);
    assert.equal(recordedVerdicts[0].requestId, recoveredRequest.body.request.requestId);
    assert.equal(recordedVerdicts[0].status, "valid");
    recoveryWorker.stop();
    await maintenanceRuntime.close();
    recoveryVerifier.stop();
    assert.equal(verifiedPage.items.filter((item) => item.verification === null).length, 3);
    await memory.stop();
    await persistence.close();
    persistence = createPersistenceClient({ dataDirectory });
    await persistence.migrate();
    assert.deepEqual(
      await persistence.phase4ReadHistoryVerificationPage({
        runId: inventory.runId,
        after: 0,
        limit: 64,
      }),
      verifiedPage,
    );
    recoveryVerifier = makeVerifier();
    await startMaintenanceRuntime();
    assert.deepEqual(await waitBackground(), verificationProgress);
    assert.equal(verificationCalls, 1);
    memory = makeMemory();
    await assert.rejects(memory.start(), (error) => error.code === "history_unavailable");
    assert.equal(eventCalls, 1);
    assert.deepEqual(outbox(), before);
    assert.equal((await persistence.phase4ReadMemoryPolicy(policy.scopeKey)).historyBlocked, true);

    return {
      status: "passed",
      coreResponseStatus: responseStatus,
      providerCheckpoint: original,
      gapId: state.historyGap.gapId,
      contextCancelled: true,
      historyInventory: {
        itemCount: inventory.itemCount,
        inventoryDigest: inventory.inventoryDigest,
        kinds,
        originalBodiesVerified: true,
        restart: "same-inventory-gap-still-blocked",
        storedRecallRequest: "actual-prepared-body-restored-and-publicly-revalidated",
        recallVerdict: "valid-gap-remains-blocked",
        durableVerification: "background-worker-durable-discovery-restart-resume-passed",
        backgroundRecovery: "automatic-polling-one-public-request-and-restart-reuse",
        runtimeRecovery:
          "bootstrap-maintenance-live-200-ready-auth-503-no-decision-pipeline-restart-reuse",
        uncheckedInventoryItems: 3,
        remoteRevalidation: "incomplete",
      },
      hostAndProviderState: "durable-across-worker-restart",
      retainedOriginalUsageRows: before.length,
      newEventRequestsAfterGap: 0,
      restart: "original-gap-reported-before-persona-or-events",
      productionSdk: metadata.version,
      checkpointSource: "Provider persisted pair; probe does not alter SDK options",
      productionSdkSha256: createHash("sha256")
        .update(await readFile(modulePath))
        .digest("hex"),
      scope:
        "Production Provider persisted checkpoint -> installed SDK -> Core 410 -> Provider error handler -> MemoryHost/DB Worker barrier; intentionally seeded divergent identity, not an actual old Core backup restore or full public revalidation",
    };
  } finally {
    releaseEvents();
    recoveryWorker?.stop();
    await maintenanceRuntime?.close();
    await maintenanceMemory?.stop();
    recoveryVerifier?.stop();
    built?.dispose();
    await memory?.stop();
    await persistence.close();
  }
}
