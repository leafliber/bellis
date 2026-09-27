import { randomUUID } from "node:crypto";
import { contracts } from "../../../contracts/generated/registries.ts";
import {
  assertValid,
  type ObjectRef,
  type P0OperatorCredential,
  type P0RuntimeConfig,
  payloadDigest,
} from "../../contract-sdk/src/index.ts";
import type { PreparedOperator, RpcConnection } from "./client.ts";
import { mappedDeadline } from "./clock.ts";

const flags = {
  authenticate: [],
  query: [],
  "host-query": [],
  authorize: [
    "endpoint-instance",
    "target",
    "capability",
    "effect-limit",
    "queue-limit",
    "cost-limit",
    "human-lease-ms",
    "grant-ms",
  ],
  renew: ["supervision-epoch", "human-lease-ms"],
  revoke: ["grant-id"],
  stop: ["target"],
  execute: ["grant-id", "endpoint-instance", "target", "units", "interval-ms", "cost-units"],
  fault: ["fault-target", "fault", "duration-ms"],
} as const;
export type OperatorAction = keyof typeof flags;
export type OperatorCommand = {
  action: OperatorAction;
  configPath: string;
  operation: string;
  values: Readonly<Record<string, string>>;
  targets: readonly ObjectRef[];
  capabilities: readonly string[];
};
function invalid(): never {
  throw new Error("INVALID_ARGUMENTS");
}
export function parseOperatorCommand(args: readonly string[]): OperatorCommand {
  const values: Record<string, string> = Object.create(null);
  const targets: ObjectRef[] = [];
  const capabilities: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token?.startsWith("--") || token.length < 3) invalid();
    const key = token.slice(2);
    const value = args[++i];
    if (!value || value.startsWith("--")) invalid();
    if (key === "target") {
      const id = args[++i];
      if (!id || id.startsWith("--")) invalid();
      const target = { kind: value, id };
      assertValid("ObjectRef", target);
      if (targets.some((t) => payloadDigest(t) === payloadDigest(target))) invalid();
      targets.push(target);
    } else if (key === "capability") {
      if (value !== "simulation.execute" || capabilities.includes(value)) invalid();
      capabilities.push(value);
    } else {
      if (Object.hasOwn(values, key)) invalid();
      values[key] = value;
    }
  }
  const action = values.command;
  if (!action || !Object.hasOwn(flags, action) || !values.config) invalid();
  const specific = flags[action as OperatorAction] as readonly string[];
  for (const key of Object.keys(values))
    if (!["config", "command", "operation-id", "timeout-ms", ...specific].includes(key)) invalid();
  if (
    (targets.length > 0 && !specific.includes("target")) ||
    (capabilities.length > 0 && !specific.includes("capability"))
  )
    invalid();
  for (const key of specific)
    if (
      key === "target"
        ? targets.length === 0
        : key === "capability"
          ? capabilities.length === 0
          : values[key] === undefined
    )
      invalid();
  if (targets.length > 16 || (action !== "authorize" && targets.length > 1)) invalid();
  const operation = values["operation-id"] ?? randomUUID();
  assertValid("Id", operation);
  for (const key of ["endpoint-instance", "grant-id"])
    if (values[key] !== undefined) assertValid("Id", values[key]);
  // Parse every numeric flag now; range checks use the verified configuration below.
  for (const key of [
    "timeout-ms",
    "effect-limit",
    "queue-limit",
    "cost-limit",
    "human-lease-ms",
    "grant-ms",
    "supervision-epoch",
    "units",
    "interval-ms",
    "cost-units",
    "duration-ms",
  ])
    if (values[key] !== undefined)
      integer(
        values[key],
        ["cost-limit", "supervision-epoch", "cost-units", "duration-ms"].includes(key) ? 0 : 1,
      );
  return {
    action: action as OperatorAction,
    configPath: values.config,
    operation,
    values: Object.freeze(values),
    targets: targets.map((t) => Object.freeze(t)),
    capabilities: Object.freeze(capabilities),
  };
}
function integer(
  value: string | undefined,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) invalid();
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) invalid();
  return result;
}
export function operatorTarget(command: OperatorCommand): "host" | "supervisor" {
  return command.action === "host-query" || command.action === "execute" ? "host" : "supervisor";
}
/** Only fixed P0 actions; no method, proof, identity or arbitrary JSON input surface. */
export function prepareOperatorCommand(
  command: OperatorCommand,
  config: P0RuntimeConfig,
  connection: RpcConnection,
  credential: P0OperatorCredential,
): PreparedOperator {
  assertValid("P0RuntimeConfig", config);
  const v = command.values;
  const required = (key: string): string => v[key] ?? invalid();
  const timeoutMs =
    v["timeout-ms"] === undefined
      ? config.limits.peer_health_timeout_ms
      : integer(v["timeout-ms"], 1, config.limits.peer_health_timeout_ms);
  const options = { operation: command.operation, timeoutMs, grant: null as string | null };
  const session_id = connection.announcement.session_id;
  if (connection.announcement.service_role !== operatorTarget(command)) invalid();
  const targets = command.targets.map((target) => {
    const allowed = config.installation.allowed_targets.find(
      (item) => payloadDigest(item) === payloadDigest(target),
    );
    if (!allowed) invalid();
    return structuredClone(allowed);
  });
  switch (command.action) {
    case "authenticate":
      return connection.prepareOperator("operator.authenticate", {}, credential, options);
    case "query":
      return connection.prepareOperator("session.query", { session_id }, credential, options);
    case "host-query":
      return connection.prepareOperator("host.query", { session_id }, credential, options);
    case "authorize": {
      const allowed_capabilities = command.capabilities.map((name) => {
        const matches = config.installation.allowed_capabilities.filter((c) => c.name === name);
        const capability = matches[0];
        const registered = contracts.capabilities.find((c) => c.capability === name);
        if (
          matches.length !== 1 ||
          !capability ||
          !registered ||
          capability.version !== registered.capability_version ||
          !config.profile.enabled_capabilities.some(
            (c) => payloadDigest(c) === payloadDigest(capability),
          )
        )
          invalid();
        return structuredClone(capability);
      });
      const humanMs = integer(v["human-lease-ms"], 1, config.limits.max_human_lease_ms);
      const grantMs = integer(v["grant-ms"], 1, Math.min(config.limits.max_session_ms, humanMs));
      const now = connection.clock.now();
      return connection.prepareOperator(
        "session.authorize",
        {
          session_id,
          endpoint_instance_id: required("endpoint-instance"),
          mode: "simulation",
          supervision_mode: "supervised",
          target_refs: targets,
          allowed_capabilities,
          effect_limit: integer(v["effect-limit"], 1, config.limits.max_effects),
          queue_limit: integer(v["queue-limit"], 1, config.limits.max_queue_items),
          cost_limit_units: integer(v["cost-limit"], 0, 100000),
          human_lease_deadline: mappedDeadline(connection.mapping, now, humanMs),
          grant_deadline: mappedDeadline(connection.mapping, now, grantMs),
          public_broadcast_allowed: false,
        },
        credential,
        options,
      );
    }
    case "renew":
      return connection.prepareOperator(
        "session.renew",
        {
          session_id,
          supervision_epoch: integer(v["supervision-epoch"], 0),
          human_lease_deadline: mappedDeadline(
            connection.mapping,
            connection.clock.now(),
            integer(v["human-lease-ms"], 1, config.limits.max_human_lease_ms),
          ),
        },
        credential,
        options,
      );
    case "revoke":
      return connection.prepareOperator(
        "session.revoke",
        { session_id, grant_id: required("grant-id"), reason: "operator_request" },
        credential,
        { ...options, grant: required("grant-id") },
      );
    case "stop":
      return connection.prepareOperator(
        "session.stop",
        { session_id, target_ref: targets[0] ?? invalid(), reason: "operator_request" },
        credential,
        options,
      );
    case "execute":
      return connection.prepareOperator(
        "session.execute",
        {
          session_id,
          grant_id: required("grant-id"),
          endpoint_instance_id: required("endpoint-instance"),
          action: {
            target_ref: targets[0] ?? invalid(),
            capability: "simulation.execute",
            units: integer(v.units, 1, config.limits.max_effects),
            interval_ms: integer(v["interval-ms"], 1, 60000),
            cost_units: integer(v["cost-units"], 0, 100000),
          },
        },
        credential,
        { ...options, grant: required("grant-id") },
      );
    case "fault": {
      const selection = {
        target: v["fault-target"],
        fault: v.fault,
        duration_ms: integer(v["duration-ms"], 0, 60000),
      };
      assertValid("P0FaultSelection", selection);
      return connection.prepareOperator(
        "fault.configure",
        { session_id, selection },
        credential,
        options,
      );
    }
  }
}
