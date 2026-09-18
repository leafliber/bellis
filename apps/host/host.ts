import { readPrivateBootstrap, requireRuntimeVersion } from "../../packages/runtime/src/files.ts";
import { StartupObservation } from "../../packages/runtime/src/observation.ts";
import { startHost } from "../../packages/runtime/src/processes.ts";

const startup = new AbortController();
let runtime: Awaited<ReturnType<typeof startHost>> | undefined;
let closing = false;
const close = () => {
  startup.abort();
  if (!runtime || closing) return;
  closing = true;
  void runtime.close().catch(() => {
    process.exitCode = 1;
  });
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
const observation = new StartupObservation("host");
let handedOff = false;

try {
  requireRuntimeVersion();
  observation.stage = "arguments";
  if (process.argv.length !== 2) throw new Error("PRIVATE_BOOTSTRAP_ONLY");
  observation.stage = "bootstrap";
  const bootstrap = await readPrivateBootstrap(3, startup.signal);
  handedOff = true;
  runtime = await startHost(bootstrap, startup.signal);
  if (startup.signal.aborted) close();
} catch (error) {
  const cancelled =
    startup.signal.aborted &&
    error instanceof Error &&
    (error.name === "AbortError" ||
      ["STARTUP_CANCELLED", "BOOTSTRAP_CANCELLED"].includes(error.message));
  if (!cancelled) {
    if (!handedOff) await observation.failed(error);
    process.exitCode = 1;
  }
}
