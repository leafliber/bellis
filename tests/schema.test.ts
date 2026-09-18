import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { errors } from "../contracts/generated/registries.ts";
import {
  assertValid,
  validate,
  validateManifest,
  validateProfile,
} from "../packages/contract-sdk/src/index.ts";
import { fixture, manifest } from "./helpers.ts";

const bundle = JSON.parse(readFileSync("contracts/generated/bundle.schema.json", "utf8"));

test("sdk.schema: generated validators agree with the bundle on fixtures and missing fields", () => {
  const ajv = new Ajv2020({ strict: false });
  ajv.addSchema(bundle);
  for (const [type, file] of [
    ["RuntimeProfile", "runtime-profile.json"],
    ["ControllerManifest", "plugin-manifest.json"],
  ] as const) {
    const value = fixture(file);
    assertValid(type, value);
    const reference = ajv.getSchema(`${bundle.$id}#/$defs/${type}`);
    assert.ok(reference);
    assert.equal(reference(value), true);
    for (const key of bundle.$defs[type].required) {
      const broken = structuredClone(value) as Record<string, unknown>;
      delete broken[key];
      assert.equal(validate(type, broken), false, `${type}.${key}`);
      assert.equal(reference(broken), false);
    }
  }
});

test("sdk.schema: error envelopes bind each reason code to its category and retry disposition", () => {
  const categories = [...new Set(errors.errors.map((e) => e.category))];
  const dispositions = [...new Set(errors.errors.map((e) => e.retry_disposition))];
  for (const e of errors.errors) {
    const envelope = {
      category: e.category,
      reason_code: e.reason_code,
      object_ref: { kind: "Task", id: "fixture-task" },
      phase: "fixture",
      operation_id: null,
      retry_disposition: e.retry_disposition,
      safe_message: "合成测试错误",
      evidence_refs: [],
    };
    assert.equal(validate("ErrorEnvelope", envelope), true, e.reason_code);
    const category = categories.find((c) => c !== e.category);
    assert.equal(validate("ErrorEnvelope", { ...envelope, category }), false, e.reason_code);
    const retry_disposition = dispositions.find((d) => d !== e.retry_disposition);
    assert.equal(validate("ErrorEnvelope", { ...envelope, retry_disposition }), false);
    assert.equal(validate("ErrorEnvelope", { ...envelope, reason_code: "UNREGISTERED" }), false);
  }
});

test("sdk.schema: event envelopes accept only registered events with the bound payload", () => {
  const stop = {
    object_ref: { kind: "StopOperation", id: "stop-1" },
    source_revision: 1,
    endpoint_instance: "stage-1",
    confirmed: true,
    known_effect_refs: [],
    unknown_scope_refs: [],
    cleanup_ref: null,
    evidence_refs: [],
  };
  const envelope = {
    schema_version: "0.8.0",
    event_name: "stop.confirmed",
    event_id: "event-1",
    authority_id: "host",
    source_instance: "host-1",
    authority_epoch: 1,
    source_seq: 0,
    session_id: "session-1",
    scope_ref: { kind: "StopOperation", id: "stop-1" },
    correlation: { key: "stop", value: "stop-1" },
    occurred_at: { clock_domain: "host", monotonic_ms: 10 },
    trace_id: "trace-1",
    payload: stop,
  };
  assert.equal(validate("EventEnvelope", envelope), true);
  // Commands and unregistered names are not facts.
  assert.equal(validate("EventEnvelope", { ...envelope, event_name: "scene.open" }), false);
  assert.equal(validate("EventEnvelope", { ...envelope, event_name: "stop.invented" }), false);
  // stop.* events bind StopPayload; a payload of another shape is rejected.
  assert.equal(validate("EventEnvelope", { ...envelope, payload: { note: "free form" } }), false);
});

test("sdk.schema: profiles enable only registered phases with their dependencies", () => {
  const profile = validateProfile(fixture("runtime-profile.json"));
  assert.throws(() => validateProfile({ ...profile, mode: "public" }));
  assert.throws(() =>
    validateProfile({ ...profile, stage: { ...profile.stage, max_pcm_buffer_ms: 1 } }),
  );
  assert.equal(validate("RuntimeProfile", { ...profile, surprise: true }), false);
  assert.throws(
    () => validateProfile({ ...profile, enabled_phases: ["P1"] }),
    /PROFILE_PHASE_DEPENDENCY:P0/,
  );
  // Frozen phases are not part of the Phase vocabulary until they are promoted.
  assert.throws(() => validateProfile({ ...profile, enabled_phases: ["P0", "P3"] }));
});

test("sdk.schema: manifest refuses unsupported flags, unknown methods and simulated effects", () => {
  assert.doesNotThrow(() => validateManifest(manifest()));
  const bad = manifest();
  bad.update_support.restore = true;
  assert.throws(() => validateManifest(bad));
  assert.throws(() => validateManifest({ ...manifest(), methods: ["unknown.method"] }));
});
