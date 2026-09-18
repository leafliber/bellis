import { readFileSync } from "node:fs";
import {
  type ControllerManifest,
  payloadDigest,
  schemaDigest,
} from "../packages/contract-sdk/src/index.ts";

export const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../contracts/fixtures/${name}`, import.meta.url), "utf8"));

export const manifest = (): ControllerManifest => ({
  plugin_id: "simulation",
  plugin_version: "0.8.0",
  protocol_version: "0.8.0",
  schema_digest: schemaDigest,
  supported_platforms: ["darwin", "win32", "linux"],
  lifecycle: "provider",
  methods: ["plugin.handshake", "plugin.describe"],
  capabilities: [],
  supported_contexts: [],
  resources: [],
  max_concurrency: 1,
  update_support: {
    checkpoint: false,
    quiesce: false,
    snapshot: false,
    restore: false,
    policy_patch: false,
  },
  success_evidence_ref: "simulation-success@1",
  cleanup_evidence_ref: "simulation-cleanup@1",
  permissions: { network_origins: [], read_paths: [], write_namespaces: [], credential_scopes: [] },
  configuration_schema_ref: "simulation-configuration@1",
  configuration_apply_boundary: "new_instance",
  control_capabilities: [],
  test_coverage_refs: ["sdk.rpc"],
  execution_mode: "simulation",
});

export const request = <T>(method: string, input: T, operation = "operation-1") => ({
  jsonrpc: "2.0",
  id: "rpc-1",
  method,
  params: {
    context: {
      operation_id: operation,
      payload_digest: payloadDigest({ method, input }),
      caller_instance_id: "host-1",
      authority_epoch: 1,
      object_ref: { kind: "Task", id: "simulation-task" },
      deadline: { clock_domain: "simulation", issued_at_ms: 0, expires_at_ms: 1000 },
      grant_ref: null,
    },
    input,
  },
});

export const handshake = () =>
  request("plugin.handshake", {
    host_instance_id: "host-1",
    protocol_versions: ["0.8.0"],
    schema_digest: schemaDigest,
    enabled_phases: ["P0"],
  });
