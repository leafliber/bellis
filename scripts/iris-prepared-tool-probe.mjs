import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createPersistenceClient } from "../packages/persistence/dist/index.js";
import { SystemMonotonicClock } from "../packages/transport/dist/index.js";
import { Phase3DecisionHost, Phase4MemoryHost } from "../apps/runtime/dist/index.js";
import { freezeIrisToolRequest, registerIrisTools, IrisMemoryProvider } from "../providers/memory-iris/dist/src/index.js";

/** Trusted fixture composition, not the production target-authorization adapter. */
export async function runPreparedIrisWriteProbe(request, boundary, directory, baseUrl, credential, coreSchemaVersion = 14) {
  const dataDirectory = join(directory, "bellis-prepared-tool");
  let persistence = createPersistenceClient({ dataDirectory });
  const clock = new SystemMonotonicClock();
  const sessionId = randomUUID(), toolRunId = randomUUID();
  let modelCalls = 0, preparations = 0, confirmations = 0, executions = 0;
  const argumentsValue = { predicate: request.record.predicate, value: request.record.value, canonicalText: request.record.canonical_text };
  const iris = new IrisMemoryProvider({ baseUrl, bearerToken: credential.token, minimumCoreSchemaVersion: coreSchemaVersion, maximumCoreSchemaVersion: coreSchemaVersion });
  const memory = new Phase4MemoryHost({
    appInstanceId: "bellis-prepared-tool-probe", agentId: credential.agent_id, spaceId: credential.space_id,
    identityScope: "profile:probe", privacyScope: `space:${credential.space_id}`, privacyRevision: "1",
    publicLabels: [`space:${credential.space_id}`], scope: { kind: "space", acknowledgeCrossSession: true }, personaSource: iris,
    providers: [{ provider: iris, hashScheme: "iris-canonical-v1" }], actors: () => [],
  }, sessionId, persistence);
  const host = new Phase3DecisionHost({
    sessionId, persistence, clock, wallClockMs: Date.now, model: "prepared-tool-probe",
    contextBuilder: memory,
    instructions: "Execute only the trusted fixture operation.", grantedCapabilities: ["memory.write"],
    provider: { name: "prepared-tool-probe", async *streamDecision() {
      yield { type: "started" };
      if (++modelCalls === 1) {
        yield { type: "tool_call_start", toolRunId, toolName: "remember", idempotencyKey: "model-key-is-not-the-business-key" };
        yield { type: "tool_args", toolRunId, delta: JSON.stringify(argumentsValue) };
        yield { type: "tool_call_end", toolRunId };
        yield { type: "next", next: "after_tools" };
      } else yield { type: "next", next: "finish" };
      yield { type: "final" };
    } },
    confirmation: { confirm: async value => {
      const durable = await persistence.phase4ReadPreparedTool(sessionId, toolRunId);
      assert.deepEqual(value.prepared, durable);
      assert.deepEqual(durable.request.record.evidence, request.record.evidence);
      assert.equal(durable.request.record.agent_id, credential.agent_id);
      assert.equal(durable.request.record.space_id, credential.space_id);
      assert.equal(durable.request.record.value, request.record.value);
      assert.equal(value.idempotencyKeyHash, createHash("sha256").update(durable.idempotencyKey).digest("hex"));
      confirmations++;
      return true;
    } },
    registerTools: runtime => registerIrisTools(runtime, {
      agentId: credential.agent_id, spaceId: credential.space_id, boundary,
      authority: {
        authorize: async input => {
          assert.equal(input.operation, "remember");
          assert.deepEqual(input.call.arguments, argumentsValue);
          preparations++;
          return { policy: memory.policyStamp, reason: "trusted probe instruction", subject: { self: true },
            evidence: request.record.evidence, privacyLabels: request.record.privacy_labels, sourceAuthority: "user_statement" };
        },
        assertCurrent: async (prepared, context) => {
          assert.equal(context.sessionId, sessionId);
          assert.deepEqual(prepared, await persistence.phase4ReadPreparedTool(sessionId, toolRunId));
          const policy = await persistence.phase4ReadMemoryPolicy(prepared.policy.scopeKey);
          assert.equal(policy.blocked, false); assert.equal(policy.generation, prepared.policy.generation);
          executions++;
        },
        beforeForget: async () => { throw new Error("Forget is not authorized by this probe authority"); },
        afterForget: async () => { throw new Error("Forget is not authorized by this probe authority"); },
        filterResult: async (_prepared, result) => result,
      },
    }),
  });
  try {
    await persistence.migrate();
    await persistence.ensureSession({ sessionId, createdAtMs: Date.now(), trace: { traceId: randomUUID().replaceAll("-", "") } });
    await memory.start();
    await host.start();
    await host.ingest({ schemaVersion: 1, id: randomUUID(), kind: "danmaku", source: "trusted-tool-fixture", occurredAt: Date.now(), priority: 100, payload: { userId: "probe", text: "remember tea" } });
    for (let attempt = 0; attempt < 200 && (modelCalls < 2 || !host.loop.isIdle()); attempt++) await delay(25);
    assert.equal(modelCalls, 2);
    assert.equal(host.loop.isIdle(), true);
    const state = await persistence.phase3ReadDecisionState(sessionId);
    assert.equal(state.toolRuns[0].state, "uncertain");
    assert.equal(state.toolRuns[0].errorCode, "tool_outcome_unknown");
    assert.equal(executions, 1); assert.equal(preparations, 1); assert.equal(confirmations, 1);
    const prepared = await persistence.phase4ReadPreparedTool(sessionId, toolRunId);
    await host.close(); await memory.stop(); await persistence.close();
    persistence = createPersistenceClient({ dataDirectory });
    await persistence.migrate();
    const recovered = await persistence.phase4ReadPreparedTool(sessionId, toolRunId);
    assert.deepEqual(recovered, prepared);
    assert.equal(recovered.request.record.value, request.record.value);
    const audit = JSON.stringify(await persistence.listRecords({ sessionId }));
    assert.equal(audit.includes(recovered.idempotencyKey), false);
    return {
      request: freezeIrisToolRequest(recovered.request),
      evidence: { status: "passed", adapter: "registerIrisTools", preparations, confirmations, executions, durableBeforeConfirmation: true, actualKeyUsed: true, unknownOutcome: true, workerRestart: "exact-request-recovered-without-auto-dispatch", scope: "Registered adapter with trusted remember authority and real MemoryHost policy; production target authorization, Forget coordination and other tools remain separate gates" },
    };
  } finally { await host.close(); await memory.stop(); await persistence.close(); clock.close(); }
}
