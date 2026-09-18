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
export function canonicalJson(value: unknown): string {
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
  return visit(value, 0);
}

export function payloadDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
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

/** A local SDK binding only; the trusted runtime must first verify actual installation files. */
export type P0InstallationContext = Readonly<{
  installation: SchemaTypes["P0TrustedInstallation"];
}>;
const installationContexts = new WeakSet<P0InstallationContext>();

export function bindVerifiedP0Installation(
  installation: SchemaTypes["P0TrustedInstallation"],
): P0InstallationContext {
  assertValid("P0TrustedInstallation", installation);
  if (installation.schema_digest !== schemaDigest) throw new Error("SCHEMA_DIGEST_MISMATCH");
  if (
    installation.allowed_capabilities.length !== 1 ||
    installation.allowed_capabilities[0]?.name !== "simulation.execute" ||
    installation.allowed_capabilities[0]?.version !== "0.8.0"
  )
    throw new Error("P0_CAPABILITY_DENIED");
  const copy = structuredClone(installation);
  // Nested mutations must not turn a checked local binding into a different installation.
  const freeze = (v: unknown): void => {
    if (v && typeof v === "object") {
      for (const child of Object.values(v)) freeze(child);
      Object.freeze(v);
    }
  };
  freeze(copy);
  const context = Object.freeze({ installation: copy });
  installationContexts.add(context);
  return context;
}

function requireP0Installation(context: P0InstallationContext | undefined): P0InstallationContext {
  if (!context || !installationContexts.has(context))
    throw new Error("SIMULATION_INSTALLATION_REQUIRED");
  return context;
}

export function validateProfile(
  value: unknown,
  installation?: P0InstallationContext,
): SchemaTypes["RuntimeProfile"] {
  assertValid("RuntimeProfile", value);
  const phases = new Set<string>(value.enabled_phases);
  const dependencies: Readonly<Record<string, readonly string[]>> = verification.phase_dependencies;
  for (const phase of value.enabled_phases) {
    for (const dependency of dependencies[phase] ?? []) {
      if (!phases.has(dependency)) throw new Error(`PROFILE_PHASE_DEPENDENCY:${dependency}`);
    }
  }
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
  if (
    (installation || value.enabled_capabilities.some((c) => c.name === "simulation.execute")) &&
    value.mode !== "simulation"
  ) {
    throw new Error("SIMULATION_EFFECTS_DISABLED");
  }
  if (value.mode === "simulation" && value.enabled_capabilities.length) {
    const trusted = requireP0Installation(installation).installation;
    if (
      value.enabled_phases.length !== 1 ||
      value.enabled_phases[0] !== "P0" ||
      payloadDigest(value.enabled_capabilities) !== payloadDigest(trusted.allowed_capabilities)
    )
      throw new Error("SIMULATION_EFFECTS_DISABLED");
  }
  return value;
}

export function validateManifest(
  value: unknown,
  knownContracts: ReadonlySet<string> = new Set(contracts.contracts.map((c) => c.ref)),
  installation?: P0InstallationContext,
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
    (installation ||
      value.capabilities.some((c) => c.name === "simulation.execute" && c.status === "enabled")) &&
    value.execution_mode !== "simulation"
  ) {
    throw new Error("SIMULATION_CAPABILITY_ENABLED");
  }
  if (
    value.execution_mode === "simulation" &&
    value.capabilities.some((c) => c.status === "enabled")
  ) {
    const trusted = requireP0Installation(installation).installation;
    const expected = contracts.capabilities.find((c) => c.capability === "simulation.execute");
    if (
      !expected ||
      value.plugin_id !== trusted.plugin_id ||
      value.plugin_version !== trusted.plugin_version ||
      payloadDigest(value) !== trusted.manifest_digest ||
      value.capabilities.length !== 1 ||
      value.configuration_schema_ref !== "p0-endpoint-configuration@1" ||
      value.success_evidence_ref !== "p0-simulation-result@1" ||
      value.cleanup_evidence_ref !== "p0-simulation-cleanup@1" ||
      value.control_capabilities.length !== 0 ||
      value.resources.length !== 0 ||
      Object.values(value.permissions).some((items) => items.length !== 0) ||
      value.configuration_apply_boundary !== "new_instance"
    )
      throw new Error("SIMULATION_CAPABILITY_ENABLED");
    for (const capability of value.capabilities) {
      if (
        capability.name !== expected.capability ||
        capability.version !== expected.capability_version ||
        capability.input_schema_ref !== expected.input_schema_ref ||
        capability.result_contract !== expected.result_contract ||
        capability.permission_scope_ref !== expected.permission_scope_ref ||
        capability.status !== "enabled" ||
        capability.effect_type !== "internal_state" ||
        capability.first_required_phase !== "P0"
      ) {
        throw new Error("SIMULATION_CAPABILITY_ENABLED");
      }
    }
    for (const method of value.methods) {
      const command = commands.commands.find((c) => c.name === method);
      if (
        command?.phase !== "P0" ||
        !["plugin", "local_peer"].includes(command.target) ||
        !["none", "internal_state"].includes(command.effect_type)
      )
        throw new Error("SIMULATION_METHOD_DENIED");
    }
    for (const method of [
      "simulation.execute",
      "simulation.query",
      "endpoint.lease",
      "endpoint.revoke",
    ]) {
      if (!value.methods.includes(method)) throw new Error(`MISSING_METHOD:${method}`);
    }
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
