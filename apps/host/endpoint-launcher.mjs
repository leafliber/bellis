import { assertValid } from "../../packages/contract-sdk/src/index.ts";
import { verifiedEndpointUrl } from "../../packages/runtime/src/endpoint-loader.ts";
import { readPrivateBootstrap, requireRuntimeVersion } from "../../packages/runtime/src/files.ts";
import { StartupObservation } from "../../packages/runtime/src/observation.ts";

const abort = new AbortController();
const stop = () => abort.abort();
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
const startup = new StartupObservation("endpoint");
let handedOff = false;
try {
  requireRuntimeVersion();
  startup.stage = "bootstrap";
  const config = await readPrivateBootstrap(3, abort.signal);
  assertValid("P0EndpointConfig", config);
  const observation = startup.bind(config.endpoint_instance_id, config.limits);
  startup.stage = "installation";
  const url = await verifiedEndpointUrl(config.entry_artifact);
  abort.signal.throwIfAborted();
  // Sole dynamic load: a data URL from the same controlled, hashed buffer.
  startup.stage = "launch";
  const endpoint = await import(url);
  abort.signal.throwIfAborted();
  if (typeof endpoint.startEndpoint !== "function") throw new Error("ENDPOINT_EXPORT_MISSING");
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
  handedOff = true;
  await endpoint.startEndpoint(config, observation);
} catch (error) {
  if (!handedOff) await startup.failed(error);
  if (startup.writer?.osWriteInFlight) process.kill(process.pid, "SIGKILL");
  process.exit(1);
}
