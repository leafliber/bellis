#!/usr/bin/env node
/**
 * 漂移检查（docs/reference/phase-1.md；contracts:check）：
 * 1. 重新构建 @bellis/contracts（tsc -b 增量，保证 dist 与 src 一致）。
 * 2. 在临时目录重新生成两套 JSON Schema 目标。
 * 3. 与提交入库的生成物逐字节比对；任何漂移即失败。
 *
 * 漂移修复方式：运行 `pnpm --filter @bellis/contracts contracts:generate`
 * 并将生成物与对应 Schema 变更一起提交。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contractsDir = join(repoRoot, "packages", "contracts");
const committedDir = join(contractsDir, "generated");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: options.inherit ? "inherit" : "pipe",
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    console.error(`command failed: ${command} ${args.join(" ")}`);
    if (result.stdout) console.error(result.stdout);
    if (result.stderr) console.error(result.stderr);
    process.exit(1);
  }
  return result;
}

function listFiles(dir, prefix = "") {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const relativePath = prefix === "" ? entry : `${prefix}/${entry}`;
    if (statSync(fullPath).isDirectory()) {
      files.push(...listFiles(fullPath, relativePath));
    } else {
      files.push(relativePath);
    }
  }
  return files.sort();
}

run("pnpm", ["--filter", "@bellis/contracts", "build"], { inherit: true });

const tempDir = mkdtempSync(join(tmpdir(), "bellis-contracts-check-"));
try {
  run("node", [join(contractsDir, "scripts", "generate.mjs"), "--out", tempDir], { inherit: true });

  const generatedFiles = listFiles(tempDir);
  const committedFiles = listFiles(committedDir);
  const generatedSet = new Set(generatedFiles);
  const committedSet = new Set(committedFiles);

  const problems = [];
  for (const file of generatedFiles) {
    if (!committedSet.has(file)) {
      problems.push(`missing from generated/: ${file}`);
      continue;
    }
    const generated = readFileSync(join(tempDir, file), "utf8");
    const committed = readFileSync(join(committedDir, file), "utf8");
    if (generated !== committed) {
      problems.push(`drifted: ${file}`);
    }
  }
  for (const file of committedFiles) {
    if (!generatedSet.has(file)) {
      problems.push(`stale file in generated/: ${file}`);
    }
  }

  if (problems.length > 0) {
    console.error(`contracts:check failed (${problems.length} problem(s)):`);
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    console.error("run: pnpm --filter @bellis/contracts contracts:generate");
    process.exit(1);
  }
  console.log(`contracts:check ok — ${generatedFiles.length} files match in both dialects`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
