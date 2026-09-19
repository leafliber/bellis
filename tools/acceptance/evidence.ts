// Reviewable local evidence only. Hashes bind a run to files; they are not signatures
// and cannot make an untrusted runner or a fabricated execution trustworthy.
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  assertValid,
  parseJson,
  payloadDigest,
  type SchemaTypes,
} from "../../packages/contract-sdk/src/index.ts";
import { rootPath } from "../lib/build-manifest.ts";
import { type PhaseCheck, ROOT, type TestEntry } from "../lib/registry.ts";
import { artifactBytes } from "./artifacts.ts";
import { caseId, toolCases } from "./catalog.ts";

type Run = SchemaTypes["P0TestRunEvidence"];
type Artifact = SchemaTypes["EvidenceArtifact"];
type Manifest = SchemaTypes["P0BuildManifest"];
export const NODE_REPORTER = "--test-reporter=./tools/acceptance/node-reporter.ts";
export const nodeCommand = (runner: string) => ["node", "--test", NODE_REPORTER, runner];

export { artifactBytes } from "./artifacts.ts";

export function artifactJson(artifact: Artifact, root = ROOT): unknown {
  return parseJson(new TextDecoder("utf-8", { fatal: true }).decode(artifactBytes(artifact, root)));
}

type NodeCase = { title: string; status: "PASS" | "FAIL" | "SKIP"; duration_ms: number };
export function readNodeExecution(
  bytes: Buffer,
  runnerFile: string,
): {
  cases: NodeCase[];
  completed: boolean;
  passed: boolean;
} {
  const wire = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!wire.endsWith("\n")) throw new Error("truncated node:test output");
  const rows = wire
    .trimEnd()
    .split("\n")
    .map(
      (line) =>
        parseJson(line) as {
          sequence: number;
          event: { type: string; data: Record<string, unknown> };
        },
    );
  if (
    !rows.length ||
    rows.some((row, i) => row.sequence !== i || !row.event?.type || !row.event.data)
  )
    throw new Error("incomplete node:test event sequence");
  const runner = resolve(runnerFile);
  for (const { event } of rows) {
    for (const field of ["file", "entryFile"])
      if (event.data[field] !== undefined && event.data[field] !== runner)
        throw new Error("node:test event source differs from registered runner");
  }
  const completions = rows.filter(
    ({ event }) => event.type === "test:complete" && event.data.entryFile !== undefined,
  );
  const matched = new Set<number>();
  const cases: NodeCase[] = [];
  for (const { event, sequence } of rows) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const data = event.data;
    if (data.nesting !== 0)
      throw new Error("node:test nested cases need an explicit catalog adapter");
    if (data.file !== runner || data.entryFile !== runner)
      throw new Error("node:test case source missing or different from registered runner");
    const details = data.details as { duration_ms: number };
    if (
      typeof data.name !== "string" ||
      !details ||
      !Number.isFinite(details.duration_ms) ||
      details.duration_ms < 0
    )
      throw new Error("malformed node:test case");
    const matches = completions.filter(({ event: complete }) =>
      ["name", "testId", "parentId", "testNumber", "nesting", "file", "entryFile"].every((field) =>
        isDeepStrictEqual(complete.data[field], data[field]),
      ),
    );
    const completion = matches[0];
    if (
      !completion ||
      matches.length !== 1 ||
      matched.has(completion.sequence) ||
      completion.sequence >= sequence
    )
      throw new Error("node:test case completion missing or duplicated");
    const completedDetails = completion.event.data.details as Record<string, unknown>;
    if (
      !completedDetails ||
      completedDetails.passed !== (event.type === "test:pass") ||
      completedDetails.duration_ms !== details.duration_ms ||
      !isDeepStrictEqual(completion.event.data.skip, data.skip) ||
      !isDeepStrictEqual(completion.event.data.todo, data.todo)
    )
      throw new Error("node:test completion/result mismatch");
    matched.add(completion.sequence);
    cases.push({
      title: data.name,
      status:
        data.skip !== undefined || data.todo !== undefined
          ? "SKIP"
          : event.type === "test:pass"
            ? "PASS"
            : "FAIL",
      duration_ms: Math.ceil(details.duration_ms),
    });
  }
  if (matched.size !== completions.length)
    throw new Error("node:test completion has no matching result");
  const end = rows.at(-1)?.event;
  if (end?.type !== "test:summary") throw new Error("missing final node:test summary");
  const counts = end.data.counts as Record<string, number>;
  if (
    !counts ||
    cases.length === 0 ||
    counts.tests !== cases.length ||
    counts.topLevel !== cases.length ||
    counts.suites !== 0 ||
    new Set(cases.map((c) => c.title)).size !== cases.length
  )
    throw new Error("node:test summary/case mismatch");
  const countNames = [
    "tests",
    "failed",
    "passed",
    "cancelled",
    "skipped",
    "todo",
    "topLevel",
    "suites",
  ];
  if (
    countNames.some((name) => !Number.isSafeInteger(counts[name]) || (counts[name] ?? -1) < 0) ||
    typeof end.data.duration_ms !== "number" ||
    !Number.isFinite(end.data.duration_ms) ||
    end.data.duration_ms < 0
  )
    throw new Error("invalid node:test counts or duration");
  const summaries = rows.filter(({ event }) => event.type === "test:summary");
  const fileSummary = summaries[0]?.event;
  const fileCompletions = rows.filter(
    ({ event }) => event.type === "test:complete" && event.data.entryFile === undefined,
  );
  const fileCompletion = fileCompletions[0]?.event.data.details as
    | Record<string, unknown>
    | undefined;
  if (
    summaries.length !== 2 ||
    fileSummary?.data.file !== runner ||
    fileSummary.data.entryFile !== runner ||
    end.data.file !== undefined ||
    end.data.entryFile !== undefined ||
    !isDeepStrictEqual(fileSummary.data.counts, counts) ||
    fileSummary.data.success !== end.data.success ||
    fileCompletions.length !== 1 ||
    fileCompletions[0]?.event.data.file !== runner ||
    fileCompletion?.passed !== end.data.success
  )
    throw new Error("node:test file/final summary mismatch");
  const passed =
    end.data.success === true &&
    counts.failed === 0 &&
    counts.passed === cases.length &&
    counts.cancelled === 0 &&
    counts.skipped === 0 &&
    counts.todo === 0 &&
    cases.every((c) => c.status === "PASS");
  return { cases, completed: true, passed };
}

export function toolAssertions(testId: string, cases: readonly NodeCase[]): Run["assertions"] {
  return cases.map((item) => ({
    assertion_id: caseId(testId, item.title),
    scenario_id: caseId(testId, item.title),
    expected: "PASS",
    observed: item.status,
    passed: item.status === "PASS",
  }));
}

export function validateRun(
  test: TestEntry | PhaseCheck,
  result: SchemaTypes["TestEvidence"],
  digest: string,
  current: { sut: Manifest; runner: Manifest; environment: Run["environment"] },
  root = ROOT,
): Run {
  const parsed = result.artifacts.map((artifact) => artifactJson(artifact, root));
  const runs = parsed.filter(
    (item) =>
      item &&
      typeof item === "object" &&
      "artifact_type" in item &&
      item.artifact_type === "p0-test-run",
  );
  if (runs.length !== 1) throw new Error("one complete p0-test-run artifact required");
  const run = runs[0];
  assertValid("P0TestRunEvidence", run);
  if (
    run.test_id !== test.id ||
    run.source_digest !== digest ||
    !run.completed ||
    run.exit_code !== 0
  )
    throw new Error("execution identity, completion or exit mismatch");
  if (
    result.sut_build_digest !== current.sut.digest ||
    run.sut_build_digest !== current.sut.digest ||
    run.runner_manifest_digest !== current.runner.digest
  )
    throw new Error("SUT build or runner dependency fingerprint stale");
  for (const [reference, expected] of [
    [run.sut_manifest, current.sut],
    [run.runner_manifest, current.runner],
  ] as const) {
    const manifest = artifactJson(reference, root);
    assertValid("P0BuildManifest", manifest);
    if (!isDeepStrictEqual(manifest, expected)) throw new Error("current build manifest mismatch");
  }
  if (
    !isDeepStrictEqual(run.environment, current.environment) ||
    !isDeepStrictEqual(result.environment, run.environment)
  )
    throw new Error("execution environment missing or changed");
  if (
    new Set(run.scenario_ids).size !== run.scenario_ids.length ||
    new Set(run.assertions.map((a) => a.assertion_id)).size !== run.assertions.length
  )
    throw new Error("duplicate scenario/assertion");
  const artifactKeys = new Set(run.raw_artifacts.map((a) => `${a.path}:${a.sha256}`));
  if (artifactKeys.size !== run.raw_artifacts.length) throw new Error("duplicate raw artifact");
  for (const artifact of run.raw_artifacts) artifactBytes(artifact, root);
  for (const artifact of [...run.process_outputs, ...run.trace.map((t) => t.raw_artifact)]) {
    if (!artifactKeys.has(`${artifact.path}:${artifact.sha256}`))
      throw new Error("raw evidence missing referenced fragment");
    artifactBytes(artifact, root);
  }
  if (
    run.trace.some(
      (entry, index) => entry.index !== index || entry.payload_sha256 !== entry.raw_artifact.sha256,
    )
  )
    throw new Error("trace sequence or payload hash mismatch");
  if (
    run.assertions.some(
      (a) =>
        !run.scenario_ids.includes(a.scenario_id) ||
        !a.passed ||
        !isDeepStrictEqual(a.expected, a.observed),
    )
  )
    throw new Error("assertion failed or inconsistent with actual values");
  if (
    run.summary.failed_assertions !== 0 ||
    run.summary.passed_assertions !== run.assertions.length
  )
    throw new Error("assertion summary mismatch");
  if (run.scenario_ids.some((id) => !run.assertions.some((a) => a.scenario_id === id)))
    throw new Error("scenario has no executed assertion");
  const requirements =
    "evidence_required" in test ? test.evidence_required : test.required_evidence;
  const provided = new Set([
    "sut_build_digest",
    "environment",
    "command",
    "exit_code",
    "seed_or_trace",
    "expected_and_observed",
    "build_manifests",
    "runner_dependency_digest",
    "raw_artifact_hashes",
    "scenario_coverage",
  ]);
  const isTool = "adapter" in test && test.adapter === "contract_tools";
  if (isTool) {
    if (!test.runner || !isDeepStrictEqual(run.command, nodeCommand(test.runner)))
      throw new Error("tool command does not execute the complete registered suite");
    const filenames = ["command.json", "node-events.ndjson", "stderr.txt"];
    const artifacts = filenames.map((name) => {
      const matches = run.raw_artifacts.filter((item) => item.path.endsWith(`/${name}`));
      if (matches.length !== 1) throw new Error(`required tool output missing: ${name}`);
      return matches[0] as Artifact;
    });
    const [command, events, stderr] = artifacts as [Artifact, Artifact, Artifact];
    const base = command.path.slice(0, -"command.json".length);
    if (
      !base.endsWith(`/${test.id}/`) ||
      !isDeepStrictEqual(run.raw_artifacts, artifacts) ||
      !isDeepStrictEqual(run.process_outputs, [events, stderr]) ||
      run.trace.length !== 3 ||
      artifacts.some((item, index) => item.path !== `${base}${filenames[index]}`)
    )
      throw new Error("tool output triplet or process output association incomplete");
    const names = ["executed_command", "node_test_events", "process_stderr"];
    if (
      run.trace.some(
        (item, index) =>
          item.name !== names[index] ||
          item.source_role !== "runner" ||
          item.source_instance_id !== run.run_id ||
          item.kind !== "process" ||
          item.observed_at.clock_domain !== `runner:${run.run_id}` ||
          !isDeepStrictEqual(item.raw_artifact, artifacts[index]),
      )
    )
      throw new Error("tool output trace association mismatch");
    const commandRecord = artifactJson(command, root);
    if (
      !isDeepStrictEqual(commandRecord, {
        command: run.command,
        exit_code: run.exit_code,
        signal: null,
        error: null,
      })
    )
      throw new Error("actual command/exit record mismatch");
    const execution = readNodeExecution(artifactBytes(events, root), rootPath(root, test.runner));
    if (
      !execution.passed ||
      !isDeepStrictEqual(toolAssertions(test.id, execution.cases), run.assertions)
    )
      throw new Error("node:test observations disagree with assertions");
    const expected = toolCases(test.id, test.runner, root)
      .map((c) => c.id)
      .sort();
    if (!isDeepStrictEqual([...run.scenario_ids].sort(), expected))
      throw new Error("required tool scenario missing or unexpected");
    if (
      !isDeepStrictEqual(
        execution.cases.map((c) => c.duration_ms),
        run.summary.latency_samples_ms,
      )
    )
      throw new Error("latency observations disagree with raw output");
    if (
      run.profile_digest !== null ||
      run.endpoint_facts.length ||
      run.session_facts.length ||
      run.transition_coverage.length ||
      run.dependency_gates.length ||
      [
        run.summary.rejected_operations,
        run.summary.failed_operations,
        run.summary.unknown_operations,
        run.summary.completed_effect_units,
        run.summary.cleanup_confirmed,
        run.summary.cleanup_unknown,
      ].some((n) => n !== 0)
    )
      throw new Error("tool tests must not claim SUT facts");
  } else {
    // A catalog and self-consistent arrays cannot substitute for a raw SUT decoder.
    // W7 must implement source-bound process/fact/reduction verification first.
    throw new Error("SUT raw process/fact/reduction evidence adapter not implemented");
  }
  for (const name of requirements)
    if (!provided.has(name)) throw new Error(`required evidence unsupported or missing: ${name}`);
  return run;
}

export function manifestAs(kind: "sut" | "runner", original: Manifest): Manifest {
  const { digest: _digest, ...body } = original;
  const changed = { ...body, kind };
  return { ...changed, digest: payloadDigest(changed) };
}
