import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { errors } from "../contracts/generated/registries.ts";
import {
  assertValid,
  bindVerifiedP0Installation,
  payloadDigest,
  validate,
  validateManifest,
  validateProfile,
} from "../packages/contract-sdk/src/index.ts";
import { fixture, manifest } from "./helpers.ts";
import { syntheticManifest } from "./p0-identity.helpers.ts";

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

test("sdk.schema: P0 installation context permits only the precise registered simulation boundary", () => {
  // Synthetic SDK binding only. Filesystem installation trust is exercised by p0.identity.
  const good = syntheticManifest();
  const contextFor = (value: typeof good) =>
    bindVerifiedP0Installation({
      installation_id: "sdk-synthetic",
      plugin_id: value.plugin_id,
      plugin_version: value.plugin_version,
      entry: { path: "/synthetic/entry.mjs", sha256: "0".repeat(64) },
      artifacts: [{ path: "/synthetic/entry.mjs", sha256: "0".repeat(64) }],
      manifest_digest: payloadDigest(value),
      protocol_version: "0.8.0",
      schema_digest: value.schema_digest,
      allowed_capabilities: [{ name: "simulation.execute", version: "0.8.0" }],
      allowed_targets: [{ kind: "SimulationCounter", id: "synthetic-counter" }],
      execution_mode: "simulation",
      external_effects_allowed: false,
    });
  assert.doesNotThrow(() => validateManifest(good, undefined, contextFor(good)));
  assert.throws(() => validateManifest(good), /SIMULATION_INSTALLATION_REQUIRED/);
  const variants = [
    { ...good, execution_mode: "real" as const },
    {
      ...good,
      capabilities: good.capabilities.map((cap) => ({
        ...cap,
        effect_type: "external_effect" as const,
      })),
    },
    {
      ...good,
      capabilities: good.capabilities.map((cap) => ({ ...cap, name: "unknown.capability" })),
    },
    { ...good, capabilities: good.capabilities.map((cap) => ({ ...cap, version: "0.8.1" })) },
    {
      ...good,
      capabilities: good.capabilities.map((cap) => ({
        ...cap,
        input_schema_ref: "p0-simulation-result@1",
      })),
    },
    {
      ...good,
      capabilities: good.capabilities.map((cap) => ({
        ...cap,
        first_required_phase: "P1" as const,
      })),
    },
    { ...good, permissions: { ...good.permissions, network_origins: ["https://example.invalid"] } },
    { ...good, methods: [...good.methods, "session.authorize"] },
    { ...good, configuration_schema_ref: "runtime-profile@1" },
  ];
  for (const value of variants) {
    // Match the changed manifest digest deliberately: semantic rejection must remain independent.
    assert.throws(() => validateManifest(value, undefined, contextFor(value)));
  }
  const profile = {
    ...validateProfile(fixture("runtime-profile.json")),
    enabled_phases: ["P0"],
    enabled_capabilities: [{ name: "simulation.execute", version: "0.8.0" }],
  };
  assert.doesNotThrow(() => validateProfile(profile, contextFor(good)));
  assert.throws(() => validateProfile(profile), /SIMULATION_INSTALLATION_REQUIRED/);
  const otherMode = {
    ...profile,
    mode: "test_only",
    cost: {
      currency: "synthetic",
      session_cost_cap: 1,
      rolling_hour_cost_cap: 1,
      providers: [
        {
          provider_ref: "synthetic-budget@1",
          request_timeout_ms: 1,
          max_calls: 1,
          llm_tokens: 0,
          tts_characters: 0,
          tts_audio_ms: 0,
          vlm_frames: 0,
          rpm: 1,
          tpm: 0,
          guard_calls: 1,
          max_retries: 0,
          speculative_waste_units: 0,
          pricing_ref: null,
        },
      ],
    },
  };
  assertValid("RuntimeProfile", otherMode);
  assert.throws(() => validateProfile(otherMode), /SIMULATION_EFFECTS_DISABLED/);
  assert.throws(() => validateProfile(otherMode, contextFor(good)), /SIMULATION_EFFECTS_DISABLED/);
  assert.throws(
    () => validateProfile({ ...otherMode, mode: "public" }, contextFor(good)),
    /SIMULATION_EFFECTS_DISABLED/,
  );
  assert.throws(
    () => validateManifest({ ...good, execution_mode: "real" }),
    /SIMULATION_CAPABILITY_ENABLED/,
  );
  assert.throws(
    () => validateProfile({ ...profile, enabled_phases: ["P0", "P1"] }, contextFor(good)),
    /SIMULATION_EFFECTS_DISABLED/,
  );
  assert.throws(
    () =>
      validateProfile(
        { ...profile, enabled_capabilities: [{ name: "real.output", version: "0.8.0" }] },
        contextFor(good),
      ),
    /PROFILE_UNKNOWN_CAPABILITY/,
  );
  assert.throws(
    () => validateManifest(good, undefined, { installation: contextFor(good).installation }),
    /SIMULATION_INSTALLATION_REQUIRED/,
  );
});
