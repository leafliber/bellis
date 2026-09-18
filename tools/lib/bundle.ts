// Composes contracts/generated/bundle.schema.json: hand-written shapes from
// contracts/src/schema.json plus definitions derived from the registries, so that
// event names, reason codes, states and RPC methods are declared in one place only.
import type { Registry, Schema, SchemaDocument } from "./registry.ts";

const unique = (values: readonly string[]) => [...new Set(values)].sort();

const proofFields = {
  P0OperatorProof: [
    "credential_id",
    "announcement_digest",
    "challenge_id",
    "connection_id",
    "service_instance_id",
    "client_instance_id",
    "client_nonce",
    "request_digest",
    "proof_hmac",
  ],
  P0PeerProof: [
    "announcement_digest",
    "challenge_id",
    "connection_id",
    "service_instance_id",
    "client_instance_id",
    "client_role",
    "client_nonce",
    "request_digest",
    "signature",
  ],
} as const;

/** Only these two reviewed proof layouts may lose their authenticator in observations. */
function observedProof(registry: Registry, name: keyof typeof proofFields): Schema {
  const original = registry.schema.$defs[name];
  const properties = original?.properties as Record<string, Schema> | undefined;
  const expected = [...proofFields[name]].sort();
  if (
    original?.type !== "object" ||
    original.additionalProperties !== false ||
    !properties ||
    JSON.stringify(Object.keys(properties).sort()) !== JSON.stringify(expected) ||
    !Array.isArray(original.required) ||
    JSON.stringify([...original.required].sort()) !== JSON.stringify(expected) ||
    Object.keys(original).some(
      (key) =>
        !["type", "properties", "required", "additionalProperties", "$comment"].includes(key),
    )
  )
    throw new Error(`UNSUPPORTED_OBSERVATION_PROOF_SHAPE:${name}`);
  const authenticator = name === "P0OperatorProof" ? "proof_hmac" : "signature";
  for (const [key, shape] of Object.entries(properties)) {
    if (key === authenticator) continue;
    const expectedShape =
      key === "client_role"
        ? { enum: ["host", "supervisor", "endpoint"] }
        : {
            $ref: `#/$defs/${["announcement_digest", "request_digest"].includes(key) ? "Digest" : "Id"}`,
          };
    if (JSON.stringify(shape) !== JSON.stringify(expectedShape))
      throw new Error(`UNSUPPORTED_OBSERVATION_PROOF_FIELD:${name}.${key}`);
  }
  const field = properties[authenticator];
  if (
    !field ||
    (authenticator === "proof_hmac"
      ? Object.keys(field).length !== 1 || field.$ref !== "#/$defs/Digest"
      : field.type !== "string" ||
        typeof field.minLength !== "number" ||
        field.minLength < 1 ||
        typeof field.maxLength !== "number" ||
        field.maxLength < field.minLength ||
        Object.keys(field).some((key) => !["type", "minLength", "maxLength"].includes(key)))
  )
    throw new Error(`UNSUPPORTED_OBSERVATION_AUTHENTICATOR:${name}`);
  const copy = structuredClone(original);
  const redacted = copy.properties as Record<string, Schema>;
  delete redacted[authenticator];
  redacted.redaction = { const: `${authenticator}_removed` };
  redacted.authenticator_sha256 = { $ref: "#/$defs/Digest" };
  copy.required = Object.keys(redacted);
  copy.$comment = `derived from ${name}; authenticator_sha256 hashes the original authenticator string UTF-8 bytes, never the authentication key; not a production proof`;
  return copy;
}

function observedInput(registry: Registry, name: string): Schema {
  const original = registry.schema.$defs[name];
  if (!original) throw new Error(`OBSERVATION_INPUT_MISSING:${name}`);
  const properties = original.properties as Record<string, Schema> | undefined;
  const proof = properties?.proof;
  const proofRefs = ["#/$defs/P0OperatorProof", "#/$defs/P0PeerProof"];
  if (
    proof &&
    (Object.keys(proof).some((key) => key !== "$ref" && key !== "$comment") ||
      !proofRefs.includes(String(proof.$ref)))
  )
    throw new Error(`UNSUPPORTED_OBSERVATION_INPUT_PROOF:${name}.properties.proof`);
  const visiting = new Set<string>([name]);
  const inspect = (value: unknown, path: string): void => {
    if (path === `${name}.properties.proof` && proof) return;
    if (Array.isArray(value)) {
      value.forEach((child, index) => {
        inspect(child, `${path}[${index}]`);
      });
      return;
    }
    if (!value || typeof value !== "object") return;
    const node = value as Schema;
    if (
      proofRefs.includes(String(node.$ref)) ||
      (path !== name && node.properties && Object.hasOwn(node.properties as object, "proof"))
    )
      throw new Error(`UNSUPPORTED_OBSERVATION_PROOF_POSITION:${path}`);
    if (typeof node.$ref === "string" && node.$ref.startsWith("#/$defs/")) {
      const target = node.$ref.slice("#/$defs/".length);
      const definition = registry.schema.$defs[target];
      if (definition && !visiting.has(target)) {
        visiting.add(target);
        inspect(definition, `${path}->${target}`);
        visiting.delete(target);
      }
    }
    for (const [key, child] of Object.entries(node)) inspect(child, `${path}.${key}`);
  };
  inspect(original, name);
  // Keep ordinary inputs referenced unchanged; clone proof inputs with all their constraints.
  if (!proof) return { $ref: `#/$defs/${name}` };
  const copy = structuredClone(original);
  (copy.properties as Record<string, Schema>).proof = {
    ...proof,
    $ref:
      proof.$ref === "#/$defs/P0OperatorProof"
        ? "#/$defs/P0ObservedOperatorProof"
        : "#/$defs/P0ObservedPeerProof",
  };
  return copy;
}

/** Definitions the generator owns. contracts/src/schema.json must reference, never define, them. */
export function derivedDefinitions(registry: Registry): Record<string, Schema> {
  const derived: Record<string, Schema> = {
    Phase: {
      $comment: "derived from verification.json phase_dependencies",
      enum: Object.keys(registry.verification.phase_dependencies),
    },
    EventName: {
      $comment: "derived from events.json",
      enum: registry.events.map((e) => e.event_name),
    },
    EventPayloadBinding: {
      $comment: "derived from events.json: payload schema per event_name",
      allOf: registry.events.map((e) => ({
        if: { properties: { event_name: { const: e.event_name } }, required: ["event_name"] },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword.
        then: { properties: { payload: { $ref: `#/$defs/${e.payload_schema}` } } },
      })),
    },
    ErrorCategory: {
      $comment: "derived from errors.json",
      enum: unique(registry.errors.map((e) => e.category)),
    },
    ReasonCode: {
      $comment: "derived from errors.json",
      enum: registry.errors.map((e) => e.reason_code),
    },
    RetryDisposition: {
      $comment: "derived from errors.json",
      enum: unique(registry.errors.map((e) => e.retry_disposition)),
    },
    ErrorReasonBinding: {
      $comment: "derived from errors.json: category and retry_disposition per reason_code",
      allOf: registry.errors.map((e) => ({
        if: { properties: { reason_code: { const: e.reason_code } }, required: ["reason_code"] },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword.
        then: {
          properties: {
            category: { const: e.category },
            retry_disposition: { const: e.retry_disposition },
          },
        },
      })),
    },
    TerminationReason: {
      $comment: "derived from termination-reasons.json",
      enum: registry.termination.reasons,
    },
    RpcRequest: {
      $comment: "derived from commands.json: one JSON-RPC request shape per command",
      oneOf: registry.commands.map((c) => ({
        type: "object",
        properties: {
          jsonrpc: { const: "2.0" },
          id: { $ref: "#/$defs/RpcId" },
          method: { const: c.name },
          params: {
            type: "object",
            properties: {
              context: { $ref: "#/$defs/CommandContext" },
              input: { $ref: `#/$defs/${c.input_schema}` },
            },
            required: ["context", "input"],
            additionalProperties: false,
          },
        },
        required: ["jsonrpc", "id", "method", "params"],
        additionalProperties: false,
      })),
    },
    P0ObservedOperatorProof: observedProof(registry, "P0OperatorProof"),
    P0ObservedPeerProof: observedProof(registry, "P0PeerProof"),
    P0ObservedRpcRequest: {
      $comment: "derived from commands.json and original input shapes; exact proof redaction only",
      oneOf: registry.commands.map((c) => ({
        type: "object",
        properties: {
          jsonrpc: { const: "2.0" },
          id: { $ref: "#/$defs/RpcId" },
          method: { const: c.name },
          params: {
            type: "object",
            properties: {
              context: { $ref: "#/$defs/CommandContext" },
              input: observedInput(registry, c.input_schema),
            },
            required: ["context", "input"],
            additionalProperties: false,
          },
        },
        required: ["jsonrpc", "id", "method", "params"],
        additionalProperties: false,
      })),
    },
    P0ObservedRpcResponse: {
      $comment: "derived from commands.json result schemas; a missing method permits failure only",
      oneOf: [
        ...registry.commands.map((c) => ({
          type: "object",
          properties: {
            method: { const: c.name },
            response: {
              oneOf: [
                {
                  type: "object",
                  properties: {
                    jsonrpc: { const: "2.0" },
                    id: { $ref: "#/$defs/RpcId" },
                    result: { $ref: `#/$defs/${c.result_schema}` },
                  },
                  required: ["jsonrpc", "id", "result"],
                  additionalProperties: false,
                },
                { $ref: "#/$defs/RpcFailure" },
              ],
            },
          },
          required: ["method", "response"],
          additionalProperties: false,
        })),
        {
          type: "object",
          properties: { method: { type: "null" }, response: { $ref: "#/$defs/RpcFailure" } },
          required: ["method", "response"],
          additionalProperties: false,
        },
      ],
    },
  };
  for (const machine of registry.machines) {
    derived[`${machine.id}State`] = {
      $comment: `derived from state-machines.json: ${machine.id}`,
      enum: machine.states,
    };
  }
  const { resource_kinds, task_classes } = registry.resources;
  if (resource_kinds) {
    derived.ResourceKind = {
      $comment: "derived from resources.json",
      enum: resource_kinds.map((x) => x.id),
    };
  }
  if (task_classes) {
    derived.TaskClass = {
      $comment: "derived from resources.json",
      enum: task_classes.map((x) => x.id),
    };
  }
  return derived;
}

export function composeBundle(registry: Registry): SchemaDocument {
  const { $comment: _sourceNote, $defs, ...header } = registry.schema;
  const derived = derivedDefinitions(registry);
  const clash = Object.keys(derived).filter((name) => name in $defs);
  if (clash.length) {
    throw new Error(
      `contracts/src/schema.json defines generator-owned definitions: ${clash.join(", ")}`,
    );
  }
  return {
    ...header,
    $comment:
      "GENERATED by tools/generate.ts from contracts/src/schema.json and the registries; do not edit.",
    $defs: { ...$defs, ...derived },
  };
}

/** Every "$ref" target name in a schema fragment. */
export function refsOf(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) refsOf(item, out);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") out.push(value);
      else refsOf(value, out);
    }
  }
  return out;
}
