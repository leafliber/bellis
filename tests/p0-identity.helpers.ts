import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  assertValid,
  type ControllerManifest,
  type P0OperatorCredential,
  type P0RuntimeConfig,
  type P0SafetyLimits,
  payloadDigest,
  type RuntimeProfile,
  schemaDigest,
} from "../packages/contract-sdk/src/index.ts";
import { exportPrivate, generateIdentity } from "../packages/runtime/src/identity.ts";
import { safeChildEnvironment, terminateChild } from "../packages/runtime/src/processes.ts";

export const repository = fileURLToPath(new URL("../", import.meta.url));
export const limits: P0SafetyLimits = {
  max_message_bytes: 65536,
  max_pending_requests: 16,
  max_effects: 16,
  max_queue_items: 8,
  max_session_ms: 10000,
  max_human_lease_ms: 5000,
  endpoint_lease_ms: 500,
  peer_health_timeout_ms: 2000,
  stop_timeout_ms: 500,
  cleanup_timeout_ms: 1000,
  max_clock_error_ms: 1000,
  clock_mapping_ttl_ms: 4000,
};

export function syntheticManifest(): ControllerManifest {
  return {
    plugin_id: "p0-protocol-fixture",
    plugin_version: "0.8.0",
    protocol_version: "0.8.0",
    schema_digest: schemaDigest,
    supported_platforms: ["darwin", "linux", "win32"],
    lifecycle: "controller",
    methods: [
      "plugin.handshake",
      "plugin.describe",
      "controller.observe_status",
      "controller.stop",
      "controller.dispose",
      "simulation.execute",
      "simulation.query",
      "endpoint.lease",
      "endpoint.revoke",
      "connection.authenticate",
      "clock.sample",
      "fault.apply",
    ],
    capabilities: [
      {
        name: "simulation.execute",
        version: "0.8.0",
        input_schema_ref: "p0-simulation-input@1",
        result_contract: "p0-simulation-result@1",
        permission_scope_ref: "p0-simulation-permission@1",
        effect_type: "internal_state",
        first_required_phase: "P0",
        status: "enabled",
      },
    ],
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
    success_evidence_ref: "p0-simulation-result@1",
    cleanup_evidence_ref: "p0-simulation-cleanup@1",
    permissions: {
      network_origins: [],
      read_paths: [],
      write_namespaces: [],
      credential_scopes: [],
    },
    configuration_schema_ref: "p0-endpoint-configuration@1",
    configuration_apply_boundary: "new_instance",
    control_capabilities: [],
    test_coverage_refs: [],
    execution_mode: "simulation",
  };
}

export async function createFixture() {
  const directory = await mkdtemp("/private/tmp/bp0-");
  await chmod(directory, 0o700);
  const pluginDirectory = join(directory, "plugin");
  await mkdir(pluginDirectory, { mode: 0o700 });
  const entry = join(pluginDirectory, "fixture.mjs");
  const runtime = join(repository, "packages/runtime/src");
  // This fixture executes actual runtime framing/identity only, never a device or an effect.
  await writeFile(
    entry,
    `
import { assertValid } from ${JSON.stringify(join(repository, "packages/contract-sdk/src/index.ts"))};
import { readPrivateBootstrap } from ${JSON.stringify(join(runtime, "files.ts"))};
import { identityFromKey } from ${JSON.stringify(join(runtime, "identity.ts"))};
import { MonotonicClock } from ${JSON.stringify(join(runtime, "clock.ts"))};
import { P0Service } from ${JSON.stringify(join(runtime, "service.ts"))};
import { JsonChannel } from ${JSON.stringify(join(runtime, "transport.ts"))};
const config = await readPrivateBootstrap();
assertValid("P0EndpointConfig", config);
const identity = identityFromKey("endpoint", config.endpoint_instance_id, config.identity_key_id, config.identity_private_key_pkcs8);
const service = new P0Service({ identity, authority: config.supervisor_identity, currentAuthorityEpoch: () => 0, sessionId: config.session_id, clock: new MonotonicClock(), limits: config.limits,
 credential: null,
 peers: [config.host_identity, config.supervisor_identity], snapshot: () => { throw new Error("NO_DEVICE_FACTS"); }, faultInjectionEnabled: false });
const channel = new JsonChannel(process.stdin, process.stdout, config.limits.max_message_bytes, config.limits.max_pending_requests);
channel.on("closed", () => { void service.close(); });
service.accept(channel);
`,
    { mode: 0o600 },
  );
  const manifest = syntheticManifest();
  const manifestPath = join(pluginDirectory, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  const compiled = await build({
    absWorkingDir: pluginDirectory,
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const paths = new Set<string>([manifestPath]);
  for (const relative of Object.keys(compiled.metafile.inputs)) {
    const path = await realpath(resolve(pluginDirectory, relative));
    paths.add(path);
    for (let dir = dirname(path); ; ) {
      try {
        const packagePath = join(dir, "package.json");
        if ((await stat(packagePath)).isFile()) {
          paths.add(await realpath(packagePath));
          break;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const artifacts = await Promise.all(
    [...paths].sort().map(async (path) => ({
      path,
      sha256: createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    })),
  );
  const credential: P0OperatorCredential = {
    credential_id: "fixture-operator",
    operator_id: "fixture-user",
    role: "test_operator",
    authentication_key_sha256: createHash("sha256")
      .update(exportPrivate(generateIdentity("host")))
      .digest("hex"),
  };
  const configPath = join(directory, "runtime.json");
  const credentialPath = join(directory, "operator.json");
  const keyPath = join(directory, "supervisor.pem");
  await writeFile(credentialPath, JSON.stringify(credential), { mode: 0o600 });
  await writeFile(keyPath, exportPrivate(generateIdentity("supervisor")), { mode: 0o600 });
  const originalProfile = JSON.parse(
    await readFile(join(repository, "contracts/fixtures/runtime-profile.json"), "utf8"),
  ) as RuntimeProfile;
  const entryArtifact = artifacts.find((item) => item.path === entry);
  if (!entryArtifact) throw new Error("FIXTURE_ENTRY_MISSING");
  const config: P0RuntimeConfig = {
    profile: {
      ...originalProfile,
      mode: "simulation",
      enabled_phases: ["P0"],
      enabled_capabilities: [{ name: "simulation.execute", version: "0.8.0" }],
    },
    public_broadcast_allowed: false,
    supervision_mode: "stopped",
    installation: {
      installation_id: "fixture-installation",
      plugin_id: manifest.plugin_id,
      plugin_version: manifest.plugin_version,
      entry: entryArtifact,
      artifacts,
      manifest_digest: payloadDigest(manifest),
      protocol_version: "0.8.0",
      schema_digest: schemaDigest,
      allowed_capabilities: [{ name: "simulation.execute", version: "0.8.0" }],
      allowed_targets: [{ kind: "SimulationCounter", id: "fixture-counter" }],
      execution_mode: "simulation",
      external_effects_allowed: false,
    },
    operator_credentials_path: credentialPath,
    service_identity_key_path: keyPath,
    management_socket_path: join(directory, "manage.sock"),
    safety_socket_path: join(directory, "safety.sock"),
    database_path: join(directory, "state.sqlite"),
    limits: { ...limits },
    fault_injection_enabled: true,
  };
  assertValid("P0RuntimeConfig", config);
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  return {
    directory,
    entry,
    config,
    manifest,
    credential,
    configPath,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export async function waitFor(path: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("CHILD_EXITED");
    try {
      await access(path);
      return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("CHILD_NOT_READY");
}

export async function stopProcess(child: ChildProcess): Promise<void> {
  await terminateChild(child);
}

export function runCli(configPath: string, command: "query" | "authenticate" | "host-query") {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(repository, "apps/host/operator.ts"), "--config", configPath, "--command", command],
      { env: safeChildEnvironment(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > 131072) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      // Includes the actual bounded request/response observations and their stream tail.
      if (stderr.length > 1_048_576) child.kill("SIGKILL");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
