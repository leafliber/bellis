import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { SchemaTypes } from "../packages/contract-sdk/src/index.ts";
import { p0TransitionRequirements } from "../tools/acceptance/catalog.ts";
import { readNodeExecution } from "../tools/acceptance/evidence.ts";
import { runTools, writeArtifact } from "../tools/acceptance/run.ts";
import { evaluate, sourceDigest } from "../tools/gate.ts";
import { buildManifest, sha256 } from "../tools/lib/build-manifest.ts";
import { loadRegistry, ROOT, type Verification } from "../tools/lib/registry.ts";

// Isolated executable tool fixture, never a production_sut_with_fault_injection adapter.
function fixture() {
  mkdirSync(join(ROOT, "reports"), { recursive: true });
  const root = mkdtempSync(join(ROOT, "reports", "gate-test-"));
  const put = (path: string, data: string) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), data);
  };
  for (const file of [
    ".node-version",
    "package.json",
    "pnpm-lock.yaml",
    "tools/acceptance/node-reporter.ts",
  ])
    put(file, readFileSync(join(ROOT, file), "utf8"));
  put("contracts/src/fixture.json", '{"fixture_only":true}');
  put(
    "tests/fixture.test.ts",
    'import assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("sdk.json: executable isolated fixture", () => assert.equal(2 + 2, 4));\n',
  );
  put("tools/helper.ts", "export const value = 1;\n");
  put(
    "node_modules/fixture-dependency/package.json",
    '{"name":"fixture-dependency","version":"1.0.0"}',
  );
  put("node_modules/fixture-dependency/index.js", "module.exports = 1;\n");
  put("node_modules/fixture-dependency/build/Release/fixture.node", "fixture-native-content");
  const verification: Verification = {
    schema_version: "0.8.0",
    phase_dependencies: { P0: [] },
    tests: [
      {
        id: "sdk.json",
        invariant_id: null,
        phase: "P0",
        implementation_status: "IMPLEMENTED",
        runner: "tests/fixture.test.ts",
        adapter: "contract_tools",
        evidence_required: ["command", "exit_code", "environment"],
      },
    ],
    phase_checks: [],
  };
  const report = runTools("reports/run", root, verification);
  const result = report.tests[0];
  assert.ok(result);
  const rawRef = result.artifacts[0];
  assert.ok(rawRef);
  const raw = JSON.parse(
    readFileSync(join(root, rawRef.path), "utf8"),
  ) as SchemaTypes["P0TestRunEvidence"];
  const changedRaw = (change: (value: typeof raw) => void) => {
    const copy = structuredClone(raw);
    change(copy);
    const bytes = `${JSON.stringify(copy)}\n`;
    put("reports/mutated.json", bytes);
    return {
      ...report,
      tests: [{ ...result, artifacts: [{ path: "reports/mutated.json", sha256: sha256(bytes) }] }],
    };
  };
  return {
    root,
    put,
    verification,
    report,
    result,
    raw,
    changedRaw,
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("gate.coverage: stale, skipped, corrupt and unimplemented evidence cannot pass", () => {
  const f = fixture();
  try {
    assert.equal(evaluate(["P0"], f.verification, f.report, f.root).status, "PASS");
    for (const change of [
      { status: "SKIP" as const },
      { status: "FAIL" as const },
      { runner_sha256: "0".repeat(64) },
      { sut_build_digest: "0".repeat(64) },
      { artifacts: [{ path: "reports/run/sdk.json/run.json", sha256: "0".repeat(64) }] },
    ]) {
      assert.equal(
        evaluate(
          ["P0"],
          f.verification,
          { ...f.report, tests: [{ ...f.result, ...change }] },
          f.root,
        ).status,
        "PENDING",
        JSON.stringify(change),
      );
    }
    assert.equal(
      evaluate(["P0"], f.verification, { ...f.report, tests: [] }, f.root).status,
      "PENDING",
    );
    assert.equal(
      evaluate(["P0"], f.verification, { ...f.report, source_digest: "0".repeat(64) }, f.root)
        .status,
      "PENDING",
    );
    const unimplemented = structuredClone(f.verification);
    Object.assign(unimplemented.tests[0] ?? {}, {
      implementation_status: "NOT_IMPLEMENTED",
      runner: null,
    });
    assert.equal(evaluate(["P0"], unimplemented, f.report, f.root).status, "PENDING");
    assert.throws(
      () => evaluate(["P0"], f.verification, { ...f.report, tests: [f.result, f.result] }, f.root),
      /Duplicate/,
    );
    assert.throws(
      () =>
        evaluate(
          ["P0"],
          f.verification,
          { ...f.report, tests: [{ ...f.result, id: "unknown" }] },
          f.root,
        ),
      /Unknown/,
    );
  } finally {
    f.done();
  }
});

test("gate.coverage: current sources, runner helpers and installed native dependencies are rebound", () => {
  const f = fixture();
  try {
    const base = buildManifest("sut", f.root);
    assert.ok(base.files.some((item) => item.path.endsWith("fixture.node")));
    for (const file of [
      "tools/helper.ts",
      "node_modules/fixture-dependency/index.js",
      "node_modules/fixture-dependency/build/Release/fixture.node",
      "contracts/src/fixture.json",
    ]) {
      const bytes = readFileSync(join(f.root, file));
      writeFileSync(join(f.root, file), `${bytes.toString()}\n `);
      assert.equal(evaluate(["P0"], f.verification, f.report, f.root).status, "PENDING", file);
      writeFileSync(join(f.root, file), bytes);
    }
    f.put("apps/host/new-runtime.ts", "export const newInput = true;\n");
    assert.equal(evaluate(["P0"], f.verification, f.report, f.root).status, "PENDING");
    rmSync(join(f.root, "apps"), { recursive: true });
    assert.equal(buildManifest("sut", f.root).digest, base.digest);
    f.put("reports/unrelated.txt", "runtime output");
    assert.equal(buildManifest("sut", f.root).digest, base.digest);
  } finally {
    f.done();
  }
});

test("gate.coverage: missing scenarios, incomplete traces and forged summaries are rejected", () => {
  const f = fixture();
  try {
    const changes: ((raw: typeof f.raw) => void)[] = [
      (r) => {
        r.completed = false;
      },
      (r) => {
        r.exit_code = 1;
      },
      (r) => {
        r.scenario_ids = ["missing.scenario"];
      },
      (r) => {
        assert.ok(r.assertions[0]);
        r.assertions[0].observed = "FAIL";
      },
      (r) => {
        r.summary.passed_assertions++;
      },
      (r) => {
        r.raw_artifacts.pop();
      },
      (r) => {
        assert.ok(r.trace[0]);
        r.trace[0].index = 1;
      },
      (r) => {
        r.command.push("--test-name-pattern=does-not-exist");
      },
      (r) => {
        r.runner_manifest_digest = "0".repeat(64);
      },
      (r) => {
        r.summary.latency_samples_ms = [99999];
      },
    ];
    for (const change of changes)
      assert.equal(
        evaluate(["P0"], f.verification, f.changedRaw(change), f.root).status,
        "PENDING",
        String(change),
      );
    const events = f.raw.process_outputs.find((a) => a.path.endsWith("node-events.ndjson"));
    assert.ok(events);
    const bytes = readFileSync(join(f.root, events.path), "utf8");
    const truncated = `${bytes.split("\n").slice(0, -2).join("\n")}\n`;
    f.put(events.path, truncated);
    const changed = f.changedRaw((r) => {
      for (const a of [
        ...r.raw_artifacts,
        ...r.process_outputs,
        ...r.trace.map((t) => t.raw_artifact),
      ])
        if (a.path === events.path) a.sha256 = sha256(truncated);
      for (const t of r.trace)
        if (t.raw_artifact.path === events.path) t.payload_sha256 = sha256(truncated);
    });
    assert.equal(evaluate(["P0"], f.verification, changed, f.root).status, "PENDING");
  } finally {
    f.done();
  }
});

test("gate.coverage: raw corruption and symlink escapes cannot masquerade as local evidence", () => {
  const f = fixture();
  try {
    const events = f.raw.process_outputs[0];
    assert.ok(events);
    f.put(events.path, "tampered\n");
    assert.equal(evaluate(["P0"], f.verification, f.report, f.root).status, "PENDING");
    symlinkSync(join(f.root, "package.json"), join(f.root, "reports/escaped.json"));
    const escaped = {
      ...f.report,
      tests: [
        {
          ...f.result,
          artifacts: [
            {
              path: "reports/escaped.json",
              sha256: sha256(readFileSync(join(f.root, "package.json"))),
            },
          ],
        },
      ],
    };
    assert.ok(
      evaluate(["P0"], f.verification, escaped, f.root).blockers.some((b) =>
        b.includes("symlink escape"),
      ),
    );
    symlinkSync(ROOT, join(f.root, "node_modules/outside"));
    assert.throws(() => buildManifest("sut", f.root), /escapes root/);
  } finally {
    f.done();
  }
});

test("gate.coverage: workspace dependency links bind their covered target contents", () => {
  const f = fixture();
  try {
    f.put("packages/local/package.json", '{"name":"local","version":"1.0.0"}');
    f.put("packages/local/index.ts", "export const local = true;\n");
    symlinkSync("../packages/local", join(f.root, "node_modules/local"));
    const first = buildManifest("sut", f.root);
    const link = first.files.find((item) => item.path === "node_modules/local");
    assert.equal(link?.kind, "symlink");
    assert.equal(link?.symlink_target, "packages/local");
    f.put("packages/local/index.ts", "export const local = false;\n");
    assert.notEqual(buildManifest("sut", f.root).digest, first.digest);
  } finally {
    f.done();
  }
});

test("gate.coverage: command exit and raw summary cannot be repaired by rehashing outer records", () => {
  const f = fixture();
  try {
    const command = f.raw.trace.find((t) => t.name === "executed_command");
    assert.ok(command);
    const bytes = JSON.stringify({
      command: f.raw.command,
      exit_code: 1,
      signal: null,
      error: null,
    });
    f.put(command.raw_artifact.path, bytes);
    const changed = f.changedRaw((r) => {
      for (const a of [...r.raw_artifacts, ...r.trace.map((t) => t.raw_artifact)])
        if (a.path === command.raw_artifact.path) a.sha256 = sha256(bytes);
      for (const t of r.trace)
        if (t.raw_artifact.path === command.raw_artifact.path) t.payload_sha256 = sha256(bytes);
    });
    assert.ok(
      evaluate(["P0"], f.verification, changed, f.root).blockers.some((b) =>
        b.includes("command/exit"),
      ),
    );
    const events = f.raw.process_outputs[0];
    assert.ok(events);
    const wire = readFileSync(join(f.root, events.path), "utf8");
    const rows = wire
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const end = rows.at(-1);
    assert.ok(end);
    end.event.data.counts.failed = 1;
    assert.equal(
      readNodeExecution(Buffer.from(`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`)).passed,
      false,
    );
    end.event.data.counts.failed = -1;
    assert.throws(
      () => readNodeExecution(Buffer.from(`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`)),
      /counts/,
    );
  } finally {
    f.done();
  }
});

test("gate.coverage: evidence writes reject existing files and escaping parents before creating children", () => {
  const f = fixture();
  try {
    f.put("outside/keep.txt", "outside reports");
    symlinkSync(join(f.root, "outside"), join(f.root, "reports/escape"));
    assert.throws(() => writeArtifact("reports/escape/new-child/raw.txt", "x", f.root), /symlink/);
    assert.equal(existsSync(join(f.root, "outside/new-child")), false);
    assert.throws(() => writeArtifact("reports/run/acceptance.json", "x", f.root), /EEXIST/);
    assert.throws(
      () => writeArtifact("reports/../outside/new-child/raw.txt", "x", f.root),
      /escapes reports/,
    );
  } finally {
    f.done();
  }
});

test("gate.coverage: P0 coverage derives enabled transitions and rejects disabled admission", () => {
  const rows = p0TransitionRequirements(loadRegistry().machines);
  assert.ok(rows.length > 0);
  assert.ok(rows.some((r) => r.disposition === "guard_rejected"));
  assert.ok(rows.some((r) => r.disposition === "table_rejected"));
  assert.ok(rows.some((r) => r.disposition === "terminal_rejected"));
  assert.ok(
    rows
      .filter((r) => r.event === "approve_unattended")
      .every((r) => r.disposition === "disabled_rejected"),
  );
  assert.ok(rows.every((r) => r.state !== "unattended_approved"));
  const f = fixture();
  try {
    const required = structuredClone(f.verification);
    assert.ok(required.tests[0]);
    required.tests[0].evidence_required.push("unverified_extra_evidence");
    assert.equal(evaluate(["P0"], required, f.report, f.root).status, "PENDING");
    required.tests[0].adapter = "production_sut_with_fault_injection";
    assert.equal(evaluate(["P0"], required, f.report, f.root).status, "PENDING");
  } finally {
    f.done();
  }
});

test("gate.coverage: broken reporter preserves command, failure and process output artifacts", () => {
  const f = fixture();
  try {
    f.put(
      "tools/acceptance/node-reporter.ts",
      'export default async function* reporter() { yield "broken output"; }\n',
    );
    const report = runTools("reports/broken", f.root, f.verification);
    const result = report.tests[0];
    assert.ok(result);
    assert.equal(result.status, "FAIL");
    for (const name of ["command.json", "runner-error.txt", "node-events.ndjson", "stderr.txt"]) {
      const artifact: SchemaTypes["EvidenceArtifact"] | undefined = result.artifacts.find((a) =>
        a.path.endsWith(name),
      );
      assert.ok(artifact);
      assert.equal(sha256(readFileSync(join(f.root, artifact.path))), artifact.sha256);
    }
    const command = JSON.parse(
      readFileSync(join(f.root, "reports/broken/sdk.json/command.json"), "utf8"),
    );
    assert.ok(Array.isArray(command.command));
    assert.ok(Object.hasOwn(command, "exit_code"));
    assert.ok(Object.hasOwn(command, "signal"));
    assert.ok(Object.hasOwn(command, "error"));
    assert.equal(evaluate(["P0"], f.verification, report, f.root).status, "PENDING");
  } finally {
    f.done();
  }
});

test("gate.coverage: registered phases stay PENDING without evidence and include dependencies", () => {
  const result = evaluate(["P1"], loadRegistry().verification);
  assert.equal(result.status, "PENDING");
  assert.deepEqual(result.phases, ["P0", "P1"]);
  assert.ok(result.blockers.some((b) => b.includes("NOT_IMPLEMENTED")));
  assert.throws(() => evaluate(["P5"], loadRegistry().verification), /Unknown phase/);
  assert.equal(result.source_digest, sourceDigest());
});
