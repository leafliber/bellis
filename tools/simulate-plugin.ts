// Bounded stdio NDJSON transport around SimulationEndpoint, for protocol tests only.
// One JSON-RPC object per line; stdout carries protocol only, diagnostics go to stderr.
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { type ControllerManifest, schemaDigest } from "../packages/contract-sdk/src/index.ts";
import { SimulationEndpoint } from "../packages/contract-sdk/src/simulation.ts";

const fixture: ControllerManifest = JSON.parse(
  readFileSync(new URL("../contracts/fixtures/plugin-manifest.json", import.meta.url), "utf8"),
);
// The fixture has no installation identity or enabled effects. Its zero digest is
// replaced with the exact generated bundle digest.
const endpoint = new SimulationEndpoint({ ...fixture, schema_digest: schemaDigest }, () =>
  performance.now(),
);
const limit = 16 * 1024 * 1024;
let pending = Buffer.alloc(0);
const send = async (wire: string) => {
  if (!process.stdout.write(`${wire}\n`)) await once(process.stdout, "drain");
};
try {
  for await (const chunk of process.stdin) {
    pending = Buffer.concat([pending, chunk as Buffer]);
    for (;;) {
      const newline = pending.indexOf(10);
      if (newline < 0) break;
      if (newline > limit) throw new Error("MESSAGE_TOO_LARGE");
      const line = new TextDecoder("utf-8", { fatal: true }).decode(pending.subarray(0, newline));
      pending = pending.subarray(newline + 1);
      await send(endpoint.exchange(line));
    }
    if (pending.length > limit) throw new Error("MESSAGE_TOO_LARGE");
  }
  if (pending.length) throw new Error("INCOMPLETE_FRAME");
} catch (error) {
  // No raw request bytes or secret values in the diagnostic channel.
  process.stderr.write(
    `Simulation transport stopped: ${error instanceof Error ? error.name : "Error"}\n`,
  );
  process.exitCode = 1;
}
