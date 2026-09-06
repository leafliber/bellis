#!/usr/bin/env node
/**
 * Phase 3 Demo 子进程 harness（docs/phase-3-development-guide.md §10.2；仅测试装配）。
 *
 * - 使用已构建的 `@bellis/runtime` dist；phase2+phase3 显式启用；
 * - IPC：ready/port、issue-token、ingest（Signal → Pipeline）、set-script
 *   （DemoScriptedProvider 注入模型流）、evidence（证据快照）、
 *   wait-idle、decision-state（恢复投影）、shutdown。
 */
import { startRuntime } from "../apps/runtime/dist/index.js";

function notify(message) {
  process.send?.(message);
}

const [dataDirectory] = process.argv.slice(2);
if (dataDirectory === undefined) {
  notify({ type: "harness-error", message: "usage: phase-3-demo-child.mjs <dataDirectory>" });
  process.exit(2);
}

const fixedPort = Number(process.env.BELLIS_E2E_PORT ?? 0);
const extraOrigins = (process.env.BELLIS_E2E_ORIGINS ?? "").split(",").filter(Boolean);
const allowedOrigins = fixedPort > 0 && extraOrigins.length > 0
  ? [`http://127.0.0.1:${fixedPort}`, `http://localhost:${fixedPort}`, ...extraOrigins]
  : undefined;

const runtime = await startRuntime({
  config: {
    dataDirectory,
    runtimeVersion: "0.1.0-phase3-demo",
    port: fixedPort,
    ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
    phase2: { enabled: true },
    phase3: { enabled: true, model: { provider: "demo-scripted", paceMs: 30 } },
  },
});

notify({ type: "ready", port: runtime.status.port, instanceId: runtime.instanceId });

process.on("message", (event) => {
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
  if (event.type === "evidence") {
    notify({
      type: "evidence",
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
