#!/usr/bin/env node
/**
 * Runtime 基线验证（docs/phase-1-reference.md；runtime:check）：
 * - 所有 node:sqlite 操作都在短生命周期 Worker 内执行，主线程不绕过
 *   DB Worker 原则；不设置 NODE_NO_WARNINGS，不抑制 ExperimentalWarning。
 * - 捕获每个 Worker 的 stderr：出现任何 SQLite 实验警告或平台差异即失败。
 * - 三阶段：
 *   1) baseline：WAL / 事务提交与回滚 / BigInt 读写 / 关闭重开。
 *   2) crash-pre-commit：Worker 在事务提交前的检查点被父进程强制终止
 *      （真正的 Crash Window，而不是正常关闭后的 terminate）。
 *   3) verify-recovery：新 Worker 打开同一数据库，验证已提交事实保留、
 *      未提交写入回滚、WAL 保持、integrity_check 通过。
 * - 输出 Node 与内嵌 SQLite 版本，对 Windows/macOS 做相同断言。
 */
import { rmSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workerPath = resolve(dirname(fileURLToPath(import.meta.url)), "workers", "sqlite-baseline.mjs");

function spawnWorker(workerData) {
  const worker = new Worker(workerPath, { workerData, stderr: true, stdout: true });
  const stderrChunks = [];
  worker.stderr.on("data", (chunk) => {
    stderrChunks.push(chunk);
  });
  return {
    worker,
    stderr: () => Buffer.concat(stderrChunks).toString("utf8").trim(),
  };
}

function awaitMessage(worker, label) {
  return new Promise((resolvePromise, rejectPromise) => {
    const onMessage = (message) => {
      cleanup();
      resolvePromise(message);
    };
    const onError = (error) => {
      cleanup();
      rejectPromise(error);
    };
    const onExit = (code) => {
      cleanup();
      rejectPromise(new Error(`${label} exited before reporting (code=${code})`));
    };
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
  });
}

let failed = false;

function printChecks(title, result) {
  console.log(`${title} platform=${result.platform} node=${result.node} sqlite=${result.sqlite}`);
  for (const check of result.checks) {
    console.log(`  ${check.ok ? "ok " : "FAIL"} ${check.name}${check.ok ? "" : ` — ${check.error}`}`);
  }
  if (result.checks.some((check) => !check.ok)) {
    failed = true;
  }
}

// ---- 阶段 1：baseline ----
const baseline = spawnWorker({ mode: "baseline" });
const baselineResult = await awaitMessage(baseline.worker, "baseline worker");
await baseline.worker.terminate();
printChecks("runtime:check [baseline]", baselineResult);
if (baseline.stderr() !== "") {
  console.error("runtime:check failed: baseline worker stderr is not empty:");
  console.error(baseline.stderr());
  failed = true;
}

// ---- 阶段 2：crash-pre-commit（强制终止）----
const crash = spawnWorker({ mode: "crash-pre-commit" });
const crashCheckpoint = await awaitMessage(crash.worker, "crash worker");
if (crashCheckpoint.checkpoint !== "pre-commit" || typeof crashCheckpoint.dbPath !== "string") {
  console.error(`runtime:check failed: unexpected crash checkpoint message: ${JSON.stringify(crashCheckpoint)}`);
  process.exit(1);
}
// Worker 正阻塞在事务提交前的检查点；terminate 即强制终止。
await crash.worker.terminate();
const crashStderr = crash.stderr();
if (crashStderr !== "") {
  console.error("runtime:check failed: crash worker stderr is not empty:");
  console.error(crashStderr);
  failed = true;
}
console.log(`runtime:check [crash-pre-commit] worker terminated at checkpoint (db=${crashCheckpoint.dbPath})`);

// ---- 阶段 3：verify-recovery ----
const recovery = spawnWorker({ mode: "verify-recovery", dbPath: crashCheckpoint.dbPath });
const recoveryResult = await awaitMessage(recovery.worker, "recovery worker");
await recovery.worker.terminate();
printChecks("runtime:check [verify-recovery]", recoveryResult);
if (recovery.stderr() !== "") {
  console.error("runtime:check failed: recovery worker stderr is not empty:");
  console.error(recovery.stderr());
  failed = true;
}
rmSync(dirname(crashCheckpoint.dbPath), { recursive: true, force: true });

console.log(
  failed
    ? "runtime:check failed"
    : "runtime:check ok — node:sqlite baseline verified incl. forced termination and recovery",
);
process.exit(failed ? 1 : 0);
