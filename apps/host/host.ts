import { readPrivateBootstrap } from "../../packages/runtime/src/files.ts";
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

try {
  if (process.argv.length !== 2) throw new Error("PRIVATE_BOOTSTRAP_ONLY");
  runtime = await startHost(await readPrivateBootstrap(3, startup.signal), startup.signal);
  if (startup.signal.aborted) close();
} catch (error) {
  const cancelled =
    startup.signal.aborted &&
    error instanceof Error &&
    (error.name === "AbortError" ||
      ["STARTUP_CANCELLED", "BOOTSTRAP_CANCELLED"].includes(error.message));
  if (!cancelled) {
    process.stderr.write("P0_HOST_STARTUP_REJECTED\n");
    process.exitCode = 1;
  }
}
