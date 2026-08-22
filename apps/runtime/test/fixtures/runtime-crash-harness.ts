import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  PersistenceCheckpoint,
  PersistenceCheckpointObserver,
  PersistenceWorkerOptions,
} from "@bellis/persistence";
import { startRuntime } from "../../src/index.js";
import type { RuntimeHandle } from "../../src/index.js";

/**
 * Crash Window 测试/Demo 子进程 harness（P4 文档 §14.3）。
 *
 * 仅测试装配：通过 fork 继承的私有 IPC（process.send）与父进程协作。
 * `armed` 模式注入受控检查点观察器——到达目标检查点后通知父进程并
 * 永久阻塞，等待 SIGKILL（真正的 Crash Window，不是正常 close）。
 * `production` 模式不注入观察器，与生产装配一致。
 *
 * 用法：node --import <resolve-hook> runtime-crash-harness.ts <dataDirectory> <armed|production>
 */

function notify(message: Record<string, unknown>): void {
  process.send?.(message);
}

const WORKER: PersistenceWorkerOptions = {
  url: pathToFileURL(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "..",
      "packages",
      "persistence",
      "src",
      "worker",
      "entry.ts",
    ),
  ),
  execArgv: ["--import", pathToFileURL(join(import.meta.dirname, "ts-worker-resolve.mjs")).href],
};

const [dataDirectory, mode] = process.argv.slice(2) as [string, string];

if (dataDirectory === undefined || (mode !== "armed" && mode !== "production")) {
  notify({
    type: "harness-error",
    message: "usage: runtime-crash-harness.ts <dataDirectory> <armed|production>",
  });
  process.exit(2);
}

let armedCheckpoint: PersistenceCheckpoint | null = null;

const observer: PersistenceCheckpointObserver | undefined =
  mode === "armed"
    ? {
        reached: (checkpoint: PersistenceCheckpoint) => {
          if (armedCheckpoint !== checkpoint) {
            return Promise.resolve();
          }
          notify({ type: "checkpoint", checkpoint });
          return new Promise<void>(() => {});
        },
      }
    : undefined;

const runtime: RuntimeHandle = await startRuntime({
  config: {
    dataDirectory,
    runtimeVersion: "0.1.0-harness",
    port: 0,
  },
  ...(observer === undefined ? {} : { checkpointObserver: observer }),
  persistenceWorker: WORKER,
});

notify({ type: "ready", port: runtime.status.port, instanceId: runtime.instanceId });

process.on("message", (message: unknown) => {
  const event = message as Record<string, unknown>;
  if (event.type === "issue-token") {
    const issued = runtime.issueStartupToken();
    notify({ type: "token", token: issued.token });
    return;
  }
  if (event.type === "arm") {
    armedCheckpoint = event.checkpoint as PersistenceCheckpoint;
    return;
  }
  if (event.type === "commit") {
    // IPC（JSON）不携带 bigint：水位以十进制字符串传输，在此转换。
    const raw = event.input as {
      sessionId: string;
      sceneId: string;
      cycleId: string;
      idempotencyKey: string;
      cues: Array<{ cueId: string; lane: "audio" | "subtitle" | "avatar" | "game" | "overlay" }>;
      watermarks: Array<{ source: string; watermark: string }>;
    };
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
      .catch((error: unknown) => {
        notify({
          type: "commit-error",
          message: error instanceof Error ? error.message : "unknown",
        });
      });
    return;
  }
  if (event.type === "recovery") {
    runtime
      .readSessionRecovery(event.sessionId as string)
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
      .catch((error: unknown) => {
        notify({
          type: "recovery-error",
          message: error instanceof Error ? error.message : "unknown",
        });
      });
    return;
  }
  if (event.type === "deliveries") {
    notify({ type: "deliveries", records: runtime.outboxDeliveries() });
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
  // 父进程退出：不要残留孤儿 Runtime。
  process.exit(1);
});
