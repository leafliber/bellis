import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createPersistenceClient } from "../../packages/persistence/dist/index.js";
import { SystemMonotonicClock } from "../../packages/transport/dist/index.js";
import { Phase3DecisionHost, Phase4MemoryHost } from "../../apps/runtime/dist/index.js";
import { IrisMemoryProvider, IrisToolBoundary, registerIrisTools, freezeIrisToolRequest } from "../../providers/memory-iris/dist/src/index.js";

/** Real registered Forget with the MemoryHost/DB coordinator; authority is restricted to the probe's own claim. */
export async function runCoordinatedForgetProbe(baseUrl, credential, directory, claim, coreSchemaVersion = 14) {
  const dataDirectory = join(directory, "bellis-forget-tool");
  let persistence = createPersistenceClient({ dataDirectory });
  const clock = new SystemMonotonicClock(), sessionId = randomUUID(), toolRunId = randomUUID();
  let modelCalls = 0, confirmations = 0, dispatched = 0, targetReads = 0, stops = 0, result;
  const iris = new IrisMemoryProvider({ baseUrl, bearerToken: credential.token, minimumCoreSchemaVersion: coreSchemaVersion, maximumCoreSchemaVersion: coreSchemaVersion });
  const memory = new Phase4MemoryHost({ appInstanceId: "bellis-forget-probe", agentId: credential.agent_id, spaceId: credential.space_id,
    identityScope: "profile:probe", privacyScope: `space:${credential.space_id}`, privacyRevision: "1", publicLabels: [`space:${credential.space_id}`],
    scope: { kind: "space", acknowledgeCrossSession: true },
    personaSource: iris, providers: [{ provider: iris, hashScheme: "iris-canonical-v1" }], actors: () => [],
  }, sessionId, persistence, async () => { stops++; });
  const boundary = new IrisToolBoundary({ baseUrl, bearerToken: credential.token, transport: async (url, init) => {
    if ((init?.method ?? "GET") === "GET") { targetReads++; return fetch(url, init); }
    const operation = await persistence.phase4ReadMemoryForget(sessionId, toolRunId);
    assert.equal(operation.state, "blocked");
    assert.equal((await persistence.phase4ReadMemoryPolicy(operation.scopeKey)).blocked, true);
    assert.ok(stops >= 1); dispatched++;
    return fetch(url, init);
  } });
  const host = new Phase3DecisionHost({ sessionId, persistence, clock, wallClockMs: Date.now, model: "forget-probe", instructions: "Use only the authorized claim selector.",
    contextBuilder: memory, grantedCapabilities: ["memory.forget"],
    provider: { name: "forget-probe", async *streamDecision() {
      yield { type: "started" };
      if (++modelCalls === 1) {
        yield { type: "tool_call_start", toolRunId, toolName: "forget" };
        yield { type: "tool_args", toolRunId, delta: JSON.stringify({ claimId: claim.claim_id }) };
        yield { type: "tool_call_end", toolRunId }; yield { type: "next", next: "after_tools" };
      } else yield { type: "next", next: "finish" };
      yield { type: "final" };
    } },
    confirmation: { confirm: async request => {
      assert.deepEqual(request.prepared, await persistence.phase4ReadPreparedTool(sessionId, toolRunId));
      assert.equal(request.prepared.request.record.selector.resource_id, claim.claim_id);
      assert.equal(request.prepared.confirmation.target.claimId, claim.claim_id);
      assert.equal(request.prepared.confirmation.target.revision, claim.revision);
      assert.equal(request.prepared.confirmation.target.subjectEntityId, claim.current_subject_entity_id);
      confirmations++; return true;
    } },
    registerTools: runtime => registerIrisTools(runtime, { agentId: credential.agent_id, spaceId: credential.space_id, selfEntityId: claim.current_subject_entity_id, boundary,
      authority: {
        authorize: async input => {
          assert.equal(input.operation, "forget"); assert.equal(input.call.arguments.claimId, claim.claim_id);
          assert.equal(claim.agent_id, credential.agent_id);
          return { policy: memory.policyStamp, reason: "trusted probe cleanup", subject: { self: true }, evidence: [], privacyLabels: [`space:${credential.space_id}`], sourceAuthority: "user_statement", target: { claimId: claim.claim_id, revision: claim.revision } };
        },
        assertCurrent: async prepared => {
          assert.deepEqual(prepared, await persistence.phase4ReadPreparedTool(sessionId, toolRunId));
          const policy = await persistence.phase4ReadMemoryPolicy(prepared.policy.scopeKey);
          assert.equal(policy.blocked, false); assert.equal(policy.generation, prepared.policy.generation);
        },
        beforeForget: async prepared => { assert.equal((await memory.beginForget(prepared)).state, "blocked"); },
        afterForget: async (prepared, value) => {
          result = value;
          const done = await memory.completeForget(prepared, { requestId: value.request_id, targetCount: value.target_count, erasedCount: value.erased_count, protectedSkipped: value.protected_skipped, heldSkipped: value.held_skipped });
          assert.equal(done.state, "resolved");
        },
        filterResult: async (prepared, value) => {
          const policy = await persistence.phase4ReadMemoryPolicy(prepared.policy.scopeKey);
          assert.equal(policy.blocked, false); assert.equal(policy.generation, 2);
          assert.deepEqual(policy.tombstones, [{ providerId: "iris", resourceRef: `iris:claim:${encodeURIComponent(claim.claim_id)}`, throughRevision: null }]);
          return value;
        },
      },
    }),
  });
  try {
    await persistence.migrate(); await persistence.ensureSession({ sessionId, createdAtMs: Date.now(), trace: { traceId: randomUUID().replaceAll("-", "") } });
    await memory.start(); await host.start();
    await host.ingest({ schemaVersion: 1, id: randomUUID(), kind: "danmaku", source: "trusted-forget-probe", occurredAt: Date.now(), priority: 100, payload: { userId: "probe", text: "forget the probe claim" } });
    for (let i = 0; i < 240 && (modelCalls < 2 || !host.loop.isIdle()); i++) await delay(25);
    assert.equal(modelCalls, 2); assert.equal(host.loop.isIdle(), true);
    assert.equal(confirmations, 1); assert.equal(dispatched, 1); assert.equal(targetReads, 2);
    assert.equal((await host.readDecisionState()).toolRuns[0].state, "succeeded");
    assert.equal(result.erased_count, 1);
    const prepared = await persistence.phase4ReadPreparedTool(sessionId, toolRunId);
    const operation = await persistence.phase4ReadMemoryForget(sessionId, toolRunId);
    await host.close(); await memory.stop(); await persistence.close();
    persistence = createPersistenceClient({ dataDirectory }); await persistence.migrate();
    assert.deepEqual(await persistence.phase4ReadMemoryForget(sessionId, toolRunId), operation);
    assert.equal((await persistence.phase4ReadMemoryPolicy(operation.scopeKey)).tombstones[0].throughRevision, null);
    return { request: freezeIrisToolRequest(prepared.request), result, evidence: { status: "passed", confirmations, dispatched, targetReads,
      barrierBeforeHttp: true, receiptAndTombstone: "durable-and-recovered", finalGeneration: 2, finalBlocked: false,
      scope: "Real registered Forget of probe-owned claim; Legal Hold/protected outcomes and crash windows remain separate gates" } };
  } finally { await host.close(); await memory.stop(); await persistence.close(); clock.close(); }
}
