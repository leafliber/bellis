import { startRuntime, loadIrisRuntimeConfiguration } from "../apps/runtime/dist/index.js";

// Fixed local installation entry; configuration cannot select executable code.
export async function startConfiguredIrisRuntime(path, environment = process.env) {
  const loaded = await loadIrisRuntimeConfiguration(path, environment);
  if (!loaded.iris.enabled) return startRuntime({ config: loaded.runtime });
  const config = loaded.iris;
  const { IrisMemoryProvider, IrisRecallVerifier } =
    await import("../providers/memory-iris/dist/src/index.js");
  const connection = {
    baseUrl: config.baseUrl,
    bearerToken: loaded.bearerToken,
    minimumCoreSchemaVersion: config.coreSchema.minimum,
    maximumCoreSchemaVersion: config.coreSchema.maximum,
  };
  const iris = new IrisMemoryProvider({
    ...connection,
    activeSurfaceMode: config.activeSurfaceMode,
  });
  const verifier =
    config.historyRecovery === undefined
      ? undefined
      : new IrisRecallVerifier({
          ...connection,
          agentId: config.agentId,
          spaceId: config.spaceId,
          timeoutMs: Math.min(config.historyRecovery.timeoutMs, 30000),
        });
  try {
    const runtime = await startRuntime({
      config: loaded.runtime,
      memory: {
        appInstanceId: config.appInstanceId,
        agentId: config.agentId,
        spaceId: config.spaceId,
        scope: config.scope,
        identityScope: config.identityScope,
        privacyScope: `space:${config.spaceId}`,
        privacyRevision: config.privacyRevision,
        publicLabels: config.publicLabels,
        personaSource: iris,
        providers: [{ provider: iris, hashScheme: "iris-canonical-v1" }],
        actors: () => structuredClone(config.actors),
        deadlineMs: config.deadlineMs,
        maxInputTokens: config.maxInputTokens,
        memoryTokenBudget: config.memoryTokenBudget,
        refreshIntervalMs: config.refreshIntervalMs,
        ...(config.observeOutput === undefined ? {} : { observeOutput: config.observeOutput }),
        ...(verifier === undefined
          ? {}
          : { historyRecovery: { ...config.historyRecovery, verifiers: [verifier] } }),
      },
    });
    void runtime.closed.then(() => verifier?.stop());
    return runtime;
  } catch {
    verifier?.stop();
    await iris.stop().catch(() => undefined);
    throw new Error("iris_runtime_start_failed");
  }
}

// Importable by the installed-service probe without launching another process.
if (
  process.argv[1] &&
  import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);
  if (
    args[0] !== "--config" ||
    (args.length !== 2 && !(args.length === 3 && args[2] === "--print-startup-token"))
  ) {
    process.stderr.write(
      "usage: pnpm start:iris --config /absolute/config.json [--print-startup-token]\n",
    );
    process.exitCode = 2;
  } else {
    try {
      const runtime = await startConfiguredIrisRuntime(args[1]);
      if (args[2] === "--print-startup-token" && runtime.status.ready)
        process.stdout.write(`startup-token ${runtime.issueStartupToken().token}\n`);
      let closing;
      const shutdown = () => {
        closing ??= runtime.close().catch(() => {
          process.stderr.write("iris-runtime: shutdown failed\n");
          process.exitCode = 1;
        });
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      process.stdout.write(
        `iris-runtime: ${runtime.status.phase} on loopback port ${runtime.status.port}\n`,
      );
    } catch {
      process.stderr.write("iris-runtime: configuration or startup failed\n");
      process.exitCode = 1;
    }
  }
}
