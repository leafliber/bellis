import { assertValid, schemaDigest } from "../../packages/contract-sdk/src/index.ts";
import { MonotonicClock } from "../../packages/runtime/src/clock.ts";
import { identityFromKey } from "../../packages/runtime/src/identity.ts";
import { EndpointProtocol } from "./protocol.ts";

/** Called only by the trusted same-buffer launcher, never by module evaluation. */
export async function startEndpoint(raw: unknown): Promise<void> {
  assertValid("P0EndpointConfig", raw);
  if (
    raw.manifest.plugin_id !== "bellis-p0-fake-device" ||
    raw.manifest.schema_digest !== schemaDigest ||
    raw.manifest.execution_mode !== "simulation" ||
    raw.fault.fault !== "none" ||
    raw.fault.duration_ms !== 0
  )
    throw new Error("INSTALLATION_IDENTITY_DENIED");
  const endpoint = new EndpointProtocol(
    raw,
    identityFromKey(
      "endpoint",
      raw.endpoint_instance_id,
      raw.identity_key_id,
      raw.identity_private_key_pkcs8,
    ),
    new MonotonicClock(),
  );
  endpoint.onExit = () => process.exit(0);
  let stopping = false;
  const stop = () => {
    stopping = true;
    void endpoint.close();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await endpoint.start();
    if (stopping) await endpoint.close();
  } catch (error) {
    await endpoint.close();
    throw error;
  }
}
