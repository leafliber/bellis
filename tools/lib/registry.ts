// Typed loading of the active contract registries in contracts/src.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJson } from "../../packages/contract-sdk/src/json.ts";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const SRC = join(ROOT, "contracts/src");

export type Schema = { [key: string]: unknown };
export type SchemaDocument = Schema & { $defs: Record<string, Schema> };

export interface Transition {
  source: string[];
  event: string;
  target: string;
  guard: string;
  action: string;
  phase: string;
}
export interface Machine {
  id: string;
  phase: string;
  initial: string;
  terminal: string[];
  states: string[];
  transitions: Transition[];
  notes: string;
}
export interface GuardEntry {
  id: string;
  meaning: string;
}
export interface EventEntry {
  event_name: string;
  authority: string;
  phase: string;
  payload_schema: string;
  reliability: string;
  dedupe: string;
  terminal: boolean;
  meaning: string;
}
export interface ErrorEntry {
  category: string;
  reason_code: string;
  meaning: string;
  retry_disposition: string;
  phase: string;
}
export interface CommandEntry {
  name: string;
  input_schema: string;
  result_schema: string;
  target: string;
  phase: string;
  effect_type: string;
  permission_scope: string;
  idempotency: string;
  unsupported_reason: string | null;
}
export interface Invariant {
  id: string;
  requirement: string;
  scenario: string;
  first_required_phase: string;
  verification_status: string;
  test_ids: string[];
}
export interface TestEntry {
  id: string;
  invariant_id: string | null;
  phase: string;
  implementation_status: "IMPLEMENTED" | "NOT_IMPLEMENTED";
  runner: string | null;
  adapter: string;
  /** Only for tests without an invariant; invariant tests take their text from invariants.json. */
  procedure?: string;
  expected?: string;
  evidence_required: string[];
}
export interface PhaseCheck {
  phase: string;
  id: string;
  implementation_status: "IMPLEMENTED" | "NOT_IMPLEMENTED";
  runner: string | null;
  required_evidence: string[];
  label: string;
  deliverables: string;
  not_required: string;
  criterion: string;
}
export interface Verification {
  schema_version: string;
  phase_dependencies: Record<string, string[]>;
  tests: TestEntry[];
  phase_checks: PhaseCheck[];
}
export interface ContractEntry {
  ref: string;
  kind: string;
  schema: string;
  owner: string;
  phase: string;
  semantic_rules: string;
  admission_guards?: string[];
}
export interface EpochField {
  field: string;
  writer: string;
  scope: string;
  increment: string;
  comparison: string;
}
export interface Vocabulary {
  id: string;
  meaning: string;
}

export interface Registry {
  schema: SchemaDocument;
  machines: Machine[];
  guards: GuardEntry[];
  events: EventEntry[];
  errors: ErrorEntry[];
  commands: CommandEntry[];
  invariants: Invariant[];
  verification: Verification;
  records: {
    records: { machine: string; schema: string; state_field: string }[];
    support_types: string[];
    artifact_types: string[];
  };
  contracts: { canonicalization: string; contracts: ContractEntry[]; capabilities: unknown[] };
  epochs: { rules: string; fields: EpochField[] };
  termination: { reasons: string[]; rule: string };
  resources: { resource_kinds?: Vocabulary[]; task_classes?: Vocabulary[] };
  /** Raw parsed files keyed by file name, for version and shape checks. */
  files: Record<string, Record<string, unknown>>;
}

/** Strict parse: duplicate keys, non-finite numbers and lone surrogates are rejected. */
export function readJson<T = unknown>(path: string): T {
  return parseJson(readFileSync(path, "utf8")) as T;
}

export function loadRegistry(): Registry {
  const files: Record<string, Record<string, unknown>> = {};
  for (const name of readdirSync(SRC).filter((f) => f.endsWith(".json"))) {
    files[name] = readJson(join(SRC, name));
  }
  const file = <T>(name: string): T => {
    const value = files[name];
    if (!value) throw new Error(`Missing contracts/src/${name}`);
    return value as T;
  };
  return {
    schema: file("schema.json"),
    machines: file<{ machines: Machine[] }>("state-machines.json").machines,
    guards: file<{ guards: GuardEntry[] }>("guards.json").guards,
    events: file<{ events: EventEntry[] }>("events.json").events,
    errors: file<{ errors: ErrorEntry[] }>("errors.json").errors,
    commands: file<{ commands: CommandEntry[] }>("commands.json").commands,
    invariants: file<{ invariants: Invariant[] }>("invariants.json").invariants,
    verification: file("verification.json"),
    records: file("object-records.json"),
    contracts: file("contract-registry.json"),
    epochs: file("epochs.json"),
    termination: file("termination-reasons.json"),
    resources: (files["resources.json"] ?? {}) as Registry["resources"],
    files,
  };
}

/** Phases in dependency order, from verification.json. */
export function phases(registry: Registry): string[] {
  return Object.keys(registry.verification.phase_dependencies);
}

/** The selected phases plus everything they depend on. */
export function phaseClosure(
  verification: Pick<Verification, "phase_dependencies">,
  selected: readonly string[],
): Set<string> {
  const deps = verification.phase_dependencies;
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (phase: string) => {
    const next = deps[phase];
    if (!next) throw new Error(`Unknown phase: ${phase}`);
    if (visiting.has(phase)) throw new Error(`Phase dependency cycle at ${phase}`);
    if (done.has(phase)) return;
    visiting.add(phase);
    for (const dependency of next) visit(dependency);
    visiting.delete(phase);
    done.add(phase);
  };
  for (const phase of selected) visit(phase);
  return done;
}
