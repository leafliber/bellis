import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createPersistenceClient } from "../packages/persistence/dist/index.js";
import { startRuntime } from "../apps/runtime/dist/index.js";
import { IrisMemoryProvider } from "../providers/memory-iris/dist/src/index.js";

const [configPath, mode] = process.argv.slice(2);
const config = JSON.parse(await readFile(configPath, "utf8"));
const notify = (message) => process.send?.(message);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const persistence = createPersistenceClient({ dataDirectory: config.dataDirectory });
let runtime,
  context,
  reached = false,
  released,
  closing;
const gate = new Promise((resolve) => {
  released = resolve;
});
const acknowledgements = [];
async function checkpoint(window) {
  if (mode !== "fault" || config.window !== window || reached) return;
  reached = true;
  assert.ok(context);
  const stored = await persistence.phase4ReadContextManifest(
    config.sessionId,
    context.manifest.cycleId,
  );
  const stats = await persistence.readOutboxStats();
  assert.equal(runtime.phase3.modelProvider.callCount, 1);
  assert.equal(context.manifest.modelRequestId, runtime.phase3.modelProvider.requests[0].requestId);
  notify({
    type: "checkpoint",
    window,
    cycleId: context.manifest.cycleId,
    manifestId: context.manifest.manifestId,
    manifestDigest: context.manifestDigest,
    persisted: stored !== null,
    persistedDigest: stored?.manifestDigest ?? null,
    usage: context.usage[0].report,
    coreAckCount: acknowledgements.length,
    outbox: stats,
  });
  await gate;
}
const port = new Proxy(persistence, {
  get(owner, property) {
    if (property === "phase3AdoptCycle")
      return async (input) => {
        context = input.context;
        assert.ok(context?.usage.length === 1);
        await checkpoint("manifest-formed-before-adoption");
        await owner.phase3AdoptCycle(input);
        await checkpoint("adoption-committed-before-usage-ack");
      };
    const value = Reflect.get(owner, property, owner);
    return typeof value === "function" ? value.bind(owner) : value;
  },
});
const iris = new IrisMemoryProvider({
  baseUrl: config.baseUrl,
  bearerToken: config.token,
  minimumCoreSchemaVersion: config.schemaVersion,
  maximumCoreSchemaVersion: config.schemaVersion,
});
const provider = new Proxy(iris, {
  get(owner, property) {
    if (property === "reportUsage")
      return async (report, signal) => {
        if (mode === "fault" && config.window === "adoption-committed-before-usage-ack") await gate;
        await owner.reportUsage(report, signal);
        acknowledgements.push(structuredClone(report));
        await checkpoint("usage-ack-before-host-delivered");
      };
    const value = Reflect.get(owner, property, owner);
    return typeof value === "function" ? value.bind(owner) : value;
  },
});
async function completed(original) {
  for (let index = 0; index < 600; index++) {
    const state = await persistence.phase3ReadDecisionState(config.sessionId);
    const stats = await persistence.readOutboxStats();
    if (state.cycles.length === 1 && stats.delivered === 1 && runtime.phase3.loop.isIdle()) {
      assert.equal(stats.pending + stats.inFlight + stats.dead, 0);
      const row = await persistence.phase4ReadContextManifest(
        config.sessionId,
        state.cycles[0].cycleId,
      );
      assert.ok(row);
      assert.equal(hash(JSON.stringify(row.manifest)), row.manifestDigest);
      const originalRow = await persistence.phase4ReadContextManifest(
        config.sessionId,
        original.cycleId,
      );
      const newPendingInputCycle =
        mode === "recover" && config.window === "manifest-formed-before-adoption";
      if (newPendingInputCycle) {
        assert.equal(originalRow, null);
        assert.notEqual(row.manifest.cycleId, original.cycleId);
      } else {
        assert.equal(row.manifest.cycleId, original.cycleId);
        assert.equal(row.manifestDigest, original.manifestDigest);
      }
      assert.equal(
        runtime.phase3.modelProvider.callCount,
        mode === "recover" && !newPendingInputCycle ? 0 : 1,
      );
      assert.equal(state.consumed, 1n);
      assert.equal(state.toolRuns.length, 0);
      const usage = acknowledgements.find((report) => report.hostCycleId === row.manifest.cycleId);
      assert.ok(usage);
      const selected = row.manifest.providers[0];
      assert.equal(selected.outcome, "ok");
      assert.equal(selected.personaRevision, row.manifest.persona.revision);
      assert.equal(usage.requestId, selected.requestId);
      assert.deepEqual(usage.returnedBlockIds, selected.returned);
      assert.deepEqual(usage.hostSelectedBlockIds, selected.hostSelected);
      assert.deepEqual(usage.modelVisibleBlockIds, selected.modelVisible);
      notify({
        type: "recovered",
        originalManifestPresent: originalRow !== null,
        originalManifestStable: originalRow?.manifestDigest === original.manifestDigest,
        newPendingInputCycle,
        modelRequestsAfterStart: runtime.phase3.modelProvider.callCount,
        cycles: 1,
        consumed: "1",
        manifestDigest: row.manifestDigest,
        cycleId: row.manifest.cycleId,
        outbox: stats,
        usage,
      });
      return;
    }
    await delay(25);
  }
  throw new Error("cycle_recovery_timeout");
}
function close() {
  return (closing ??= (async () => {
    released();
    try {
      await runtime?.close();
    } finally {
      await persistence.close();
    }
  })());
}
function fail(error) {
  notify({ type: "error", message: String(error.message).slice(0, 1024) });
  void close().finally(() => process.exit(1));
}
process.on("message", (event) => {
  if (event.type === "release") {
    released();
    void completed(event.original).catch(fail);
  }
  if (event.type === "run") {
    runtime.phase3.modelProvider.setNextScript([
      { type: "started" },
      { type: "next", next: "finish" },
      { type: "final" },
    ]);
    void runtime.phase3
      .ingest({
        schemaVersion: 1,
        id: randomUUID(),
        source: "recovery-simulator",
        kind: "danmaku",
        occurredAt: Date.now(),
        priority: 100,
        payload: { text: "已确认片段", userId: "viewer" },
      })
      .then((result) => {
        assert.equal(result.result, "accepted");
      })
      .catch(fail);
  }
  if (event.type === "shutdown")
    void close()
      .then(() => process.exit(0))
      .catch(fail);
});
try {
  await persistence.migrate();
  runtime = await startRuntime({
    persistenceClient: port,
    memory: {
      appInstanceId: config.appInstanceId,
      agentId: config.agentId,
      spaceId: config.spaceId,
      identityScope: "recovery:trusted",
      privacyScope: `space:${config.spaceId}`,
      privacyRevision: "1",
      publicLabels: [`space:${config.spaceId}`],
      scope: { kind: "space", acknowledgeCrossSession: true },
      personaSource: provider,
      providers: [{ provider, hashScheme: "iris-canonical-v1" }],
      actors: () => [{ provider: "bellis-test", externalId: "viewer" }],
    },
    config: {
      dataDirectory: config.dataDirectory,
      port: 0,
      runtimeVersion: "0.1.0-cycle-recovery",
      outbox: { pollIntervalMs: 25, leaseMs: 1000 },
      phase2: { enabled: true },
      phase3: {
        enabled: true,
        sessionId: config.sessionId,
        model: { provider: "demo-scripted", paceMs: 1 },
      },
    },
  });
  if (mode === "fault") notify({ type: "ready" });
  else await completed(config.original);
} catch (error) {
  fail(error);
}
