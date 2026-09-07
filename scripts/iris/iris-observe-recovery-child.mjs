import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createPersistenceClient } from "../../packages/persistence/dist/index.js";
import { startRuntime } from "../../apps/runtime/dist/index.js";
import { IrisMemoryProvider } from "../../providers/memory-iris/dist/src/index.js";

const [configPath, mode] = process.argv.slice(2);
const config = JSON.parse(await readFile(configPath, "utf8"));
const notify = (value) => process.send?.(value);
const persistence = createPersistenceClient({ dataDirectory: config.dataDirectory });
let runtime,
  event,
  closing,
  release,
  reached = false;
const gate = new Promise((resolve) => {
  release = resolve;
});
const acknowledgements = [];
async function snapshot() {
  assert.ok(event);
  const scopeKey = runtime.memory.policyStamp.scopeKey;
  const state = await persistence.phase4ReadProviderState({ scopeKey, providerId: "iris" });
  notify({
    type: "checkpoint",
    event,
    providerCursor: state?.state.sourceCursors[event.sourceStream] ?? null,
    coreAckCount: acknowledgements.length,
    outbox: await persistence.readOutboxStats(),
  });
}
const iris = new IrisMemoryProvider({
  baseUrl: config.baseUrl,
  bearerToken: config.token,
  minimumCoreSchemaVersion: config.schemaVersion,
  maximumCoreSchemaVersion: config.schemaVersion,
  backgroundTimeoutMs: 30000,
});
const provider = new Proxy(iris, {
  get(owner, property) {
    if (property === "observe")
      return async (events, signal) => {
        assert.equal(events.length, 1);
        event = structuredClone(events[0]);
        await owner.observe(events, signal);
        acknowledgements.push(structuredClone(event));
        if (
          mode === "fault" &&
          config.window === "observation-sdk-ack-before-host-delivered" &&
          !reached
        ) {
          reached = true;
          await snapshot();
          await gate;
        }
      };
    const value = Reflect.get(owner, property, owner);
    return typeof value === "function" ? value.bind(owner) : value;
  },
});
async function completed(original) {
  for (let index = 0; index < 600; index++) {
    const stats = await persistence.readOutboxStats();
    if (stats.delivered === 1) {
      assert.equal(stats.pending + stats.inFlight + stats.dead, 0);
      assert.equal(acknowledgements.length, 1);
      assert.deepEqual(acknowledgements[0], original);
      const state = await persistence.phase4ReadProviderState({
        scopeKey: runtime.memory.policyStamp.scopeKey,
        providerId: "iris",
      });
      assert.equal(state.state.sourceCursors[original.sourceStream], "1");
      notify({ type: "recovered", event: acknowledgements[0], providerCursor: "1", outbox: stats });
      return;
    }
    await delay(25);
  }
  throw new Error("Observe recovery completion timeout");
}
function close() {
  return (closing ??= (async () => {
    release();
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
process.on("message", (message) => {
  if (message.type === "snapshot") void snapshot().catch(fail);
  if (message.type === "release") {
    release();
    void completed(message.original).catch(fail);
  }
  if (message.type === "run")
    void runtime.phase3
      .ingest({
        schemaVersion: 1,
        id: randomUUID(),
        source: "recovery-input",
        kind: "danmaku",
        occurredAt: Date.now(),
        priority: 100,
        payload: { text: "可信恢复输入", userId: "viewer" },
      })
      .then((result) => {
        assert.equal(result.result, "accepted");
      })
      .catch(fail);
  if (message.type === "shutdown")
    void close()
      .then(() => process.exit(0))
      .catch(fail);
});
try {
  await persistence.migrate();
  runtime = await startRuntime({
    persistenceClient: persistence,
    memory: {
      appInstanceId: config.appInstanceId,
      agentId: config.agentId,
      spaceId: config.spaceId,
      identityScope: "observe-recovery:trusted",
      privacyScope: `space:${config.spaceId}`,
      privacyRevision: "1",
      publicLabels: [`space:${config.spaceId}`],
      scope: { kind: "space", acknowledgeCrossSession: true },
      personaSource: provider,
      providers: [{ provider, hashScheme: "iris-canonical-v1" }],
      actors: () => [],
      observeInput: (signal) =>
        signal.source === "recovery-input"
          ? {
              actorExternalIdentityId: config.actorId,
              role: "user",
              content: signal.payload.text,
              privacyLabels: [`space:${config.spaceId}`],
            }
          : null,
    },
    config: {
      dataDirectory: config.dataDirectory,
      port: 0,
      runtimeVersion: "0.1.0-observe-recovery",
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
