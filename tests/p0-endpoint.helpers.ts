import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertValid, type P0EndpointConfig } from "../packages/contract-sdk/src/index.ts";
import { exportPrivate, generateIdentity } from "../packages/runtime/src/identity.ts";
import { installFakeDevice } from "../tools/p0-install.ts";
import { createFixture } from "./p0-identity.helpers.ts";

/** Production fake installation; unlike the separate W3 protocol fixture this has actual device state. */
export async function createProductionFixture() {
  const fixture = await createFixture();
  fixture.config.installation = await installFakeDevice(
    join(fixture.directory, "fake"),
    "fixture-counter",
  );
  await writeFile(fixture.configPath, JSON.stringify(fixture.config));
  const manifest = JSON.parse(
    await readFile(join(fixture.directory, "fake/manifest.json"), "utf8"),
  );
  assertValid("ControllerManifest", manifest);
  return { ...fixture, entry: fixture.config.installation.entry.path, manifest };
}

export async function endpointMaterials(
  fixture: Awaited<ReturnType<typeof createProductionFixture>>,
) {
  const host = generateIdentity("host");
  const supervisor = generateIdentity("supervisor");
  const endpoint = generateIdentity("endpoint");
  const config: P0EndpointConfig = {
    session_id: randomUUID(),
    endpoint_instance_id: endpoint.public.instance_id,
    identity_key_id: endpoint.public.identity_key_id,
    identity_private_key_pkcs8: exportPrivate(endpoint),
    host_identity: { ...host.public, role: "host" },
    supervisor_identity: { ...supervisor.public, role: "supervisor" },
    safety_socket_path: fixture.config.safety_socket_path,
    limits: { ...fixture.config.limits },
    installation_id: fixture.config.installation.installation_id,
    entry_artifact: fixture.config.installation.entry,
    manifest: JSON.parse(await readFile(join(fixture.directory, "fake/manifest.json"), "utf8")),
    fault: { target: "endpoint", fault: "none", duration_ms: 0 },
  };
  assertValid("P0EndpointConfig", config);
  return { host, supervisor, endpoint, config };
}
