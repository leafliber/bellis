import { assertValid } from "../../packages/contract-sdk/src/index.ts";
import { verifiedEndpointUrl } from "../../packages/runtime/src/endpoint-loader.ts";
import { readPrivateBootstrap, requireRuntimeVersion } from "../../packages/runtime/src/files.ts";

const abort = new AbortController();
const stop = () => abort.abort();
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
try {
  requireRuntimeVersion();
  const config = await readPrivateBootstrap(3, abort.signal);
  assertValid("P0EndpointConfig", config);
  const url = await verifiedEndpointUrl(config.entry_artifact);
  abort.signal.throwIfAborted();
  // Sole dynamic load: a data URL from the same controlled, hashed buffer.
  const endpoint = await import(url);
  abort.signal.throwIfAborted();
  if (typeof endpoint.startEndpoint !== "function") throw new Error("ENDPOINT_EXPORT_MISSING");
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
  await endpoint.startEndpoint(config);
} catch {
  process.stderr.write("ENDPOINT_STARTUP_REJECTED\n");
  process.exitCode = 1;
}
