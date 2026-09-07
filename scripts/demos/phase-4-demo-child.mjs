#!/usr/bin/env node
/**
 * Phase 4 output E2E 子进程 harness（docs/phase-3-development-guide.md §10.2；仅测试装配）。
 *
 * - 使用已构建的 `@bellis/runtime` dist；phase2+phase3 显式启用；
 * - IPC：ready/port、issue-token、ingest（Signal → Pipeline）、set-script
 *   （DemoScriptedProvider 注入模型流）、evidence（证据快照）、
 *   wait-idle、decision-state（恢复投影）、shutdown。
 */
import { readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { createPersistenceClient } from "../../packages/persistence/dist/index.js";
import { auditAdoptedCycles } from "../iris/phase4-cycle-audit.mjs";
import { loadInstalledIrisSdk } from "../iris/iris-installed-sdk.mjs";
import { startRuntime } from "../../apps/runtime/dist/index.js";

function notify(message) {
  process.send?.(message);
}

const [dataDirectory] = process.argv.slice(2);
if (dataDirectory === undefined) {
  notify({ type: "harness-error", message: "usage: phase-4-demo-child.mjs <dataDirectory>" });
  process.exit(2);
}

const fixedPort = Number(process.env.BELLIS_E2E_PORT ?? 0);
const extraOrigins = (process.env.BELLIS_E2E_ORIGINS ?? "").split(",").filter(Boolean);
const allowedOrigins =
  fixedPort > 0 && extraOrigins.length > 0
    ? [`http://127.0.0.1:${fixedPort}`, `http://localhost:${fixedPort}`, ...extraOrigins]
    : undefined;

// Offline boundary fixture. Real Chromium/Runtime/DB Worker; this is not Iris evidence.
const observations = [];
const usages = [];
const recalls = [];
const observeRequests = [];
let effectCheckpoint;
let confirmingReceipt;
let stageRecovery = false;
let observeCheckpointReached = false;
let snapshotObserveCheckpoint;
async function holdObserveCheckpoint(checkpoint, request) {
  if (effectCheckpoint !== checkpoint || observeCheckpointReached) return;
  observeCheckpointReached = true;
  await snapshotObserveCheckpoint(checkpoint, request);
  await new Promise(() => {});
}
const fixtureProvider = {
  id: "e2e-memory",
  async capabilities() {
    return {
      schemaVersion: 1,
      providerVersion: "1",
      healthy: true,
      categories: ["fact"],
      placements: ["memory"],
      observe: true,
      usageReport: true,
      persona: true,
    };
  },
  async current() {
    return {
      agentId: "e2e-agent",
      revision: "1",
      contentHash: "a".repeat(64),
      policyMode: "locked",
      core: { name: "Iris" },
      traits: {},
      narrative: {},
      state: null,
      effectiveFrom: 1,
      fetchedAt: Date.now(),
      origin: "live",
    };
  },
  async provideContext(query) {
    return {
      schemaVersion: 1,
      providerId: this.id,
      requestId: query.queryId,
      personaRevision: "1",
      returnedBlockIds: [],
      blocks: [],
    };
  },
  async observe(events) {
    observations.push(...structuredClone(events));
  },
  async reportUsage(report) {
    usages.push(structuredClone(report));
  },
};
let memoryProvider = fixtureProvider;
let memoryOptions = {
  appInstanceId: "browser-effects",
  agentId: "e2e-agent",
  spaceId: "e2e-space",
  identityScope: "e2e-profile",
  privacyScope: "space:e2e-space",
  privacyRevision: "1",
  publicLabels: ["space:e2e-space"],
  scope: { kind: "space", acknowledgeCrossSession: true },
  personaSource: fixtureProvider,
  providers: [{ provider: fixtureProvider, hashScheme: "sha256-text-v1" }],
  actors: () => [{ provider: "trusted-e2e", externalId: "viewer" }],
  observeOutput: { privacyLabels: ["space:e2e-space"] },
};
const coreConfigPath = process.env.BELLIS_IRIS_E2E_CONFIG;
if (coreConfigPath) {
  // The trusted parent provisions this owner-only file. Never pass credentials
  // through browser IPC, page state, command arguments, or ordinary logs.
  const config = JSON.parse(await readFile(coreConfigPath, "utf8"));
  stageRecovery = config.stageRecovery === true;
  const { IrisMemoryProvider } = await import("../../providers/memory-iris/dist/src/index.js");
  const { checkedIrisFetch } = await import("../../providers/memory-iris/dist/src/http.js");
  const sdk = stageRecovery ? await loadInstalledIrisSdk() : undefined;
  const auditClient = stageRecovery
    ? new sdk.AsyncIrisMemoryClient(config.baseUrl, {
        bearerToken: config.token,
        fetch: checkedIrisFetch(),
      })
    : undefined;
  snapshotObserveCheckpoint = async (checkpoint, request) => {
    const stream = request.records[0].source_stream;
    const remote = await auditClient.sourceCursor(stream, config.agent_id, {
      signal: AbortSignal.timeout(10000),
    });
    const state = await persistence.phase4ReadProviderState({
      scopeKey: runtime.memory.policyStamp.scopeKey,
      providerId: "iris",
    });
    notify({
      type: "effect-checkpoint",
      checkpoint,
      receipt: confirmingReceipt,
      request,
      remoteCursor: remote.cursor_position,
      providerCursor: state?.state.sourceCursors[stream] ?? null,
    });
  };
  const iris = new IrisMemoryProvider({
    baseUrl: config.baseUrl,
    bearerToken: config.token,
    minimumCoreSchemaVersion: config.coreSchemaVersion ?? 14,
    maximumCoreSchemaVersion: config.coreSchemaVersion ?? 14,
    ...(stageRecovery
      ? {
          client: new sdk.AsyncIrisMemoryClient(config.baseUrl, {
            bearerToken: config.token,
            fetch: checkedIrisFetch(async (url, options) => {
              let request;
              if (new URL(url).pathname === "/v1/observations:batch") {
                if (observeRequests.length >= 8) throw new Error("test capture capacity exceeded");
                request = {
                  records: JSON.parse(options.body).records,
                  key: new Headers(options.headers).get("idempotency-key"),
                  bodyDigest: createHash("sha256").update(options.body).digest("hex"),
                };
                observeRequests.push(request);
                await holdObserveCheckpoint("observation_before_http_publish", request);
              }
              const response = await fetch(url, options);
              if (request) {
                request.receipt = await response.clone().json();
                await holdObserveCheckpoint("core_observation_committed_before_http_ack", request);
              }
              return response;
            }),
          }),
        }
      : {}),
  });
  memoryProvider = new Proxy(iris, {
    get(owner, property) {
      if (property === "provideContext")
        return async (...args) => {
          const result = await owner.provideContext(...args);
          recalls.push({
            requestId: result.requestId,
            personaRevision: result.personaRevision,
            blocks: result.blocks.map(({ id, revision, contentHash, sourceRefs }) => ({
              id,
              revision,
              contentHash,
              sourceRefs,
            })),
          });
          return result;
        };
      if (property === "observe")
        return async (events, signal) => {
          await owner.observe(events, signal);
          if (stageRecovery)
            await holdObserveCheckpoint(
              "observation_sdk_ack_before_host_delivered",
              observeRequests.at(-1),
            );
          for (const event of events)
            if (!observations.some((item) => item.eventId === event.eventId))
              observations.push(structuredClone(event));
        };
      if (property === "reportUsage")
        return async (report, signal) => {
          await owner.reportUsage(report, signal);
          if (!usages.some((item) => item.outboxId === report.outboxId))
            usages.push(structuredClone(report));
        };
      const value = Reflect.get(owner, property, owner);
      return typeof value === "function" ? value.bind(owner) : value;
    },
  });
  memoryOptions = {
    ...memoryOptions,
    ...(stageRecovery ? { appInstanceId: `stage-recovery-${basename(dataDirectory)}` } : {}),
    agentId: config.agent_id,
    spaceId: config.space_id,
    privacyScope: `space:${config.space_id}`,
    publicLabels: [`space:${config.space_id}`],
    scope: { kind: "space", acknowledgeCrossSession: true },
    personaSource: memoryProvider,
    providers: [{ provider: memoryProvider, hashScheme: "iris-canonical-v1" }],
    actors: () => [{ provider: "bellis-test", externalId: "viewer" }],
    observeOutput: { privacyLabels: [`space:${config.space_id}`] },
  };
}
const persistence = createPersistenceClient({
  dataDirectory,
  ...(stageRecovery
    ? {
        defaultDeadlineMs: 30_000,
        checkpointObserver: {
          reached: async (checkpoint) => {
            if (checkpoint !== effectCheckpoint) return;
            notify({ type: "effect-checkpoint", checkpoint, receipt: confirmingReceipt });
            await new Promise(() => {});
          },
        },
      }
    : {}),
});
await persistence.migrate().catch(async (error) => {
  await persistence.close();
  throw error;
});
const adoptions = [];
const auditedPersistence = new Proxy(persistence, {
  get(owner, property) {
    if (stageRecovery && property === "phase4ConfirmEffect")
      return async (input) => {
        confirmingReceipt = structuredClone(input.receipt);
        return owner.phase4ConfirmEffect(input);
      };
    if (property === "phase3AdoptCycle")
      return async (input) => {
        await owner.phase3AdoptCycle(input);
        if (!adoptions.some((item) => item.cycleId === input.cycleId))
          adoptions.push({ sessionId: input.sessionId, cycleId: input.cycleId });
      };
    const value = Reflect.get(owner, property, owner);
    return typeof value === "function" ? value.bind(owner) : value;
  },
});
const runtime = await startRuntime({
  persistenceClient: auditedPersistence,
  memory: memoryOptions,
  config: {
    dataDirectory,
    runtimeVersion: "0.1.0-phase4-effects-e2e",
    port: fixedPort,
    ...(stageRecovery ? { outbox: { pollIntervalMs: 25, leaseMs: 1000 } } : {}),
    ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
    phase2: { enabled: true, sessionId: process.env.BELLIS_E2E_SESSION_ID },
    phase3: {
      enabled: true,
      sessionId: process.env.BELLIS_E2E_SESSION_ID,
      model: { provider: "demo-scripted", paceMs: 30 },
    },
  },
}).catch(async (error) => {
  await persistence.close();
  throw error;
});

notify({ type: "ready", port: runtime.status.port, instanceId: runtime.instanceId });

process.on("message", (event) => {
  if (stageRecovery && event.type === "arm-effect-checkpoint") {
    if (
      ![
        "before_effect_transaction_commit",
        "after_effect_transaction_commit_before_ack",
        "observation_before_http_publish",
        "core_observation_committed_before_http_ack",
        "observation_sdk_ack_before_host_delivered",
      ].includes(event.checkpoint)
    )
      throw new Error("unknown test checkpoint");
    effectCheckpoint = event.checkpoint;
    notify({ type: "effect-checkpoint-armed" });
    return;
  }
  const host = runtime.phase3;
  if (event.type === "issue-token") {
    const issued = runtime.issueStartupToken();
    notify({ type: "token", token: issued.token });
    return;
  }
  if (host === null) {
    notify({ type: "harness-error", message: "phase3 host not enabled" });
    return;
  }
  if (event.type === "interrupt-output") {
    runtime.phase2.service
      .interruptAll("e2e_interrupt")
      .then(() => notify({ type: "output-interrupted" }));
    return;
  }
  if (event.type === "privacy-interrupt") {
    runtime.memory
      .changePrivacy({
        changeId: randomUUID(),
        privacyRevision: "1",
        blocked: true,
        reason: "privacy",
        tombstones: [],
      })
      .then((policy) =>
        notify({
          type: "privacy-interrupted",
          generation: policy.generation,
          blocked: policy.blocked,
        }),
      )
      .catch(() => notify({ type: "privacy-interrupted", error: "privacy_transition_failed" }));
    return;
  }
  if (event.type === "ingest") {
    host
      .ingest(event.signal)
      .then((result) => {
        notify({
          type: "ingest-result",
          result: result.result,
          sequence: result.result === "rejected" ? null : result.sequence.toString(10),
          ...(result.result === "rejected"
            ? { reason: result.reason }
            : { priorityClass: result.priorityClass }),
        });
      })
      .catch((error) => {
        notify({ type: "ingest-result", result: "error", error: String(error) });
      });
    return;
  }
  if (event.type === "set-script") {
    host.modelProvider.setNextScript(event.events);
    notify({ type: "script-set" });
    return;
  }
  if (event.type === "save-output-evidence") {
    const reportPath = process.env.BELLIS_IRIS_E2E_REPORT;
    if (!reportPath || !coreConfigPath) {
      notify({ type: "output-evidence-saved", ok: false });
      return;
    }
    const report = {
      schemaVersion: 1,
      mode: "real-core",
      privacyGeneration: runtime.memory.policyStamp.generation,
      adoptedCycles: host.evidence().adopted,
      usageCount: usages.length,
      observations: observations.map(
        ({ eventId, outboxId, sourceStream, sourceCursor, effectState, effectProof, content }) => ({
          eventId,
          outboxId,
          sourceStream,
          sourceCursor,
          effectState,
          ...(effectProof ? { effectProof } : {}),
          content,
        }),
      ),
      confirmedConversationInNextRequest:
        host.modelProvider.requests[1]?.prompt.includes("已确认输出片段") === true,
    };
    auditAdoptedCycles(persistence, adoptions, host.modelProvider.requests, usages, recalls)
      .then((cycleAudit) =>
        writeFile(reportPath, JSON.stringify({ ...report, cycleAudit }, null, 2) + "\n", {
          mode: 0o600,
        }),
      )
      .then(
        () => notify({ type: "output-evidence-saved", ok: true }),
        (error) =>
          notify({ type: "output-evidence-saved", ok: false, error: String(error.message) }),
      );
    return;
  }
  if (event.type === "evidence") {
    notify({
      type: "evidence",
      memory: { observations, usageCount: usages.length, observeRequests },
      // BigInt 不能跨 IPC 序列化：时间区间转为十进制字符串。
      evidence: JSON.parse(
        JSON.stringify(host.evidence(), (_key, value) =>
          typeof value === "bigint" ? value.toString(10) : value,
        ),
      ),
      idle: host.loop.isIdle(),
      cache: host.toolRuntime.cacheStats,
      provider: {
        callCount: host.modelProvider.callCount,
        requests: host.modelProvider.requests?.length ?? 0,
        prompts: host.modelProvider.requests?.map((request) => request.prompt) ?? [],
      },
      batches: host.pipeline.sealedBatches.map((entry) => ({
        from: entry.batch.watermarkFrom,
        to: entry.batch.watermarkTo,
        latencyMs: entry.info.latencyMs,
        windowMs: entry.info.windowMs,
        trigger: entry.info.trigger,
      })),
      recovery: host.recoveryEvidence,
    });
    return;
  }
  if (event.type === "wait-idle") {
    const startedAt = Date.now();
    const check = () => {
      if (host.loop.isIdle()) {
        // 让异步收尾（audit/后台任务）先结算一拍。
        setTimeout(() => notify({ type: "idle", waitedMs: Date.now() - startedAt }), 30);
        return;
      }
      if (Date.now() - startedAt > (event.timeoutMs ?? 10_000)) {
        notify({ type: "idle", waitedMs: -1 });
        return;
      }
      setTimeout(check, 20);
    };
    check();
    return;
  }
  if (event.type === "decision-state") {
    host
      .readDecisionState()
      .then((state) => {
        notify({
          type: "decision-state",
          consumed: state.consumed.toString(10),
          cycles: state.cycles.length,
          toolRuns: state.toolRuns.map((run) => ({
            toolName: run.toolName,
            state: run.state,
          })),
          uncertainMarked: state.uncertainMarked,
        });
      })
      .catch((error) => {
        notify({ type: "decision-state", error: String(error) });
      });
    return;
  }
  if (event.type === "shutdown") {
    runtime
      .close()
      .finally(() => persistence.close())
      .then(() => {
        notify({ type: "shutdown-done" });
        process.exit(0);
      })
      .catch((error) => {
        notify({ type: "shutdown-failed", error: String(error?.message ?? error) });
        process.exit(3);
      });
  }
});
