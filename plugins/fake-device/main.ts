import { assertValid, schemaDigest } from "../../packages/contract-sdk/src/index.ts";
import { MonotonicClock } from "../../packages/runtime/src/clock.ts";
import { identityFromKey } from "../../packages/runtime/src/identity.ts";
import {
  ObservationWriter,
  observationError,
  StartupObservation,
  type StartupStage,
} from "../../packages/runtime/src/observation.ts";
import { EndpointProtocol } from "./protocol.ts";

/** Called only by the trusted same-buffer launcher, never by module evaluation. */
export async function startEndpoint(raw: unknown, inherited?: ObservationWriter): Promise<void> {
  let observation = inherited;
  const exit = (code: number): never => {
    // The launcher may supply a writer from a separate module instance; inspect that object.
    if (observation?.osWriteInFlight) process.kill(process.pid, "SIGKILL");
    process.exit(code);
  };
  let endpoint: EndpointProtocol | undefined;
  let stage: StartupStage = "bootstrap";
  try {
    assertValid("P0EndpointConfig", raw);
    observation ??= new ObservationWriter(
      "endpoint",
      raw.endpoint_instance_id,
      new MonotonicClock(),
      raw.limits,
    );
    if (
      raw.manifest.plugin_id !== "bellis-p0-fake-device" ||
      raw.manifest.schema_digest !== schemaDigest ||
      raw.manifest.execution_mode !== "simulation" ||
      raw.fault.fault !== "none" ||
      raw.fault.duration_ms !== 0
    )
      throw new Error("INSTALLATION_IDENTITY_DENIED");
    endpoint = new EndpointProtocol(
      raw,
      identityFromKey(
        "endpoint",
        raw.endpoint_instance_id,
        raw.identity_key_id,
        raw.identity_private_key_pkcs8,
      ),
      observation.clock,
      observation,
    );
    endpoint.onExit = () => exit(0);
    let stopping = false;
    const stop = () => {
      stopping = true;
      void endpoint?.close();
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    stage = "listen";
    await endpoint.start();
    if (stopping) await endpoint.close();
  } catch (error) {
    if (observation)
      observation.process({ kind: "startup_rejected", stage, error: observationError(error) });
    else {
      const startup = new StartupObservation("endpoint");
      startup.stage = stage;
      await startup.failed(error);
    }
    if (endpoint) {
      endpoint.onExit = () => exit(1);
      await endpoint.close();
    } else await observation?.finish();
    throw error;
  }
}
