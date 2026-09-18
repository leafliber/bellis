import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { schemaDigest, validateRpcResponse } from "../packages/contract-sdk/src/index.ts";
import { SimulationEndpoint } from "../packages/contract-sdk/src/simulation.ts";
import { handshake, manifest, request } from "./helpers.ts";

test("sdk.rpc: stdio fake plugin exchanges bounded NDJSON without stdout logs", () => {
  const hello = handshake();
  hello.params.context.deadline.expires_at_ms = 10000;
  const describe = request("plugin.describe", {}, "describe-cli");
  describe.params.context.deadline.expires_at_ms = 10000;
  const result = spawnSync(process.execPath, ["tools/simulate-plugin.ts"], {
    encoding: "utf8",
    input: `${JSON.stringify(hello)}\n${JSON.stringify(describe)}\n`,
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  const replies = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(replies.length, 2);
  validateRpcResponse("plugin.handshake", replies[0]);
  validateRpcResponse("plugin.describe", replies[1]);
});

test("sdk.rpc: handshake and describe round-trip through generated envelopes", () => {
  const endpoint = new SimulationEndpoint(manifest(), () => 50);
  assert.equal(
    JSON.parse(endpoint.exchange(JSON.stringify(request("plugin.describe", {})))).error.data
      .reason_code,
    "AUTHENTICATION_REQUIRED",
  );
  const first = JSON.parse(endpoint.exchange(JSON.stringify(handshake())));
  assert.equal(first.result.schema_digest, schemaDigest);
  validateRpcResponse("plugin.handshake", first);
  const describe = request("plugin.describe", {}, "describe-1");
  const response = JSON.parse(endpoint.exchange(JSON.stringify(describe)));
  assert.equal(response.result.execution_mode, "simulation");
  assert.equal(endpoint.exchange(JSON.stringify(describe)), JSON.stringify(response));
});

test("sdk.rpc: same operation with different payload returns a typed integrity error", () => {
  const endpoint = new SimulationEndpoint(manifest(), () => 50);
  endpoint.exchange(JSON.stringify(handshake()));
  const response = JSON.parse(endpoint.exchange(JSON.stringify(request("plugin.describe", {}))));
  assert.equal(response.error.data.reason_code, "OPERATION_PAYLOAD_CONFLICT");
  validateRpcResponse("plugin.describe", response);
});

test("sdk.rpc: schema mismatch, expiry and malformed result are rejected", () => {
  const endpoint = new SimulationEndpoint(manifest(), () => 50);
  const hello = handshake();
  const bad = request("plugin.handshake", { ...hello.params.input, schema_digest: "0".repeat(64) });
  assert.equal(
    JSON.parse(endpoint.exchange(JSON.stringify(bad))).error.data.reason_code,
    "CONTRACT_REFERENCE_INVALID",
  );
  const expired = new SimulationEndpoint(manifest(), () => 1001);
  assert.equal(
    JSON.parse(expired.exchange(JSON.stringify(handshake()))).error.data.reason_code,
    "COMMAND_DEADLINE_MISSED",
  );
  const wrongClock = handshake();
  wrongClock.params.context.deadline.clock_domain = "other-host";
  assert.equal(
    JSON.parse(endpoint.exchange(JSON.stringify(wrongClock))).error.data.reason_code,
    "COMMAND_CLOCK_MISMATCH",
  );
  assert.throws(() =>
    validateRpcResponse("plugin.describe", { jsonrpc: "2.0", id: "x", result: {} }),
  );
});

test("sdk.rpc: transport failures and altered retry contexts stay explicit", () => {
  const endpoint = new SimulationEndpoint(manifest(), () => 50);
  assert.equal(JSON.parse(endpoint.exchange('{"x":1,"x":2}')).error.code, -32700);
  assert.equal(JSON.parse(endpoint.exchange("{}")).error.code, -32600);
  assert.equal(
    JSON.parse(endpoint.exchange(JSON.stringify(request("unknown.method", {})))).error.code,
    -32601,
  );
  assert.equal(
    JSON.parse(endpoint.exchange(JSON.stringify(request("plugin.handshake", {})))).error.code,
    -32602,
  );
  const hello = handshake();
  endpoint.exchange(JSON.stringify(hello));
  hello.params.context.deadline.expires_at_ms = 2000;
  assert.equal(
    JSON.parse(endpoint.exchange(JSON.stringify(hello))).error.data.reason_code,
    "OPERATION_PAYLOAD_CONFLICT",
  );
});
