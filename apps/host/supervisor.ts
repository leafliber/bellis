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
if (args.length !== 2 || args[0] !== "--config" || !args[1]) {
  process.stderr.write("用法：supervisor.ts --config <P0RuntimeConfig文件>\n");
  process.exitCode = 1;
} else {
  try {
    runtime = await startSupervisor(args[1], startup.signal);
    if (startup.signal.aborted) close();
  } catch (error) {
    const cancelled =
      startup.signal.aborted &&
      error instanceof Error &&
      (error.name === "AbortError" || error.message === "STARTUP_CANCELLED");
    if (!cancelled) {
      process.stderr.write("P0_SUPERVISOR_STARTUP_REJECTED\n");
      process.exitCode = 1;
    }
  }
}
