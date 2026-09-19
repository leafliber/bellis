import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertValid,
  type P0TrustedInstallation,
  payloadDigest,
  schemaDigest,
} from "../packages/contract-sdk/src/index.ts";
import { verifyInstallation } from "../packages/runtime/src/config.ts";
import {
  decodeJson,
  requireRuntimeVersion,
  secureDirectory,
} from "../packages/runtime/src/files.ts";

/** Explicitly install this generated fake. Startup never regenerates or updates its trust list. */
export async function installFakeDevice(
  directory: string,
  targetId: string,
): Promise<P0TrustedInstallation> {
  requireRuntimeVersion();
  if (resolve(directory) !== directory) throw new Error("ABSOLUTE_INSTALL_DIRECTORY_REQUIRED");
  await secureDirectory(dirname(directory));
  const generated = fileURLToPath(new URL("../plugins/fake-device/generated/", import.meta.url));
  const entryBytes = await readFile(join(generated, "endpoint.mjs"));
  const manifestBytes = await readFile(join(generated, "manifest.json"));
  const manifest = decodeJson(manifestBytes);
  assertValid("ControllerManifest", manifest);
  if (manifest.plugin_id !== "bellis-p0-fake-device" || manifest.schema_digest !== schemaDigest)
    throw new Error("CURRENT_FAKE_REQUIRED");
  await mkdir(directory, { mode: 0o700 });
  const artifacts = [];
  for (const [name, bytes] of [
    ["endpoint.mjs", entryBytes],
    ["manifest.json", manifestBytes],
  ] as const) {
    const path = join(directory, name);
    await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
    artifacts.push({ path, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const entry = artifacts[0];
  if (!entry) throw new Error("INSTALL_ENTRY_MISSING");
  const installation: P0TrustedInstallation = {
    installation_id: randomUUID(),
    plugin_id: manifest.plugin_id,
    plugin_version: manifest.plugin_version,
    entry,
    artifacts,
    manifest_digest: payloadDigest(manifest),
    protocol_version: "0.8.0",
    schema_digest: schemaDigest,
    allowed_capabilities: [{ name: "simulation.execute", version: "0.8.0" }],
    allowed_targets: [{ kind: "SimulationCounter", id: targetId }],
    execution_mode: "simulation",
    external_effects_allowed: false,
  };
  await verifyInstallation(installation);
  return installation;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, targetId, ...extra] = process.argv.slice(2);
  if (!directory || !targetId || extra.length)
    throw new Error("USAGE: pnpm p0:install <absolute-new-directory> <counter-id>");
  process.stdout.write(
    `${JSON.stringify(await installFakeDevice(directory, targetId), null, 2)}\n`,
  );
}
