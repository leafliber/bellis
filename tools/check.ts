// Offline consistency checks for contracts, fixtures and docs. Never touches a device.
// Passing proves the registries, schema, fixtures and docs agree with each other; it does
// not prove any guard, moderation, device stop, latency or game outcome.
//   node tools/check.ts   (run by pnpm check); writes reports/check.json
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  parseJson,
  schemaDigest,
  validateManifest,
  validateProfile,
} from "../packages/contract-sdk/src/index.ts";
import { composeBundle, derivedDefinitions, refsOf } from "./lib/bundle.ts";
import { createAjv, refFor } from "./lib/codegen.ts";
import {
  loadRegistry,
  phaseClosure,
  type Registry,
  ROOT,
  readJson,
  type Schema,
  SRC,
} from "./lib/registry.ts";

type Result = { name: string; ok: boolean; detail?: string };
const results: Result[] = [];

function check(name: string, run: () => void): void {
  try {
    run();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}
function must(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const duplicates = (values: readonly string[]) => [
  ...new Set(values.filter((v, i) => values.indexOf(v) !== i)),
];
/** Everything reachable from `start` by repeatedly following `next`. */
function closure(start: readonly string[], next: (item: string) => readonly string[]): Set<string> {
  const seen = new Set(start);
  const queue = [...start];
  for (let item = queue.pop(); item !== undefined; item = queue.pop()) {
    for (const following of next(item)) {
      if (!seen.has(following)) {
        seen.add(following);
        queue.push(following);
      }
    }
  }
  return seen;
}
const noDuplicates = (values: readonly string[], what: string) => {
  const dup = duplicates(values);
  must(!dup.length, `Duplicate ${what}: ${dup.join(", ")}`);
};

// ---------------------------------------------------------------- sources
const sourceFiles = [
  ...readdirSync(SRC).map((f) => `contracts/src/${f}`),
  ...readdirSync(join(ROOT, "contracts/fixtures")).map((f) => `contracts/fixtures/${f}`),
].filter((f) => f.endsWith(".json"));
for (const file of sourceFiles) check(`json.strict:${file}`, () => void readJson(join(ROOT, file)));

let registry: Registry;
try {
  registry = loadRegistry();
} catch (error) {
  console.error(`Cannot load contracts/src: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
const reg = registry;
const bundle = composeBundle(reg);
const defs = bundle.$defs;
const knownPhases = new Set(Object.keys(reg.verification.phase_dependencies));
const version = readJson<{ version: string }>(join(ROOT, "package.json")).version;

check("versions", () => {
  for (const [file, value] of Object.entries(reg.files)) {
    if ("schema_version" in value) {
      must(value.schema_version === version, `${file} schema_version != ${version}`);
    }
  }
  const sdk = readJson<{ version: string }>(join(ROOT, "packages/contract-sdk/package.json"));
  must(sdk.version === version, "packages/contract-sdk version drifted");
  for (const [name, def] of Object.entries(defs)) {
    const props = (def.properties ?? {}) as Record<string, Schema>;
    for (const key of ["schema_version", "protocol_version"]) {
      const value = props[key]?.const;
      if (value !== undefined) must(value === version, `${name}.${key} const != ${version}`);
    }
  }
});

check("phases", () => {
  phaseClosure(reg.verification, [...knownPhases]); // unknown dependency or cycle throws
  const tagged: [string, string][] = [
    ...reg.machines.flatMap((m) => [
      [`machine ${m.id}`, m.phase] as [string, string],
      ...m.transitions.map((t) => [`${m.id}.${t.event}`, t.phase] as [string, string]),
    ]),
    ...reg.events.map((e) => [`event ${e.event_name}`, e.phase] as [string, string]),
    ...reg.errors.map((e) => [`error ${e.reason_code}`, e.phase] as [string, string]),
    ...reg.commands.map((c) => [`command ${c.name}`, c.phase] as [string, string]),
    ...reg.invariants.map((i) => [`invariant ${i.id}`, i.first_required_phase] as [string, string]),
    ...reg.verification.tests.map((t) => [`test ${t.id}`, t.phase] as [string, string]),
    ...reg.contracts.contracts.map((c) => [`contract ${c.ref}`, c.phase] as [string, string]),
  ];
  const outside = tagged.filter(([, phase]) => !knownPhases.has(phase));
  must(
    !outside.length,
    `Entries outside the active phases (move them to docs/future/contracts): ${outside.map(([n, p]) => `${n}=${p}`).join(", ")}`,
  );
  const checks = reg.verification.phase_checks.map((c) => c.phase);
  noDuplicates(checks, "phase_check");
  must(
    [...knownPhases].every((p) => checks.includes(p)),
    "Every phase needs one phase_check (exit test)",
  );
});

// ---------------------------------------------------------------- schema
check("schema.derived-not-hand-written", () => {
  const clash = Object.keys(derivedDefinitions(reg)).filter((n) => n in reg.schema.$defs);
  must(!clash.length, `Defined by hand but owned by the generator: ${clash.join(", ")}`);
});
check("schema.local-refs", () => {
  for (const ref of refsOf(bundle)) {
    must(ref.startsWith("#/$defs/"), `Non-local $ref ${ref}`);
    must(ref.slice(8) in defs, `Dangling $ref ${ref}`);
  }
});
check("schema.compiles-strict", () => {
  const ajv = createAjv(bundle);
  for (const name of Object.keys(defs)) must(ajv.getSchema(refFor(bundle, name)), name);
});

// ---------------------------------------------------------------- state machines
const guardIds = new Set(reg.guards.map((g) => g.id));
check("fsm.unique", () =>
  noDuplicates(
    reg.machines.map((m) => m.id),
    "machine id",
  ),
);
for (const m of reg.machines) {
  check(`fsm.${m.id}`, () => {
    const states = new Set(m.states);
    must(states.has(m.initial), `initial ${m.initial} is not a state`);
    for (const s of m.terminal) must(states.has(s), `terminal ${s} is not a state`);
    const pairs: string[] = [];
    const forward = new Map<string, string[]>();
    const backward = new Map<string, string[]>();
    for (const t of m.transitions) {
      must(guardIds.has(t.guard), `unregistered guard ${t.guard}`);
      must(states.has(t.target), `unknown target ${t.target}`);
      for (const source of t.source) {
        must(states.has(source), `unknown source ${source}`);
        must(!m.terminal.includes(source), `terminal ${source} has an outgoing transition`);
        pairs.push(`${source}+${t.event}`);
        forward.set(source, [...(forward.get(source) ?? []), t.target]);
        backward.set(t.target, [...(backward.get(t.target) ?? []), source]);
      }
    }
    noDuplicates(pairs, "(state, event)");
    const reachable = closure([m.initial], (s) => forward.get(s) ?? []);
    must(
      reachable.size === states.size,
      `unreachable: ${m.states.filter((s) => !reachable.has(s))}`,
    );
    // Machines without absorbing states (SupervisionMode) must be able to return to "stopped".
    const ends = m.terminal.length ? m.terminal : ["stopped"];
    const canEnd = closure(ends, (s) => backward.get(s) ?? []);
    must(
      canEnd.size === states.size,
      `no path to a terminal: ${m.states.filter((s) => !canEnd.has(s))}`,
    );
  });
}
check("fsm.guards-used", () => {
  const used = new Set([
    ...reg.machines.flatMap((m) => m.transitions.map((t) => t.guard)),
    ...reg.contracts.contracts.flatMap((c) => c.admission_guards ?? []),
  ]);
  noDuplicates(
    reg.guards.map((g) => g.id),
    "guard",
  );
  const unused = reg.guards.filter((g) => !used.has(g.id)).map((g) => g.id);
  must(!unused.length, `Registered but unused guards: ${unused.join(", ")}`);
});

// ---------------------------------------------------------------- object records
const isClosedRecord = (name: string) => {
  const def = defs[name];
  must(def, `Missing record schema ${name}`);
  must(def.additionalProperties === false, `${name} accepts unknown fields`);
  const props = Object.keys((def.properties ?? {}) as object).sort();
  must(
    JSON.stringify([...((def.required ?? []) as string[])].sort()) === JSON.stringify(props),
    `${name}: every field must be required (use explicit null)`,
  );
};
for (const m of reg.machines) {
  check(`records.${m.id}`, () => {
    const bindings = reg.records.records.filter((r) => r.machine === m.id);
    must(bindings.length === 1, `needs exactly one record binding, found ${bindings.length}`);
    const [binding] = bindings;
    if (!binding) return;
    isClosedRecord(binding.schema);
    const properties = (defs[binding.schema]?.properties ?? {}) as Record<string, Schema>;
    const field = properties[binding.state_field];
    must(
      field?.$ref === `#/$defs/${m.id}State`,
      `${binding.schema}.${binding.state_field} must be {"$ref": "#/$defs/${m.id}State"}`,
    );
  });
}
check("records.bindings-known", () => {
  const ids = new Set(reg.machines.map((m) => m.id));
  const stray = reg.records.records.filter((r) => !ids.has(r.machine)).map((r) => r.machine);
  must(!stray.length, `Bindings for unknown machines: ${stray.join(", ")}`);
  for (const name of [...reg.records.support_types, ...reg.records.artifact_types])
    isClosedRecord(name);
});

// ---------------------------------------------------------------- registries
const reasonCodes = new Set(reg.errors.map((e) => e.reason_code));
check("events", () => {
  noDuplicates(
    reg.events.map((e) => e.event_name),
    "event",
  );
  const commands = new Set(reg.commands.map((c) => c.name));
  for (const e of reg.events) {
    must(e.payload_schema in defs, `${e.event_name}: unknown payload ${e.payload_schema}`);
    must(!commands.has(e.event_name), `${e.event_name} is a command, not a fact`);
  }
});
check("commands", () => {
  noDuplicates(
    reg.commands.map((c) => c.name),
    "command",
  );
  for (const c of reg.commands) {
    must(c.input_schema in defs && c.result_schema in defs, `${c.name}: unknown schema`);
    must(
      c.unsupported_reason === null || reasonCodes.has(c.unsupported_reason),
      `${c.name}: unregistered unsupported_reason`,
    );
  }
});
check("errors", () =>
  noDuplicates(
    reg.errors.map((e) => e.reason_code),
    "reason_code",
  ),
);
check("contracts", () => {
  noDuplicates(
    reg.contracts.contracts.map((c) => c.ref),
    "contract ref",
  );
  for (const c of reg.contracts.contracts) {
    must(c.schema in defs, `${c.ref}: unknown schema ${c.schema}`);
    for (const g of c.admission_guards ?? []) must(guardIds.has(g), `${c.ref}: unknown guard ${g}`);
  }
});
check("epochs", () =>
  noDuplicates(
    reg.epochs.fields.map((f) => f.field),
    "epoch field",
  ),
);

check("invariants-and-tests", () => {
  const tests = new Map(reg.verification.tests.map((t) => [t.id, t]));
  noDuplicates(
    [...reg.verification.tests, ...reg.verification.phase_checks].map((t) => t.id),
    "test id",
  );
  noDuplicates(
    reg.invariants.map((i) => i.id),
    "invariant id",
  );
  const invariantIds = new Set(reg.invariants.map((i) => i.id));
  for (const i of reg.invariants) {
    must(/^I\d{2,3}$/.test(i.id), `${i.id}: invariant ids look like I01`);
    must(i.test_ids.length, `${i.id}: no test ids`);
    for (const id of i.test_ids) {
      const t = tests.get(id);
      must(t, `${i.id}: unknown test ${id}`);
      must(
        t.invariant_id === i.id && t.phase === i.first_required_phase,
        `${id}: invariant/phase binding drifted`,
      );
    }
    must(
      ["PENDING_SUT", "PASS"].includes(i.verification_status),
      `${i.id}: status must be PENDING_SUT or PASS`,
    );
    if (i.verification_status === "PASS") {
      must(
        i.test_ids.every((id) => {
          const t = tests.get(id);
          return t?.implementation_status === "IMPLEMENTED" && t.adapter !== "contract_tools";
        }),
        `${i.id}: PASS needs implemented SUT tests (contract-tool tests cannot close an invariant)`,
      );
    }
  }
  for (const t of [...reg.verification.tests, ...reg.verification.phase_checks]) {
    if ("invariant_id" in t && t.invariant_id !== null) {
      must(invariantIds.has(t.invariant_id), `${t.id}: unknown invariant ${t.invariant_id}`);
      // The requirement and test direction are written once, in invariants.json.
      must(
        !("procedure" in t) && !("expected" in t),
        `${t.id}: procedure/expected belong in invariants.json (requirement/scenario)`,
      );
    } else if ("invariant_id" in t) {
      must(t.procedure && t.expected, `${t.id}: tool tests need procedure and expected`);
    }
    if (t.implementation_status === "IMPLEMENTED") {
      must(t.runner && existsSync(join(ROOT, t.runner)), `${t.id}: runner file missing`);
    } else {
      must(t.runner === null, `${t.id}: unimplemented test must not name a runner`);
    }
  }
});

// ---------------------------------------------------------------- fixtures
check("fixtures.runtime-profile", () => {
  validateProfile(readJson(join(ROOT, "contracts/fixtures/runtime-profile.json")));
});
check("fixtures.plugin-manifest", () => {
  // The checked-in sample carries a zero digest; the SDK compares against the current bundle.
  const manifest = readJson<Record<string, unknown>>(
    join(ROOT, "contracts/fixtures/plugin-manifest.json"),
  );
  validateManifest({ ...manifest, schema_digest: schemaDigest });
});

// ---------------------------------------------------------------- docs
const DOC_ROOTS = ["README.md", "AGENTS.md", "CLAUDE.md", "contracts/README.md", "docs"];
const FROZEN = join(ROOT, "docs/future");
const markdownFiles = (path: string): string[] => {
  const full = join(ROOT, path);
  if (!existsSync(full) || full.startsWith(FROZEN)) return [];
  if (statSync(full).isFile()) return full.endsWith(".md") ? [full] : [];
  return readdirSync(full).flatMap((name) => markdownFiles(relative(ROOT, join(full, name))));
};
const docs = DOC_ROOTS.flatMap(markdownFiles);
const text = new Map(docs.map((f) => [f, readFileSync(f, "utf8")]));
const rel = (f: string) => relative(ROOT, f);

/** Section ids from headings like "### 12.5 标题", "## 12. 标题", "## 附录A 标题", "### A.14 标题". */
const sectionIds = new Set<string>();
for (const dir of ["docs/spec", "docs/future/spec"]) {
  if (!existsSync(join(ROOT, dir))) continue;
  for (const name of readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".md"))) {
    const body = readFileSync(join(ROOT, dir, name), "utf8");
    for (const [, id] of body.matchAll(/^#{2,4}\s+(\d+(?:\.\d+)*|[A-D](?:\.\d+)*)\.?\s/gm)) {
      sectionIds.add(id as string);
    }
    for (const [, letter] of body.matchAll(/^##\s+附录([A-D])\s/gm))
      sectionIds.add(letter as string);
  }
}

check("docs.links", () => {
  const broken: string[] = [];
  for (const [file, body] of text) {
    for (const [, target] of body.matchAll(/\]\(([^)\s]+)\)/g)) {
      const path = (target as string).split("#")[0] ?? "";
      if (!path || /^[a-z]+:/i.test(path)) continue;
      if (!existsSync(resolve(dirname(file), decodeURI(path))))
        broken.push(`${rel(file)} -> ${target}`);
    }
  }
  must(!broken.length, `Broken relative links:\n${broken.join("\n")}`);
});
check("docs.section-refs", () => {
  const missing: string[] = [];
  const verify = (file: string, id: string) => {
    if (!sectionIds.has(id)) missing.push(`${rel(file)}: ${id}`);
  };
  for (const [file, body] of text) {
    // 第12.5节、第 25.4 节、第5、7、11.6节、第12.7–12.8节、第24–26章
    for (const [, list] of body.matchAll(
      /第\s*(\d+(?:\.\d+)*(?:\s*[、/–-]\s*\d+(?:\.\d+)*)*)\s*[节章]/g,
    )) {
      for (const id of (list as string).split(/\s*[、/–-]\s*/)) verify(file, id);
    }
    for (const [, id] of body.matchAll(/附录\s*([A-D](?:\.\d+)*)/g)) verify(file, id as string);
  }
  must(!missing.length, `References to missing sections:\n${missing.join("\n")}`);
});
check("docs.sources", () => {
  const sources = readFileSync(join(ROOT, "docs/spec/d-sources.md"), "utf8");
  const defined = new Set([...sources.matchAll(/^\| (S\d+) \|/gm)].map((m) => m[1]));
  const missing = new Set<string>();
  for (const [file, body] of text) {
    for (const [, id] of body.matchAll(/\[(S\d+)\]/g)) {
      if (!defined.has(id)) missing.add(`${rel(file)}: ${id}`);
    }
  }
  must(
    !missing.size,
    `Citations without an entry in docs/spec/d-sources.md:\n${[...missing].join("\n")}`,
  );
});
check("docs.fences-and-placeholders", () => {
  for (const [file, body] of text) {
    must(
      !/\{\{[a-z_][a-z0-9_]*\}\}/.test(body),
      `${rel(file)}: unexpanded {{template}} placeholder`,
    );
    const fences = body.match(/^```/gm) ?? [];
    must(fences.length % 2 === 0, `${rel(file)}: unbalanced code fences`);
    for (const [, block] of body.matchAll(/^```json\n([\s\S]*?)^```/gm)) {
      try {
        parseJson(block as string);
      } catch (error) {
        throw new Error(`${rel(file)}: invalid json example (${(error as Error).message})`);
      }
    }
  }
});

// ---------------------------------------------------------------- report
const failed = results.filter((r) => !r.ok);
const report = {
  generated_at: new Date().toISOString(),
  scope:
    "Structural consistency of contracts/src, fixtures and active docs only; no SUT, device or guard was exercised.",
  passed: results.length - failed.length,
  failed: failed.length,
  checks: results,
};
mkdirSync(join(ROOT, "reports"), { recursive: true });
writeFileSync(join(ROOT, "reports/check.json"), `${JSON.stringify(report, null, 2)}\n`);
for (const r of failed) console.error(`FAIL ${r.name}\n  ${r.detail?.replaceAll("\n", "\n  ")}`);
console.log(
  `${results.length - failed.length}/${results.length} checks passed (reports/check.json).`,
);
process.exitCode = failed.length ? 1 : 0;
