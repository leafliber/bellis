import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { composeBundle } from "../tools/lib/bundle.ts";
import { createAjv, refFor } from "../tools/lib/codegen.ts";
import { loadRegistry, type Registry, type Schema } from "../tools/lib/registry.ts";

const digest = "a".repeat(64);
const registry = loadRegistry();
const bundle = composeBundle(registry);
const ajv = createAjv(bundle);
const valid = (name: string, value: unknown) => {
  const check = ajv.getSchema(refFor(bundle, name));
  assert.ok(check, name);
  return check(value);
};
const mapping = {
  mapping_id: "mapping",
  connection_id: "connection",
  source_instance_id: "caller",
  target_instance_id: "service",
  source_clock_domain: "caller-clock",
  target_clock_domain: "service-clock",
  source_sent_at_ms: 1,
  target_received_at_ms: 2,
  target_sent_at_ms: 3,
  source_received_at_ms: 4,
  offset_lower_ms: -2,
  offset_upper_ms: 2,
  max_error_ms: 4,
  source_valid_until_ms: 100,
  target_valid_until_ms: 100,
  announcement_digest: digest,
};
const request = (method: string, input: object) => ({
  jsonrpc: "2.0",
  id: "rpc",
  method,
  params: {
    context: {
      operation_id: "operation",
      payload_digest: digest,
      caller_instance_id: "caller",
      authority_epoch: 0,
      object_ref: { kind: "Session", id: "session" },
      deadline: { clock_domain: "service-clock", issued_at_ms: 0, expires_at_ms: 100 },
      grant_ref: null,
    },
    input,
  },
});
const proofBase = {
  announcement_digest: digest,
  challenge_id: "challenge",
  connection_id: "connection",
  service_instance_id: "service",
  client_instance_id: "caller",
  client_nonce: "nonce",
  request_digest: digest,
};

test("p0.observation.generation: only exact operator/peer authenticators are redacted; production proofs remain distinct", () => {
  for (const kind of ["operator", "peer"] as const) {
    const authenticator = kind === "operator" ? "proof_hmac" : "signature";
    const original = kind === "operator" ? digest : "synthetic-signature";
    const identity =
      kind === "operator" ? { credential_id: "credential" } : { client_role: "host" };
    const proof = { ...proofBase, ...identity, [authenticator]: original };
    const redacted = {
      ...proofBase,
      ...identity,
      redaction: `${authenticator}_removed`,
      authenticator_sha256: createHash("sha256").update(original, "utf8").digest("hex"),
    };
    const method = kind === "operator" ? "operator.authenticate" : "connection.authenticate";
    const raw = request(method, { proof, mapping });
    const observed = request(method, { proof: redacted, mapping });
    assert.equal(valid("RpcRequest", raw), true);
    assert.equal(valid("P0ObservedRpcRequest", raw), false);
    assert.equal(valid("P0ObservedRpcRequest", observed), true);
    assert.equal(valid("RpcRequest", observed), false);
    assert.equal(
      valid(
        "P0ObservedRpcRequest",
        request(method, { proof: { ...redacted, [authenticator]: original }, mapping }),
      ),
      false,
    );
    assert.equal(
      valid(
        "P0ObservedRpcRequest",
        request(method, { proof: { ...redacted, authenticator_sha256: "not-a-digest" }, mapping }),
      ),
      false,
    );
    assert.equal(
      valid(
        "P0ObservedRpcRequest",
        request(method, { proof: { ...redacted, redaction: "other" }, mapping }),
      ),
      false,
    );
    assert.equal(
      valid(
        "P0ObservedRpcRequest",
        request(method, { proof: redacted, mapping: { ...mapping, target_instance_id: 7 } }),
      ),
      false,
    );
    assert.equal(valid("P0ObservedRpcRequest", { ...observed, arbitrary: true }), false);
    assert.equal(
      valid("P0ObservedRpcRequest", {
        ...observed,
        params: { ...observed.params, input: { ...observed.params.input, surprise: true } },
      }),
      false,
    );
  }
});

test("p0.observation.generation: ordinary request constraints and conditional input rules survive derivation", () => {
  const plain = request("plugin.handshake", {
    host_instance_id: "host",
    protocol_versions: ["0.8.0"],
    schema_digest: digest,
    enabled_phases: ["P0"],
  });
  assert.equal(valid("RpcRequest", plain), true);
  assert.equal(valid("P0ObservedRpcRequest", plain), true);
  assert.equal(valid("P0ObservedRpcRequest", { ...plain, method: "unregistered.method" }), false);
  assert.equal(
    valid("P0ObservedRpcRequest", {
      ...plain,
      params: { ...plain.params, context: { ...plain.params.context, authority_epoch: -1 } },
    }),
    false,
  );
  const changed = structuredClone(registry);
  const input = changed.schema.$defs.P0AuthenticateInput;
  assert.ok(input);
  input.allOf = [
    {
      if: { properties: { mapping: { properties: { source_instance_id: { const: "caller" } } } } },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword.
      then: {
        properties: {
          mapping: { properties: { target_instance_id: { const: "required-service" } } },
        },
      },
    },
  ];
  const constrained = composeBundle(changed);
  const check = createAjv(constrained).getSchema(refFor(constrained, "P0ObservedRpcRequest"));
  assert.ok(check);
  const proof = {
    ...proofBase,
    credential_id: "credential",
    redaction: "proof_hmac_removed",
    authenticator_sha256: digest,
  };
  assert.equal(check(request("operator.authenticate", { proof, mapping })), false);
  assert.equal(
    check(
      request("operator.authenticate", {
        proof,
        mapping: { ...mapping, target_instance_id: "required-service" },
      }),
    ),
    true,
  );
});

test("p0.observation.generation: unknown proof shapes and nested or referenced proof positions fail generation", () => {
  const mutations: Array<(r: Registry) => void> = [
    (r) => {
      (r.schema.$defs.P0OperatorProof?.properties as Record<string, Schema>).secret_token = {
        type: "string",
      };
    },
    (r) => {
      (r.schema.$defs.P0PeerProof?.properties as Record<string, Schema>).signature = {
        $ref: "#/$defs/JsonValue",
      };
    },
    (r) => {
      (r.schema.$defs.P0OperatorProof?.properties as Record<string, Schema>).client_nonce = {
        $ref: "#/$defs/JsonValue",
      };
    },
    (r) => {
      (r.schema.$defs.P0AuthenticateInput?.properties as Record<string, Schema>).proof = {
        $ref: "#/$defs/UnknownProof",
      };
    },
    (r) => {
      (r.schema.$defs.P0AuthenticateInput?.properties as Record<string, Schema>).proof = {
        anyOf: [{ $ref: "#/$defs/P0OperatorProof" }, { type: "null" }],
      };
    },
    (r) => {
      r.schema.$defs.NestedProof = {
        type: "object",
        properties: { proof: { $ref: "#/$defs/P0PeerProof" } },
        required: ["proof"],
        additionalProperties: false,
      };
      (r.schema.$defs.P0AuthenticateInput?.properties as Record<string, Schema>).nested = {
        $ref: "#/$defs/NestedProof",
      };
    },
    (r) => {
      (r.schema.$defs.EmptyInput?.properties as Record<string, Schema>).hidden = {
        $ref: "#/$defs/P0OperatorProof",
      };
    },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const changed = structuredClone(registry);
    mutate(changed);
    assert.throws(() => composeBundle(changed), /UNSUPPORTED_OBSERVATION_/, `mutation ${index}`);
  }
});

test("p0.observation.generation: result schemas bind methods, while actual reserved failures remain intact", () => {
  const result = {
    target_instance_id: "service",
    target_received_at: { clock_domain: "clock", monotonic_ms: 1 },
    target_sent_at: { clock_domain: "clock", monotonic_ms: 2 },
    connection_id: "connection",
  };
  const response = { jsonrpc: "2.0", id: "rpc", result };
  assert.equal(valid("P0ObservedRpcResponse", { method: "clock.sample", response }), true);
  for (const method of ["plugin.describe", null, "unregistered.method"])
    assert.equal(valid("P0ObservedRpcResponse", { method, response }), false);
  assert.equal(
    valid("P0ObservedRpcResponse", {
      method: "clock.sample",
      response: { ...response, result: { arbitrary: true } },
    }),
    false,
  );
  for (const code of [-32700, -32600, -32601, -32602, -32603]) {
    const failure = {
      jsonrpc: "2.0",
      id: null,
      error: { code, message: "Synthetic protocol failure", data: null },
    };
    assert.equal(valid("P0ObservedRpcResponse", { method: null, response: failure }), true);
    assert.equal(
      valid("P0ObservedRpcResponse", { method: "clock.sample", response: failure }),
      true,
    );
    assert.equal(
      valid("P0ObservedRpcResponse", {
        method: null,
        response: { ...failure, error: { ...failure.error, code: 123 } },
      }),
      false,
    );
  }
});
