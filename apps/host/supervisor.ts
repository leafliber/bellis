import { requireRuntimeVersion } from "../../packages/runtime/src/files.ts";
import { StartupObservation } from "../../packages/runtime/src/observation.ts";
import { startSupervisor } from "../../packages/runtime/src/processes.ts";

const args = process.argv.slice(2);
const startup = new AbortController();
let runtime: Awaited<ReturnType<typeof startSupervisor>> | undefined;
let closing = false;
const close = () => {
  startup.abort();
  if (!runtime || closing) return;
  closing = true;
  void runtime.close().catch(() => {
    process.exitCode = 1;
  });
};
// Install before the first asynchronous startup step, including installation validation.
process.on("SIGINT", close);
process.on("SIGTERM", close);
const observation = new StartupObservation("supervisor");
let handedOff = false;
try {
  requireRuntimeVersion();
  observation.stage = "arguments";
  if (args.length !== 2 || args[0] !== "--config" || !args[1]) throw new Error("INVALID_ARGUMENTS");
  handedOff = true;
  runtime = await startSupervisor(args[1], startup.signal);
  if (startup.signal.aborted) close();
} catch (error) {
  const cancelled =
    startup.signal.aborted &&
    error instanceof Error &&
    (error.name === "AbortError" || error.message === "STARTUP_CANCELLED");
  if (!cancelled) {
    if (!handedOff) await observation.failed(error);
    process.exitCode = 1;
  }
}
