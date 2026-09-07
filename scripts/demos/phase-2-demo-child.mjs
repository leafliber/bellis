#!/usr/bin/env node
/**
 * Phase 2 Demo 子进程 harness（docs/archive/phase-2/development-guide.md §10.2；仅测试装配）。
 *
 * - 使用已构建的 `@bellis/runtime` dist；phase2 显式启用（开发/Demo 装配，
 *   生产默认路径不创建该宿主）。
 * - IPC：ready/port/token、submit（Fake Signal+Fixture → Phase2RuntimeHost）、
 *   interrupt（紧急打断）、state（查询执行状态）、recovery（恢复状态）。
 */
import { randomUUID } from "node:crypto";
import { startRuntime } from "../../apps/runtime/dist/index.js";

function notify(message) {
  process.send?.(message);
}

const [dataDirectory, faultPointArg] = process.argv.slice(2);
if (dataDirectory === undefined) {
  notify({
    type: "harness-error",
    message: "usage: phase-2-demo-child.mjs <dataDirectory> [faultPoint]",
  });
  process.exit(2);
}

const FAULT_POINTS = new Set([
  "before_durable_commit",
  "after_durable_commit",
  "after_stage_commit",
  "after_cancel_sent",
]);

const fixedPort = Number(process.env.BELLIS_E2E_PORT ?? 0);
const extraOrigins = (process.env.BELLIS_E2E_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);
// 保留默认回环源（直连 Runtime 的脚本请求），叠加 E2E 的 Vite 源。
const allowedOrigins =
  fixedPort > 0 && extraOrigins.length > 0
    ? [`http://127.0.0.1:${fixedPort}`, `http://localhost:${fixedPort}`, ...extraOrigins]
    : undefined;

const runtime = await startRuntime({
  config: {
    dataDirectory,
    runtimeVersion: "0.1.0-phase2-demo",
    port: fixedPort,
    ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
    phase2: {
      enabled: true,
      ...(faultPointArg !== undefined && FAULT_POINTS.has(faultPointArg)
        ? { faultPoint: faultPointArg }
        : {}),
    },
  },
});

notify({ type: "ready", port: runtime.status.port, instanceId: runtime.instanceId });

const fixtures = new Map();

process.on("message", (event) => {
  if (event.type === "issue-token") {
    const issued = runtime.issueStartupToken();
    notify({ type: "token", token: issued.token });
    return;
  }
  if (event.type === "submit") {
    const host = runtime.phase2;
    if (host === null) {
      notify({ type: "submit-result", ok: false, message: "phase2 host not enabled" });
      return;
    }
    const fixture = {
      cycleId: event.cycleId ?? randomUUID(),
      traceId: event.traceId ?? randomUUID().replaceAll("-", "").slice(0, 32),
      scenario: event.scenario ?? "normal",
    };
    fixtures.set(fixture.cycleId, fixture);
    const signal = {
      schemaVersion: 1,
      id: randomUUID(),
      kind: "danmaku",
      source: "phase2-demo",
      occurredAt: Date.now(),
      priority: event.urgent ? 1000 : 100,
      payload: { text: event.text ?? "冲！" },
    };
    const outcome = host.submit({ signal, fixture });
    if (outcome.kind !== "submitted") {
      notify({ type: "submit-result", ok: false, kind: outcome.kind });
      return;
    }
    outcome.handle.done.then((done) => {
      notify({
        type: "scene-settled",
        sceneId: done.sceneId,
        state: done.state,
        ...(done.reason === undefined ? {} : { reason: done.reason }),
      });
    });
    notify({ type: "submit-result", ok: true, sceneId: outcome.sceneId, cycleId: fixture.cycleId });
    return;
  }
  if (event.type === "interrupt") {
    void runtime.phase2?.interruptAll(event.reason ?? "urgent_interrupt").then(() => {
      notify({ type: "interrupt-done" });
    });
    return;
  }
  if (event.type === "state") {
    notify({
      type: "state",
      state: runtime.phase2?.service.getExecutionState(event.sceneId) ?? null,
      media: runtime.phase2?.service.mediaStats ?? null,
    });
    return;
  }
  if (event.type === "recovery") {
    runtime
      .readSessionRecovery(event.sessionId)
      .then((recovery) => {
        notify({
          type: "recovery",
          lastCommittedScene: recovery.lastCommittedScene,
          latestServerSeq: recovery.latestServerSeq.toString(),
        });
      })
      .catch((error) => {
        notify({ type: "recovery", error: String(error) });
      });
    return;
  }
  if (event.type === "trace-records") {
    runtime
      .listRecordsByTrace(event.traceId)
      .then((records) => {
        notify({
          type: "trace-records",
          traceId: event.traceId,
          records: records.map((record) => ({
            recordType: record.recordType,
            aggregateId: record.aggregateId,
            sessionId: record.sessionId,
          })),
        });
      })
      .catch((error) => {
        notify({ type: "trace-records", traceId: event.traceId, error: String(error) });
      });
    return;
  }
  if (event.type === "shutdown") {
    runtime
      .close()
      .then(() => {
        notify({ type: "shutdown-done" });
        process.exit(0);
      })
      .catch((error) => {
        notify({ type: "shutdown-failed", error: String(error?.message ?? error) });
        process.exit(3);
      });
    return;
  }
});
