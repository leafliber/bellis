import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createPersistenceClient } from "../../packages/persistence/dist/index.js";
import { startRuntime } from "../../apps/runtime/dist/index.js";
import { IrisMemoryProvider } from "../../providers/memory-iris/dist/src/index.js";

// Test-only entry point: private IPC and owner-only file; no production fault route.
const [configPath, mode] = process.argv.slice(2);
const config = JSON.parse(await readFile(configPath, "utf8"));
const notify = (value) => process.send?.(value);
const persistence = createPersistenceClient({ dataDirectory: config.dataDirectory });
let released,
  reached = false,
  prepared;
const gate = new Promise((resolve) => {
  released = resolve;
});
const target = (event) => event?.resources?.some((item) => item.resourceRef === config.resourceRef);
const pause = async (window, event) => {
  if (mode !== "fault" || reached || window !== config.window || !target(event)) return;
  reached = true;
  const policy = await persistence.phase4ReadMemoryPolicy(memory.policyStamp.scopeKey);
  const state = await persistence.phase4ReadProviderState({
    scopeKey: policy.scopeKey,
    providerId: "iris",
  });
  notify({
    type: "checkpoint",
    window,
    eventId: event.eventId,
    eventCursor: event.cursor,
    persistedCursor: state?.state.eventCursor ?? null,
    pendingEventId: state?.state.pendingResourceInvalidation?.eventId,
    tombstone: policy.tombstones.some(
      (item) => item.resourceRef === config.resourceRef && item.throughRevision === null,
    ),
    generation: policy.generation,
    contextCancelled: prepared?.signal.aborted === true,
  });
  await gate;
};
const port = new Proxy(persistence, {
  get(owner, property) {
    if (property === "phase4WriteProviderState")
      return async (input) => {
        const result = await owner.phase4WriteProviderState(input);
        await pause("pending-persisted-before-host-ack", input.state.pendingResourceInvalidation);
        return result;
      };
    if (property === "phase4ApplyResourceInvalidation")
      return async (scopeKey, event) => {
        const result = await owner.phase4ApplyResourceInvalidation(scopeKey, event);
        await pause("policy-committed-before-provider-cursor", event);
        return result;
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
  eventPollMs: 25,
  backgroundTimeoutMs: 30_000,
});
let runtime, memory, closing;
const memoryOptions = {
  appInstanceId: config.appInstanceId,
  agentId: config.agentId,
  spaceId: config.spaceId,
  identityScope: "recovery:trusted",
  privacyScope: `space:${config.spaceId}`,
  privacyRevision: "1",
  publicLabels: [`space:${config.spaceId}`],
  scope: { kind: "space", acknowledgeCrossSession: true },
  personaSource: iris,
  providers: [{ provider: iris, hashScheme: "iris-canonical-v1" }],
  actors: () => [],
};

async function metadata() {
  const policy = await persistence.phase4ReadMemoryPolicy(memory.policyStamp.scopeKey);
  const state = await persistence.phase4ReadProviderState({
    scopeKey: policy.scopeKey,
    providerId: "iris",
  });
  return { policy, state: state?.state };
}
async function completed() {
  for (let index = 0; index < 600; index++) {
    const { policy, state } = await metadata();
    if (
      policy.tombstones.some(
        (item) => item.resourceRef === config.resourceRef && item.throughRevision === null,
      ) &&
      state?.eventCursor &&
      BigInt(state.eventCursor) > BigInt(config.baselineCursor) &&
      !state.pendingResourceInvalidation
    ) {
      notify({
        type: "recovered",
        generation: policy.generation,
        eventCursor: state.eventCursor,
        permanentTombstone: true,
        blocked: policy.blocked,
      });
      return;
    }
    await delay(25);
  }
  throw new Error("recovery_completion_timeout");
}
function close() {
  return (closing ??= (async () => {
    released();
    prepared?.dispose();
    try {
      await runtime?.close();
    } finally {
      await persistence.close();
    }
  })());
}

process.on("message", (event) => {
  if (event.type === "release") {
    released();
    void completed().catch(fail);
  }
  if (event.type === "shutdown")
    void close()
      .then(() => {
        notify({ type: "closed" });
        process.exit(0);
      })
      .catch(fail);
});
function fail(error) {
  notify({ type: "error", message: String(error.message).slice(0, 1024) });
  void close().finally(() => process.exit(1));
}
try {
  await persistence.migrate();
  runtime = await startRuntime({
    persistenceClient: port,
    memory: memoryOptions,
    config: {
      dataDirectory: config.dataDirectory,
      port: 0,
      runtimeVersion: "0.1.0-recovery-probe",
      phase2: { enabled: true },
      phase3: {
        enabled: true,
        sessionId: config.sessionId,
        model: { provider: "demo-scripted", paceMs: 1 },
      },
    },
  });
  memory = runtime.memory;
  if (mode === "fault") {
    for (let index = 0; index < 600; index++) {
      const { state } = await metadata();
      if (BigInt(state?.eventCursor ?? "0") >= BigInt(config.baselineCursor)) break;
      if (index === 599) throw new Error("baseline_event_drain_timeout");
      await delay(25);
    }
    prepared = await memory.build(
      {
        requestId: randomUUID(),
        model: "fixture",
        provider: "fixture",
        tools: [],
        instructions: "Recovery fixture",
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
      },
      new AbortController().signal,
    );
    assert.equal(prepared.signal.aborted, false);
    notify({ type: "ready" });
  } else {
    await completed();
  }
} catch (error) {
  fail(error);
}
