#!/usr/bin/env node
/**
 * Phase 1 Demo 子进程 harness（P4 文档 §15；仅测试装配）。
 *
 * - 使用**已构建**的 `@bellis/runtime` dist 与默认 DB Worker（先 `pnpm build`）。
 * - 通过 fork 继承的私有 IPC（process.send）与父进程协作：
 *   armed 模式注入受控检查点观察器（到达目标检查点通知父进程并阻塞，
 *   等待 SIGKILL 模拟真实崩溃）；production 模式与生产装配一致。
 * - Token 原值只经 IPC 返回，不写入任何日志。
 *
 * 用法：node phase-1-demo-child.mjs <dataDirectory> <armed|production>
 */
import { startRuntime } from "../apps/runtime/dist/index.js";

function notify(message) {
  process.send?.(message);
}

const [dataDirectory, mode] = process.argv.slice(2);

if (dataDirectory === undefined || (mode !== "armed" && mode !== "production")) {
  notify({ type: "harness-error", message: "usage: phase-1-demo-child.mjs <dataDirectory> <armed|production>" });
  process.exit(2);
}

let armedCheckpoint = null;

const observer =
  mode === "armed"
    ? {
        reached(checkpoint) {
          if (armedCheckpoint !== checkpoint) {
            return Promise.resolve();
          }
          notify({ type: "checkpoint", checkpoint });
          return new Promise(() => {});
        },
      }
    : undefined;

const runtime = await startRuntime({
  config: {
    dataDirectory,
    runtimeVersion: "0.1.0-demo",
    port: 0,
  },
  ...(observer === undefined ? {} : { checkpointObserver: observer }),
});

notify({ type: "ready", port: runtime.status.port, instanceId: runtime.instanceId });

process.on("message", (event) => {
  if (event.type === "issue-token") {
    const issued = runtime.issueStartupToken();
    notify({ type: "token", token: issued.token });
    return;
  }
  if (event.type === "arm") {
    armedCheckpoint = event.checkpoint;
    return;
  }
  if (event.type === "commit") {
    // IPC（JSON）不携带 bigint：水位以十进制字符串传输，在此转换。
    const raw = event.input;
    const input = {
      ...raw,
      watermarks: raw.watermarks.map((entry) => ({
        source: entry.source,
        watermark: BigInt(entry.watermark),
      })),
    };
    runtime
      .commitFakeScene(input)
      .then((result) => {
        notify({
          type: "committed",
          duplicate: result.duplicate,
          committedAtMs: result.committedAtMs,
          traceId: result.traceId,
          sceneId: result.sceneId,
        });
      })
      .catch((error) => {
        notify({ type: "commit-error", message: error instanceof Error ? error.message : "unknown" });
      });
    return;
  }
  if (event.type === "recovery") {
    runtime
      .readSessionRecovery(event.sessionId)
      .then((state) => {
        notify({
          type: "recovery",
          sessionId: state.sessionId,
          latestServerSeq: state.latestServerSeq.toString(),
          watermarks: state.signalWatermarks.map((entry) => ({
            source: entry.source,
            watermark: entry.watermark.toString(),
          })),
          lastCommittedScene: state.lastCommittedScene,
        });
      })
      .catch((error) => {
        notify({ type: "recovery-error", message: error instanceof Error ? error.message : "unknown" });
      });
    return;
  }
  if (event.type === "deliveries") {
    notify({ type: "deliveries", records: runtime.outboxDeliveries() });
    return;
  }
  if (event.type === "media-stats") {
    const stats = runtime.mediaFrameStats(event.sessionId);
    notify({ type: "media-stats", sessionId: event.sessionId, stats });
    return;
  }
  if (event.type === "close") {
    void runtime.close().then(() => {
      notify({ type: "closed" });
      process.exit(0);
    });
  }
});

process.on("SIGTERM", () => {
  // harness 只被 SIGKILL 模拟崩溃；SIGTERM 视为异常路径，立即退出。
  process.exit(1);
});

process.on("disconnect", () => {
  // 父进程退出：不残留孤儿 Runtime。
  process.exit(1);
});
