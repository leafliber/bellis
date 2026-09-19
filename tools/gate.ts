// P0 gate binds reviewed execution records to the current source, runner, installed
// dependencies and raw reports. Local hashes are not an authenticity signature.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { assertValid, type SchemaTypes } from "../packages/contract-sdk/src/index.ts";
import { writeArtifact } from "./acceptance/artifacts.ts";
import { manifestAs, validateRun } from "./acceptance/evidence.ts";
import { buildManifest, executionEnvironment, sha256, sourceDigest } from "./lib/build-manifest.ts";
import { loadRegistry, phaseClosure, ROOT, readJson, type Verification } from "./lib/registry.ts";

export { sourceDigest } from "./lib/build-manifest.ts";

export interface GateResult {
  status: "PASS" | "PENDING";
  phases: string[];
  required_test_ids: string[];
  blockers: string[];
  source_digest: string;
}

/** root is injectable for isolated tool fixtures; the CLI always uses the actual repository. */
export function evaluate(
  selected: readonly string[],
  verification: Verification,
  evidence?: SchemaTypes["AcceptanceReport"],
  root = ROOT,
): GateResult {
  const phases = phaseClosure(verification, selected);
  const required = [...verification.tests, ...verification.phase_checks].filter((t) =>
    phases.has(t.phase),
  );
  const digest = sourceDigest(root);
  const blockers: string[] = [];
  if (!evidence) blockers.push("No acceptance evidence supplied");
  else assertValid("AcceptanceReport", evidence);
  if (evidence?.source_digest !== digest)
    blockers.push("Evidence missing or stale for current contract sources");
  const observed = new Map<string, SchemaTypes["TestEvidence"]>();
  for (const result of evidence?.tests ?? []) {
    if (observed.has(result.id)) throw new Error(`Duplicate evidence test id: ${result.id}`);
    observed.set(result.id, result);
  }
  const known = new Set([...verification.tests, ...verification.phase_checks].map((t) => t.id));
  const unknown = [...observed.keys()].filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`Unknown evidence test ids: ${unknown.join(", ")}`);
  let current: Parameters<typeof validateRun>[3] | undefined;
  if (evidence?.tests.some((t) => t.status === "PASS")) {
    try {
      const sut = buildManifest("sut", root);
      current = {
        sut,
        runner: manifestAs("runner", sut),
        environment: executionEnvironment(sut.dependencies, root),
      };
    } catch (error) {
      blockers.push(`Current build/environment unavailable: ${String(error)}`);
    }
  }
  for (const test of required) {
    const id = test.id;
    if (test.implementation_status !== "IMPLEMENTED") {
      blockers.push(`${id}: NOT_IMPLEMENTED`);
      continue;
    }
    const runner = test.runner ? join(root, test.runner) : null;
    if (!runner || !existsSync(runner)) {
      blockers.push(`${id}: runner missing`);
      continue;
    }
    const result = observed.get(id);
    if (result?.status !== "PASS") {
      blockers.push(`${id}: ${result?.status ?? "PENDING"}`);
      continue;
    }
    if (result.runner_sha256 !== sha256(readFileSync(runner)))
      blockers.push(`${id}: runner fingerprint missing or stale`);
    if (!result.executed_at || !result.environment)
      blockers.push(`${id}: execution provenance missing`);
    if (current) {
      try {
        validateRun(test, result, digest, current, root);
      } catch (error) {
        blockers.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return {
    status: blockers.length ? "PENDING" : "PASS",
    phases: Object.keys(verification.phase_dependencies).filter((p) => phases.has(p)),
    required_test_ids: required.map((t) => t.id),
    blockers,
    source_digest: digest,
  };
}

export function writeGateOutput(output: string, text: string, root = ROOT): void {
  if (isAbsolute(output) && resolve(output) !== output)
    throw new Error("Gate output must be canonical and under reports");
  writeArtifact(isAbsolute(output) ? relative(root, output) : output, text, root);
}

function main() {
  const { values } = parseArgs({
    options: {
      phase: { type: "string", multiple: true },
      evidence: { type: "string" },
      output: { type: "string" },
    },
  });
  if (!values.phase?.length) {
    console.error("Usage: pnpm gate --phase P0 [--evidence FILE] [--output FILE]");
    process.exitCode = 1;
    return;
  }
  const evidence = values.evidence
    ? readJson<SchemaTypes["AcceptanceReport"]>(resolve(values.evidence))
    : undefined;
  const result = evaluate(values.phase, loadRegistry().verification, evidence);
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (values.output) {
    writeGateOutput(values.output, text);
    console.error(`Wrote ${relative(process.cwd(), resolve(values.output))}`);
  }
  process.stdout.write(text);
  process.exitCode = result.status === "PASS" ? 0 : 2;
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(ROOT, "tools/gate.ts")) main();
