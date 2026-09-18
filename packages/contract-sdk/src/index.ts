import { createHash } from "node:crypto";
import {
  commands,
  contracts,
  schemaDigest,
  stateMachines,
  verification,
} from "../../../contracts/generated/registries.ts";
import type { SchemaTypes } from "../../../contracts/generated/types.ts";
import * as validators from "../../../contracts/generated/validators.mjs";

export type * from "../../../contracts/generated/types.ts";
export { parseJson } from "./json.ts";
export { schemaDigest };

export function validate<K extends keyof SchemaTypes>(
  name: K,
  value: unknown,
): value is SchemaTypes[K] {
  // biome-ignore lint/performance/noDynamicNamespaceImportAccess: this API intentionally dispatches every registered schema.
  return validators[name](value);
}

export function assertValid<K extends keyof SchemaTypes>(
  name: K,
  value: unknown,
): asserts value is SchemaTypes[K] {
  if (!validate(name, value)) {
    // biome-ignore lint/performance/noDynamicNamespaceImportAccess: report the selected schema validator's errors.
    throw new Error(`${name}: ${JSON.stringify(validators[name].errors)}`);
  }
}

/** Sorted-key JSON of finite JSON values; not an authorization or a signature. */
export function payloadDigest(value: unknown): string {
  const visit = (v: unknown, depth: number): string => {
    if (depth > 64) throw new Error("JSON_TOO_DEEP");
    if (typeof v === "string") {
      for (const point of v) {
        const code = point.codePointAt(0) ?? 0;
        if (code >= 0xd800 && code <= 0xdfff) throw new Error("LONE_SURROGATE");
      }
      return JSON.stringify(v);
    }
    if (v === null || typeof v === "boolean") return JSON.stringify(v);
    if (typeof v === "number" && Number.isFinite(v)) return JSON.stringify(v);
    if (Array.isArray(v)) return `[${Array.from(v, (x) => visit(x, depth + 1)).join(",")}]`;
    if (v && typeof v === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(v))) {
      return `{${Object.keys(v)
        .sort()
        .map(
          (key) =>
            `${visit(key, depth + 1)}:${visit((v as Record<string, unknown>)[key], depth + 1)}`,
        )
        .join(",")}}`;
    }
    throw new Error("NON_JSON_VALUE");
  };
  return createHash("sha256").update(visit(value, 0)).digest("hex");
}

type Transition = {
  source: readonly string[];
  event: string;
  target: string;
  guard: string;
  action: string;
  phase: string;
};
export type Guard = (context: unknown) => boolean;

/** Computes a decision only. The host must atomically apply actions and persist facts. */
export function transition(
  machineId: string,
  state: string,
  event: string,
  enabledPhases: ReadonlySet<string>,
  guards: Readonly<Record<string, Guard>>,
  context: unknown,
): Readonly<Transition> {
  const machine = stateMachines.machines.find((m) => m.id === machineId);
  if (!machine || !enabledPhases.has(machine.phase)) throw new Error("MACHINE_DISABLED");
  const row: Transition | undefined = machine.transitions.find(
    (t) => (t.source as readonly string[]).includes(state) && t.event === event,
  );
  if (!row || !enabledPhases.has(row.phase)) throw new Error("TRANSITION_REJECTED");
  // `always` is the registry's unconditional structural guard. Every security
  // guard must be supplied by the trusted host, with an actual synchronous result.
  if (row.guard !== "always") {
    const guard = Object.hasOwn(guards, row.guard) ? guards[row.guard] : undefined;
    if (guard?.(context) !== true) throw new Error(`GUARD_REJECTED:${row.guard}`);
  }
  return Object.freeze({ ...row, source: Object.freeze([...row.source]) });
}

type RegisteredCapability = {
  capability: string;
  capability_version: string;
  input_schema_ref: string;
  result_contract: string;
  permission_scope_ref: string;
};

export function validateProfile(value: unknown): SchemaTypes["RuntimeProfile"] {
  assertValid("RuntimeProfile", value);
  const phases = new Set<string>(value.enabled_phases);
  const dependencies: Readonly<Record<string, readonly string[]>> = verification.phase_dependencies;
  for (const phase of value.enabled_phases) {
    for (const dependency of dependencies[phase] ?? []) {
      if (!phases.has(dependency)) throw new Error(`PROFILE_PHASE_DEPENDENCY:${dependency}`);
    }
  }
  // No capability is registered for P0/P1, so every enabled capability is rejected for now.
  const capabilities: readonly RegisteredCapability[] = contracts.capabilities;
  for (const identity of value.enabled_capabilities) {
    const capability = capabilities.find(
      (c) => c.capability === identity.name && c.capability_version === identity.version,
    );
    if (!capability) throw new Error("PROFILE_UNKNOWN_CAPABILITY");
    for (const ref of [
      capability.input_schema_ref,
      capability.result_contract,
      capability.permission_scope_ref,
    ]) {
      const contract = contracts.contracts.find((c) => c.ref === ref);
      if (!contract || !phases.has(contract.phase)) throw new Error("PROFILE_CAPABILITY_PHASE");
    }
  }
  if (value.decision.signal_coalesce_ms > value.decision.max_coalesce_wait_ms) {
    throw new Error("PROFILE_COALESCE_RANGE");
  }
  if (value.stage.startup_prebuffer_target_ms > value.stage.max_pcm_buffer_ms) {
    throw new Error("PROFILE_BUFFER_RANGE");
  }
  if (value.mode === "simulation" && value.enabled_capabilities.length) {
    throw new Error("SIMULATION_EFFECTS_DISABLED");
  }
  return value;
}

export function validateManifest(
  value: unknown,
  knownContracts: ReadonlySet<string> = new Set(contracts.contracts.map((c) => c.ref)),
): SchemaTypes["ControllerManifest"] {
  assertValid("ControllerManifest", value);
  if (value.schema_digest !== schemaDigest) throw new Error("SCHEMA_DIGEST_MISMATCH");
  const refs = [
    value.configuration_schema_ref,
    value.success_evidence_ref,
    value.cleanup_evidence_ref,
    ...value.capabilities.flatMap((c) => [
      c.input_schema_ref,
      c.result_contract,
      c.permission_scope_ref,
    ]),
  ];
  for (const ref of refs) if (!knownContracts.has(ref)) throw new Error(`UNKNOWN_CONTRACT:${ref}`);
  for (const name of value.methods) {
    if (!commands.commands.some((c) => c.name === name)) throw new Error(`UNKNOWN_METHOD:${name}`);
  }
  for (const method of ["plugin.handshake", "plugin.describe"]) {
    if (!value.methods.includes(method)) throw new Error(`MISSING_METHOD:${method}`);
  }
  const extensions = {
    checkpoint: "controller.request_checkpoint",
    quiesce: "controller.quiesce",
    snapshot: "controller.snapshot",
    restore: "controller.restore",
    policy_patch: "controller.propose_policy_patch",
  } as const;
  for (const [flag, method] of Object.entries(extensions)) {
    if (value.update_support[flag as keyof typeof extensions] !== value.methods.includes(method)) {
      throw new Error(`MANIFEST_SUPPORT_MISMATCH:${flag}`);
    }
  }
  if (
    value.execution_mode === "simulation" &&
    value.capabilities.some((c) => c.status === "enabled")
  ) {
    throw new Error("SIMULATION_CAPABILITY_ENABLED");
  }
  return value;
}

export function validateRpcResponse(method: string, response: unknown): void {
  const command = commands.commands.find((c) => c.name === method);
  if (!command) throw new Error("UNKNOWN_METHOD");
  if (validate("RpcFailure", response)) return;
  assertValid("RpcSuccess", response);
  assertValid(command.result_schema, response.result);
}
