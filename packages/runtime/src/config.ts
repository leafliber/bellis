import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { build } from "esbuild";
import {
  assertValid,
  bindVerifiedP0Installation,
  type ControllerManifest,
  type P0HostBootstrap,
  type P0InstallationContext,
  type P0OperatorCredential,
  type P0RuntimeConfig,
  type P0TrustedInstallation,
  payloadDigest,
  schemaDigest,
  validateManifest,
  validateProfile,
} from "../../contract-sdk/src/index.ts";
import { reject } from "./errors.ts";
import { controlledPath, decodeJson, readControlled, readCredential, uid } from "./files.ts";
import { identityFromKey } from "./identity.ts";

const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");

async function installationFile(path: string): Promise<Buffer> {
  if (!isAbsolute(path) || resolve(path) !== path || (await realpath(path)) !== path)
    reject("INSTALLATION_IDENTITY_DENIED");
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.uid !== uid() ||
    (before.mode & 0o022) !== 0 ||
    before.size > 32 * 1024 * 1024
  )
    reject("INSTALLATION_IDENTITY_DENIED");
  return readFile(path);
}

export type VerifiedInstallation = { context: P0InstallationContext; manifest: ControllerManifest };

export async function verifyInstallation(
  installation: P0TrustedInstallation,
): Promise<VerifiedInstallation> {
  assertValid("P0TrustedInstallation", installation);
  if (installation.schema_digest !== schemaDigest) reject("INSTALLATION_IDENTITY_DENIED");
  const files = new Map<string, string>();
  for (const item of installation.artifacts) {
    if (files.has(item.path)) reject("INSTALLATION_IDENTITY_DENIED");
    files.set(item.path, item.sha256);
    if (sha256(await installationFile(item.path)) !== item.sha256)
      reject("INSTALLATION_IDENTITY_DENIED");
  }
  if (files.get(installation.entry.path) !== installation.entry.sha256)
    reject("INSTALLATION_IDENTITY_DENIED");
  const manifestPath = join(dirname(installation.entry.path), "manifest.json");
  if (!files.has(manifestPath)) reject("INSTALLATION_IDENTITY_DENIED");
  const manifest = decodeJson(await installationFile(manifestPath));
  assertValid("ControllerManifest", manifest);
  if (
    payloadDigest(manifest) !== installation.manifest_digest ||
    manifest.execution_mode !== "simulation" ||
    manifest.plugin_id !== installation.plugin_id ||
    manifest.plugin_version !== installation.plugin_version ||
    manifest.protocol_version !== installation.protocol_version ||
    manifest.schema_digest !== schemaDigest ||
    !manifest.supported_platforms.includes(process.platform as "darwin" | "linux" | "win32")
  )
    reject("INSTALLATION_IDENTITY_DENIED");
  // Resolve without running the entry. Only static ESM plus Node built-ins is supported in P0.
  const compilation = await build({
    absWorkingDir: dirname(installation.entry.path),
    entryPoints: [installation.entry.path],
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
    logOverride: {
      "unsupported-dynamic-import": "error",
      "unsupported-require-call": "error",
      "indirect-require": "error",
      "direct-eval": "error",
    },
  });
  if (compilation.warnings.length) reject("INSTALLATION_IDENTITY_DENIED");
  const singleFake = manifest.plugin_id === "bellis-p0-fake-device";
  if (singleFake && Object.keys(compilation.metafile.inputs).length !== 1)
    reject("INSTALLATION_IDENTITY_DENIED");
  const required = new Set([manifestPath]);
  for (const [name, metadata] of Object.entries(compilation.metafile.inputs)) {
    const path = await realpath(resolve(dirname(installation.entry.path), name));
    const bytes = await installationFile(path);
    required.add(path);
    for (const dependency of metadata.imports) {
      if (
        singleFake &&
        (!dependency.external ||
          ![
            "node:crypto",
            "node:events",
            "node:fs",
            "node:fs/promises",
            "node:net",
            "node:path",
          ].includes(dependency.path))
      )
        reject("INSTALLATION_IDENTITY_DENIED");
      if (["dynamic-import", "require-call", "require-resolve"].includes(dependency.kind))
        reject("INSTALLATION_IDENTITY_DENIED");
      if (
        dependency.external &&
        (!isBuiltin(dependency.path) ||
          ["module", "vm", "child_process", "worker_threads"].includes(
            dependency.path.replace(/^node:/, ""),
          ))
      )
        reject("INSTALLATION_IDENTITY_DENIED");
    }
    // Package metadata is part of Node's loader behavior even for explicit file imports.
    for (let directory = dirname(path); ; ) {
      const packagePath = join(directory, "package.json");
      try {
        if ((await stat(packagePath)).isFile()) {
          required.add(await realpath(packagePath));
          break;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    if (files.get(path) !== sha256(bytes)) reject("INSTALLATION_IDENTITY_DENIED");
  }
  for (const path of required) if (!files.has(path)) reject("INSTALLATION_IDENTITY_DENIED");
  // A second digest read closes accidental preflight changes; runtime loading remains a W4 boundary.
  for (const [path, digest] of files)
    if (sha256(await installationFile(path)) !== digest) reject("INSTALLATION_IDENTITY_DENIED");
  const context = bindVerifiedP0Installation(installation);
  validateManifest(manifest, undefined, context);
  return { context, manifest };
}

export async function loadRuntimeConfig(path: string): Promise<{
  config: P0RuntimeConfig;
  installation: VerifiedInstallation;
  credential: P0OperatorCredential;
}> {
  const config = decodeJson(await readControlled(path));
  assertValid("P0RuntimeConfig", config);
  if (config.installation.plugin_id !== "bellis-p0-fake-device")
    reject("INSTALLATION_IDENTITY_DENIED");
  const directory = dirname(path);
  for (const p of [config.operator_credentials_path, config.service_identity_key_path])
    await controlledPath(p, directory, true);
  for (const p of [
    config.management_socket_path,
    `${config.management_socket_path}.host`,
    config.safety_socket_path,
    `${config.management_socket_path}.identity.json`,
    `${config.management_socket_path}.host.identity.json`,
  ])
    await controlledPath(p, directory, false);
  if (
    dirname(config.database_path) !== directory ||
    resolve(config.database_path) !== config.database_path
  )
    reject("INSTALLATION_IDENTITY_DENIED");
  const paths = [
    path,
    config.operator_credentials_path,
    config.service_identity_key_path,
    config.database_path,
    config.management_socket_path,
    `${config.management_socket_path}.host`,
    config.safety_socket_path,
    `${config.management_socket_path}.identity.json`,
    `${config.management_socket_path}.host.identity.json`,
  ];
  if (new Set(paths).size !== paths.length) reject("INSTALLATION_IDENTITY_DENIED");
  const installation = await verifyInstallation(config.installation);
  validateProfile(config.profile, installation.context);
  if (
    payloadDigest(config.profile.enabled_capabilities) !==
    payloadDigest(config.installation.allowed_capabilities)
  )
    reject("SIMULATION_SCOPE_DENIED");
  return {
    config,
    installation,
    credential: await readCredential(config.operator_credentials_path),
  };
}

export async function validateBootstrap(value: unknown): Promise<P0HostBootstrap> {
  assertValid("P0HostBootstrap", value);
  if (value.installation.plugin_id !== "bellis-p0-fake-device")
    reject("INSTALLATION_IDENTITY_DENIED");
  const endpoint = value.endpoint_config;
  const identity = identityFromKey(
    "host",
    value.host_instance_id,
    value.identity_key_id,
    value.identity_private_key_pkcs8,
  );
  const installation = await verifyInstallation(value.installation);
  validateProfile(value.profile, installation.context);
  if (
    value.host_socket_path !== `${value.supervisor_socket_path}.host` ||
    value.session_id !== endpoint.session_id ||
    payloadDigest(endpoint.host_identity) !== payloadDigest(identity.public) ||
    payloadDigest(endpoint.supervisor_identity) !== payloadDigest(value.supervisor_identity) ||
    payloadDigest(endpoint.limits) !== payloadDigest(value.limits) ||
    endpoint.installation_id !== value.installation.installation_id ||
    payloadDigest(endpoint.entry_artifact) !== payloadDigest(value.installation.entry) ||
    payloadDigest(endpoint.manifest) !== payloadDigest(installation.manifest) ||
    payloadDigest(value.profile.enabled_capabilities) !==
      payloadDigest(value.installation.allowed_capabilities)
  )
    reject("INSTALLATION_IDENTITY_DENIED");
  const directory = dirname(value.supervisor_socket_path);
  await controlledPath(value.host_socket_path, directory, false);
  await controlledPath(`${value.host_socket_path}.identity.json`, directory, false);
  await controlledPath(value.operator_credentials_path, directory, true);
  await controlledPath(endpoint.safety_socket_path, directory, false);
  return value;
}
