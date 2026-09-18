import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import type { SchemaTypes } from "../packages/contract-sdk/src/index.ts";
import { evaluate, sourceDigest } from "../tools/gate.ts";
import { loadRegistry, ROOT, type Verification } from "../tools/lib/registry.ts";

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

test("gate.coverage: stale, skipped, corrupt and unimplemented evidence cannot pass", () => {
  const verification: Verification = {
    schema_version: "0.8.0",
    phase_dependencies: { P0: [] },
    tests: [
      {
        id: "sdk.json",
        invariant_id: null,
        phase: "P0",
        implementation_status: "IMPLEMENTED",
        runner: "tests/json.test.ts",
        adapter: "contract_tools",
        evidence_required: [],
      },
    ],
    phase_checks: [],
  };
  mkdirSync(join(ROOT, "reports"), { recursive: true });
  const folder = mkdtempSync(join(ROOT, "reports", "gate-test-"));
  try {
    const artifact = join(folder, "evidence.txt");
    writeFileSync(artifact, "unit-only fixture evidence");
    const report: SchemaTypes["AcceptanceReport"] = {
      source_digest: sourceDigest(),
      tests: [
        {
          id: "sdk.json",
          status: "PASS",
          executed_at: new Date().toISOString(),
          environment: { fixture: true },
          runner_sha256: sha256(readFileSync(join(ROOT, "tests/json.test.ts"))),
          sut_build_digest: null,
          artifacts: [
            {
              path: relative(ROOT, artifact).replaceAll("\\", "/"),
              sha256: sha256("unit-only fixture evidence"),
            },
          ],
        },
      ],
    };
    assert.equal(evaluate(["P0"], verification, report).status, "PASS");

    const [result] = report.tests;
    assert.ok(result);
    for (const change of [
      { status: "SKIP" as const },
      { runner_sha256: "0".repeat(64) },
      { artifacts: [{ ...(result.artifacts[0] as { path: string }), sha256: "0".repeat(64) }] },
    ]) {
      const bad: SchemaTypes["AcceptanceReport"] = { ...report, tests: [{ ...result, ...change }] };
      assert.equal(evaluate(["P0"], verification, bad).status, "PENDING", JSON.stringify(change));
    }
    const stale = { ...report, source_digest: "0".repeat(64) };
    assert.equal(evaluate(["P0"], verification, stale).status, "PENDING");

    const unimplemented = structuredClone(verification);
    Object.assign(unimplemented.tests[0] ?? {}, {
      implementation_status: "NOT_IMPLEMENTED",
      runner: null,
    });
    assert.equal(evaluate(["P0"], unimplemented, report).status, "PENDING");

    assert.throws(() => evaluate(["P0"], verification, { ...report, tests: [result, result] }));
    assert.throws(() =>
      evaluate(["P0"], verification, { ...report, tests: [{ ...result, id: "unknown" }] }),
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("gate.coverage: registered phases stay PENDING without evidence and include dependencies", () => {
  const result = evaluate(["P1"], loadRegistry().verification);
  assert.equal(result.status, "PENDING");
  assert.deepEqual(result.phases, ["P0", "P1"]);
  assert.ok(result.blockers.some((b) => b.includes("NOT_IMPLEMENTED")));
  assert.throws(() => evaluate(["P5"], loadRegistry().verification), /Unknown phase/);
});
