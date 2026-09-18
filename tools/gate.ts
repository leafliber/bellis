// Phase gate: a phase passes only when every required test is implemented, ran on the
// current contract sources, passed, and left hashed raw evidence under reports/.
//   pnpm gate --phase P0 [--phase P1] [--evidence reports/acceptance.json] [--output reports/gate.json]
// Exit code 0 = PASS, 2 = PENDING. The JSON report does not prove evidence authenticity;
// a trusted test runner and release review do.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { assertValid, type SchemaTypes } from "../packages/contract-sdk/src/index.ts";
import {
  loadRegistry,
  phaseClosure,
  ROOT,
  readJson,
  SRC,
  type Verification,
} from "./lib/registry.ts";

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** Digest over every contract source file; evidence must name the digest it ran against. */
export function sourceDigest(): string {
  const digest = createHash("sha256");
  for (const name of readdirSync(SRC)
    .filter((f) => f.endsWith(".json"))
    .sort()) {
    digest
      .update(`${name}\0`)
      .update(readFileSync(join(SRC, name)))
      .update("\0");
  }
  return digest.digest("hex");
}

export interface GateResult {
  status: "PASS" | "PENDING";
  phases: string[];
  required_test_ids: string[];
  blockers: string[];
  source_digest: string;
}

export function evaluate(
  selected: readonly string[],
  verification: Verification,
  evidence?: SchemaTypes["AcceptanceReport"],
): GateResult {
  const phases = phaseClosure(verification, selected);
  const required = [...verification.tests, ...verification.phase_checks].filter((t) =>
    phases.has(t.phase),
  );
  const digest = sourceDigest();
  const blockers: string[] = [];
  if (!evidence) blockers.push("No acceptance evidence supplied");
  else assertValid("AcceptanceReport", evidence);
  if (evidence?.source_digest !== digest) {
    blockers.push("Evidence missing or stale for current contract sources");
  }
  const observed = new Map<string, SchemaTypes["TestEvidence"]>();
  for (const result of evidence?.tests ?? []) {
    if (observed.has(result.id)) throw new Error(`Duplicate evidence test id: ${result.id}`);
    observed.set(result.id, result);
  }
  const known = new Set([...verification.tests, ...verification.phase_checks].map((t) => t.id));
  const unknown = [...observed.keys()].filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`Unknown evidence test ids: ${unknown.join(", ")}`);

  const reports = resolve(ROOT, "reports") + sep;
  for (const test of required) {
    const id = test.id;
    if (test.implementation_status !== "IMPLEMENTED") {
      blockers.push(`${id}: NOT_IMPLEMENTED`);
      continue;
    }
    const runner = test.runner ? join(ROOT, test.runner) : null;
    if (!runner || !existsSync(runner)) {
      blockers.push(`${id}: runner missing`);
      continue;
    }
    const result = observed.get(id);
    if (result?.status !== "PASS") {
      blockers.push(`${id}: ${result?.status ?? "PENDING"}`);
      continue;
    }
    if (result.runner_sha256 !== sha256(readFileSync(runner))) {
      blockers.push(`${id}: runner fingerprint missing or stale`);
    }
    if (!result.executed_at || !result.environment) {
      blockers.push(`${id}: execution provenance missing`);
    }
    const adapter = "adapter" in test ? test.adapter : undefined;
    if (adapter !== "contract_tools" && !result.sut_build_digest) {
      blockers.push(`${id}: SUT build missing`);
    }
    if (!result.artifacts.length) blockers.push(`${id}: raw evidence missing`);
    for (const artifact of result.artifacts) {
      const path = resolve(ROOT, artifact.path);
      // Gate evidence may only point at reviewable local files under reports/.
      if (!path.startsWith(reports) || !existsSync(path)) {
        blockers.push(`${id}: invalid evidence path`);
      } else if (sha256(readFileSync(path)) !== artifact.sha256) {
        blockers.push(`${id}: evidence hash mismatch`);
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

function main() {
  const { values } = parseArgs({
    options: {
      phase: { type: "string", multiple: true },
      evidence: { type: "string" },
      output: { type: "string" },
    },
  });
  if (!values.phase?.length) {
    console.error("Usage: pnpm gate --phase P0 [--phase P1] [--evidence FILE] [--output FILE]");
    process.exitCode = 1;
    return;
  }
  const evidence = values.evidence
    ? readJson<SchemaTypes["AcceptanceReport"]>(resolve(values.evidence))
    : undefined;
  const result = evaluate(values.phase, loadRegistry().verification, evidence);
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (values.output) {
    mkdirSync(dirname(resolve(values.output)), { recursive: true });
    writeFileSync(resolve(values.output), text);
    console.error(`Wrote ${relative(process.cwd(), resolve(values.output))}`);
  }
  process.stdout.write(text);
  process.exitCode = result.status === "PASS" ? 0 : 2;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(ROOT, "tools/gate.ts")) main();
