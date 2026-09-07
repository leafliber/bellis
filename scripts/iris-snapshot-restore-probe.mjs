import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { loadInstalledIrisSdk } from "./iris-installed-sdk.mjs";
import { startRuntime } from "../apps/runtime/dist/index.js";
import {
  IrisMemoryProvider,
  IrisRecallVerifier,
  checkedIrisFetch,
} from "../providers/memory-iris/dist/src/index.js";

export const waitFor = async (check) => {
  const deadline = Date.now() + 15000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "Snapshot probe condition timed out");
    await delay(25);
  }
};

export const contextInput = () => ({
  requestId: randomUUID(),
  model: "fixture",
  provider: "fixture",
  tools: [],
  instructions: "Snapshot restore fixture",
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

/** Only the injected trusted operator owns Core backup/restore and processes. */
export async function runSnapshotRestoreProbe(
  baseUrl,
  credential,
  client,
  directory,
  schemaVersion,
  operator,
) {
  const { AsyncIrisMemoryClient } = await loadInstalledIrisSdk();
  const capabilities = await client.negotiate(["v1"]);
  assert.ok(capabilities.capabilities.includes("events.checkpoint.v1"));
  const results = [];
  for (const mode of ["missing-anchor", "reused-cursor"]) {
    const dataDirectory = join(directory, `snapshot-host-${mode}`);
    const sessionId = randomUUID();
    const privacyScope = `space:${credential.space_id}`;
    let holdEvents = false;
    let activeEvents = 0;
    let observed410 = 0;
    let acknowledgedUsage;
    let runtime, context, verifier;
    const transport = checkedIrisFetch(async (input, init) => {
      const isEvent = new URL(String(input)).pathname === "/v1/events";
      if (isEvent) {
        while (holdEvents) await delay(10, undefined, { signal: init.signal });
        activeEvents++;
      }
      try {
        const response = await fetch(input, init);
        if (isEvent && response.status === 410) observed410++;
        const usageRoute = new URL(String(input)).pathname.match(/^\/v1\/recall\/([^/]+)\/usage$/);
        if (usageRoute && response.ok) {
          acknowledgedUsage = {
            requestId: decodeURIComponent(usageRoute[1]),
            body: JSON.parse(init.body),
            key: new Headers(init.headers).get("idempotency-key"),
            ack: await response.clone().json(),
          };
        }
        return response;
      } finally {
        if (isEvent) activeEvents--;
      }
    });
    const makeMemory = () => {
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
      return {
        appInstanceId: `snapshot-${mode}`,
        agentId: credential.agent_id,
        spaceId: credential.space_id,
        identityScope: "profile:snapshot-probe",
        privacyScope,
        privacyRevision: "1",
        publicLabels: [privacyScope],
        scope: { kind: "space", acknowledgeCrossSession: true },
        personaSource: iris,
        providers: [{ provider: iris, hashScheme: "iris-canonical-v1" }],
        actors: () => [{ provider: "bellis-test", externalId: "viewer" }],
        refreshIntervalMs: 60000,
      };
    };
    const configuration = {
      dataDirectory,
      runtimeVersion: "0.1.0-snapshot-probe",
      port: 0,
      phase2: { enabled: true, sessionId },
      phase3: { enabled: true, sessionId },
    };
    const facts = () => {
      // Bellis-owned audit only; never query Core's database or backup payload.
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
    const providerState = async () =>
      (
        await runtime.memory.history.phase4ReadProviderState({
          scopeKey: runtime.memory.policyStamp.scopeKey,
          providerId: "iris",
        })
      )?.state;
    try {
      const now = Date.now() * 1000;
      const observation = await client.observeBatch(
        [
          {
            agent_id: credential.agent_id,
            space_id: credential.space_id,
            actor_external_identity_id: credential.actor_external_identity_id,
            role: "user",
            kind: "message.text",
            content: "Snapshot fixture prefers tea.",
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
          source_id: observation.accepted_observation_ids[0],
          relation: "supports",
          source_authority: "user_statement",
        },
      ];
      const claim = await client.rememberClaim(
        {
          agent_id: credential.agent_id,
          space_id: credential.space_id,
          subject_is_self: true,
          predicate: `probe.snapshot.${mode}`,
          value: "tea",
          canonical_text: "Snapshot fixture prefers tea.",
          privacy_labels: [privacyScope],
          source_authority: "user_statement",
          evidence,
        },
        { idempotencyKey: randomUUID() },
      );
      const correction = async (value, expectedRevision = 2) =>
        client.correctClaim(
          claim.claim_id,
          {
            expected_revision: expectedRevision,
            mode: "supersede",
            value,
            canonical_text: `Snapshot fixture prefers ${value}.`,
            evidence: evidence.map((item) => ({ ...item, relation: "corrects" })),
            reason: "authorized isolated snapshot fixture",
          },
          { idempotencyKey: randomUUID() },
        );
      await correction("green tea", 1);
      runtime = await startRuntime({ config: configuration, memory: makeMemory() });
      const baseline = (await client.events({ after: "0", signal: AbortSignal.timeout(5000) })).at(
        -1,
      );
      if (baseline)
        await waitFor(async () => (await providerState())?.eventCursor === baseline.cursor);
      const ingested = await runtime.phase3.ingest({
        schemaVersion: 1,
        id: randomUUID(),
        source: "trusted-snapshot-probe",
        kind: "danmaku",
        occurredAt: Date.now(),
        payload: { userId: "viewer", text: "Snapshot fixture" },
        priority: 100,
      });
      assert.equal(ingested.result, "accepted");
      await waitFor(() => facts().usage.some((row) => row.status === "delivered"));
      assert.equal(facts().manifests.length, 1);
      assert.ok(acknowledgedUsage?.ack.report_id);

      const restore = await operator.backup(mode);
      await correction("coffee");
      const anchor = (await client.events({ after: "0", signal: AbortSignal.timeout(5000) })).at(
        -1,
      );
      assert.ok(anchor?.resource_refs.some((ref) => ref.resource_id === claim.claim_id));
      await waitFor(async () => {
        const state = await providerState();
        return (
          state?.eventCursor === anchor.cursor &&
          state.eventId === anchor.event_id &&
          !state.pendingResourceInvalidation
        );
      });
      context = await runtime.memory.build(contextInput(), AbortSignal.timeout(5000));
      context.assertCurrent();
      assert.equal(context.signal.aborted, false);
      const before = facts();
      holdEvents = true;
      await waitFor(() => activeEvents === 0);
      const restoration = await restore();
      const replayedUsage = await client.reportRecallUsage(
        acknowledgedUsage.requestId,
        acknowledgedUsage.body,
        { idempotencyKey: acknowledgedUsage.key, signal: AbortSignal.timeout(5000) },
      );
      assert.equal(replayedUsage.report_id, acknowledgedUsage.ack.report_id);
      assert.deepEqual(replayedUsage.stages, acknowledgedUsage.ack.stages);
      const oldHead = (await client.events({ after: "0", signal: AbortSignal.timeout(5000) })).at(
        -1,
      );
      assert.ok(BigInt(oldHead?.cursor ?? "0") > 0n);
      assert.ok(BigInt(oldHead.cursor) < BigInt(anchor.cursor));
      assert.equal(oldHead.cursor, baseline.cursor);
      assert.equal(oldHead.event_id, baseline.event_id);
      assert.deepEqual(
        await client.events({
          after: oldHead.cursor,
          afterEventId: oldHead.event_id,
          signal: AbortSignal.timeout(5000),
        }),
        [],
      );
      let replacement;
      if (mode === "reused-cursor") {
        await correction("water");
        replacement = (await client.events({ after: "0", signal: AbortSignal.timeout(5000) })).at(
          -1,
        );
        assert.equal(replacement.cursor, anchor.cursor);
        assert.notEqual(replacement.event_id, anchor.event_id);
      }
      await assert.rejects(
        client.events({
          after: anchor.cursor,
          afterEventId: anchor.event_id,
          signal: AbortSignal.timeout(5000),
        }),
        (error) => error.status === 410 && error.code === "history_unavailable",
      );
      holdEvents = false;
      await waitFor(() => runtime.memory.historyRecoveryRequired && context.signal.aborted);
      await waitFor(async () => Boolean((await providerState())?.historyGap));
      const state = await providerState();
      assert.equal(observed410, 1);
      assert.equal(state.eventCursor, anchor.cursor);
      assert.equal(state.eventId, anchor.event_id);
      assert.equal(state.historyGap.reason, "history_unavailable");
      assert.equal(runtime.status.phase, "recovering");
      assert.throws(() => context.assertCurrent());
      assert.deepEqual(facts(), before);
      const originalUsage = before.usage[0];
      assert.deepEqual(
        await runtime.memory.publish(
          {
            outboxId: originalUsage.outbox_id,
            topic: "memory.usage.v1",
            payload: JSON.parse(originalUsage.payload_json),
          },
          AbortSignal.timeout(5000),
        ),
        { ok: false, errorCode: "history_unavailable", retryable: true },
      );
      context.dispose();
      context = undefined;
      await runtime.close();
      verifier = new IrisRecallVerifier({
        baseUrl,
        bearerToken: credential.token,
        agentId: credential.agent_id,
        spaceId: credential.space_id,
        minimumCoreSchemaVersion: schemaVersion,
        maximumCoreSchemaVersion: schemaVersion,
      });
      runtime = await startRuntime({
        config: configuration,
        memory: {
          ...makeMemory(),
          historyRecovery: { verifiers: [verifier], intervalMs: 100, timeoutMs: 5000 },
        },
      });
      assert.equal(runtime.status.phase, "recovering");
      assert.equal(runtime.phase3, null);
      const origin = `http://127.0.0.1:${runtime.status.port}`;
      for (const [route, expected] of [
        ["live", 200],
        ["ready", 503],
      ]) {
        assert.equal(
          (
            await fetch(`${origin}/api/v1/health/${route}`, {
              headers: { origin },
              signal: AbortSignal.timeout(5000),
            })
          ).status,
          expected,
        );
      }
      assert.deepEqual(facts(), before);
      assert.equal((await providerState()).historyGap.gapId, state.historyGap.gapId);
      results.push({
        mode,
        status: "passed",
        publicBackupRestore: true,
        restoration,
        anchor: { cursor: anchor.cursor, eventId: anchor.event_id },
        restoredHead: oldHead.cursor,
        retainedAnchorValidated: true,
        restoredUsageReportId: replayedUsage.report_id,
        originalUsageReplay: "same-body-key-report-id-and-stage-counts",
        replacementEventId: replacement?.event_id,
        contextCancelled: true,
        originalFactsPreserved: {
          requests: before.requests.length,
          manifests: before.manifests.length,
          acknowledgedUsage: before.usage.length,
        },
        restart: "recovering-live-200-ready-503-no-decision-pipeline",
        gapId: state.historyGap.gapId,
      });
    } finally {
      holdEvents = false;
      context?.dispose();
      await runtime?.close();
      verifier?.stop();
    }
  }
  return {
    status: "passed",
    casesPassed: results.length,
    results,
    scope:
      "Real public signed backup/restore and Core process replacement; actual Provider-accepted checkpoints, missing anchor and reused cursor. No Bellis snapshot restore, deletion-ledger recovery, complete crash matrix or safe gap release claim.",
  };
}
