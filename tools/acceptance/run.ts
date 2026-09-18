// P0 tool evidence bootstrap. This process actually executes registered node:test
// suites; unimplemented SUT entries are omitted and remain PENDING at the gate.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { assertValid, type SchemaTypes } from "../../packages/contract-sdk/src/index.ts";
import {
  buildManifest,
  executionEnvironment,
  rootPath,
  sha256,
  sourceDigest,
} from "../lib/build-manifest.ts";
import { loadRegistry, ROOT, type Verification } from "../lib/registry.ts";
import { toolCases } from "./catalog.ts";
import { manifestAs, nodeCommand, readNodeExecution, toolAssertions } from "./evidence.ts";

type Artifact = SchemaTypes["EvidenceArtifact"];
export function writeArtifact(path: string, bytes: string | Buffer, root = ROOT): Artifact {
  if (!path.startsWith("reports/")) throw new Error("Evidence output must be under reports/");
  const full = rootPath(root, path);
  const reports = resolve(root, "reports");
  if (!full.startsWith(reports + sep)) throw new Error("Evidence output escapes reports");
  const rootReal = realpathSync(root);
  if (rootReal !== resolve(root)) throw new Error("Evidence root must be canonical");
  if (!existsSync(reports)) mkdirSync(reports);
  if (realpathSync(reports) !== reports) throw new Error("Reports root must not be a symlink");
  // Inspect each existing parent before creating its child. A pre-existing link
  // must not cause even an empty directory to be created outside reports.
  let parent = reports;
  for (const name of relative(reports, dirname(full)).split(sep).filter(Boolean)) {
    const next = join(parent, name);
    if (existsSync(next)) {
      if (!lstatSync(next).isDirectory() || realpathSync(next) !== next)
        throw new Error("Evidence parent is a symlink or not a directory");
    } else mkdirSync(next);
    parent = next;
  }
  writeFileSync(full, bytes, { flag: "wx" });
  return { path, sha256: sha256(bytes) };
}

export function runTools(
  output = `reports/p0/tools-${randomUUID()}`,
  root = ROOT,
  verification: Verification = loadRegistry().verification,
): SchemaTypes["AcceptanceReport"] {
  rootPath(root, output);
  if (!output.startsWith("reports/")) throw new Error("Acceptance output must be under reports/");
  const sut = buildManifest("sut", root);
  const runner = manifestAs("runner", sut);
  const environment = executionEnvironment(sut.dependencies, root);
  const report: SchemaTypes["AcceptanceReport"] = { source_digest: sourceDigest(root), tests: [] };
  const sutRef = writeArtifact(
    `${output}/sut-manifest.json`,
    `${JSON.stringify(sut, null, 2)}\n`,
    root,
  );
  const runnerRef = writeArtifact(
    `${output}/runner-manifest.json`,
    `${JSON.stringify(runner, null, 2)}\n`,
    root,
  );
  for (const entry of verification.tests.filter(
    (t) => t.phase === "P0" && t.adapter === "contract_tools",
  )) {
    if (entry.implementation_status !== "IMPLEMENTED" || !entry.runner) continue;
    const expectedCases = toolCases(entry.id, entry.runner, root);
    const executedAt = new Date().toISOString();
    const runId = randomUUID();
    const command = nodeCommand(entry.runner);
    const childEnvironment: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" };
    delete childEnvironment.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, command.slice(1), {
      cwd: root,
      encoding: "buffer",
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
      env: childEnvironment,
    });
    const base = `${output}/${entry.id}`;
    const events = writeArtifact(
      `${base}/node-events.ndjson`,
      child.stdout ?? Buffer.alloc(0),
      root,
    );
    const stderr = writeArtifact(`${base}/stderr.txt`, child.stderr ?? Buffer.alloc(0), root);
    const commandRef = writeArtifact(
      `${base}/command.json`,
      `${JSON.stringify({ command, exit_code: child.status, signal: child.signal, error: child.error?.message ?? null })}\n`,
      root,
    );
    let parsed: ReturnType<typeof readNodeExecution>;
    try {
      parsed = readNodeExecution(child.stdout ?? Buffer.alloc(0));
    } catch (error) {
      const failure = writeArtifact(
        `${base}/runner-error.txt`,
        `${String(error)}\n${child.error ? String(child.error) : ""}\n`,
        root,
      );
      report.tests.push({
        id: entry.id,
        status: "FAIL",
        executed_at: executedAt,
        environment,
        runner_sha256: sha256(readFileSync(join(root, entry.runner))),
        sut_build_digest: sut.digest,
        artifacts: [commandRef, failure, events, stderr],
      });
      continue;
    }
    const assertions = toolAssertions(entry.id, parsed.cases);
    const run: SchemaTypes["P0TestRunEvidence"] = {
      artifact_type: "p0-test-run",
      run_id: runId,
      test_id: entry.id,
      scenario_ids: assertions.map((a) => a.scenario_id),
      source_digest: report.source_digest,
      sut_build_digest: sut.digest,
      runner_manifest_digest: runner.digest,
      environment,
      command,
      exit_code: child.status ?? 1,
      seed: null,
      sut_manifest: sutRef,
      runner_manifest: runnerRef,
      trace: [commandRef, events, stderr].map((raw_artifact, index) => ({
        index,
        source_role: "runner",
        source_instance_id: runId,
        observed_at: {
          clock_domain: `runner:${runId}`,
          monotonic_ms: Math.floor(performance.now()),
        },
        kind: "process",
        name:
          index === 0 ? "executed_command" : index === 1 ? "node_test_events" : "process_stderr",
        payload_sha256: raw_artifact.sha256,
        raw_artifact,
      })),
      assertions,
      transition_coverage: [],
      endpoint_facts: [],
      session_facts: [],
      profile_digest: null,
      dependency_gates: [],
      summary: {
        passed_assertions: assertions.filter((a) => a.passed).length,
        failed_assertions: assertions.filter((a) => !a.passed).length,
        rejected_operations: 0,
        failed_operations: 0,
        unknown_operations: 0,
        completed_effect_units: 0,
        cleanup_confirmed: 0,
        cleanup_unknown: 0,
        latency_samples_ms: parsed.cases.map((c) => c.duration_ms),
        quality_notes: [
          "本报告的断言计数表示完整 node:test 用例结果，不是 assert.* 调用次数；工具结果不能关闭 SUT 要求。",
        ],
      },
      raw_artifacts: [commandRef, events, stderr],
      process_outputs: [events, stderr],
      completed: parsed.completed && !child.error && child.status !== null,
    };
    assertValid("P0TestRunEvidence", run);
    const raw = writeArtifact(`${base}/run.json`, `${JSON.stringify(run, null, 2)}\n`, root);
    const pass =
      run.completed &&
      child.status === 0 &&
      parsed.passed &&
      expectedCases.length === assertions.length &&
      expectedCases.every((c) => run.scenario_ids.includes(c.id));
    report.tests.push({
      id: entry.id,
      status: pass ? "PASS" : "FAIL",
      executed_at: executedAt,
      environment,
      runner_sha256: sha256(readFileSync(join(root, entry.runner))),
      sut_build_digest: sut.digest,
      artifacts: [raw],
    });
  }
  assertValid("AcceptanceReport", report);
  writeArtifact(`${output}/acceptance.json`, `${JSON.stringify(report, null, 2)}\n`, root);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(ROOT, "tools/acceptance/run.ts")) {
  const { values } = parseArgs({ options: { output: { type: "string" } } });
  const output = values.output ?? `reports/p0/tools-${randomUUID()}`;
  const report = runTools(output);
  console.log(
    JSON.stringify(
      {
        report: relative(ROOT, resolve(ROOT, output, "acceptance.json")),
        tests: report.tests.map((t) => ({ id: t.id, status: t.status })),
        sut: "PENDING",
      },
      null,
      2,
    ),
  );
  process.exitCode = report.tests.every((t) => t.status === "PASS") ? 0 : 1;
}
