#!/usr/bin/env node
/**
 * Runtime 基线验证（phase-1-build-guide.md §5.3 runtime:check）：
 * - 通过短生命周期 Worker 导入并操作 node:sqlite，不在主线程绕过 DB Worker 原则。
 * - 捕获 Worker stderr：出现任何 SQLite 实验警告或平台差异即失败
 *   （不设置 NODE_NO_WARNINGS，不抑制 ExperimentalWarning）。
 * - 输出 Node 与内嵌 SQLite 版本，对 Windows/macOS 做相同断言。
 */
import { Worker } from "node:worker_threads";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workerPath = resolve(dirname(fileURLToPath(import.meta.url)), "workers", "sqlite-baseline.mjs");

const worker = new Worker(workerPath, { stderr: true, stdout: true });
const stderrChunks = [];
worker.stderr.on("data", (chunk) => {
  stderrChunks.push(chunk);
});

const result = await new Promise((resolvePromise, rejectPromise) => {
  worker.on("message", resolvePromise);
  worker.on("error", rejectPromise);
  worker.on("exit", (code) => {
    rejectPromise(new Error(`worker exited before reporting (code=${code})`));
  });
});

await worker.terminate();

const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
const failed = result.checks.filter((check) => !check.ok);

console.log(`runtime:check platform=${result.platform} node=${result.node} sqlite=${result.sqlite}`);
for (const check of result.checks) {
  console.log(`  ${check.ok ? "ok " : "FAIL"} ${check.name}${check.ok ? "" : ` — ${check.error}`}`);
}

let exitCode = 0;
if (failed.length > 0) {
  console.error(`runtime:check failed: ${failed.length} check(s) failed`);
  exitCode = 1;
}
if (stderr !== "") {
  console.error(`runtime:check failed: worker stderr is not empty (warnings are treated as failures):`);
  console.error(stderr);
  exitCode = 1;
}
if (exitCode === 0) {
  console.log("runtime:check ok — node:sqlite baseline verified in a short-lived worker");
}
process.exit(exitCode);
