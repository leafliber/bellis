import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Verify the same immutable package consumed by the configured Provider. */
export async function loadInstalledIrisSdk() {
  const providerDirectory = fileURLToPath(new URL("../providers/memory-iris/", import.meta.url));
  const provenance = JSON.parse(
    await readFile(resolve(providerDirectory, "vendor/iris-memory-sdk-0.11.2.json"), "utf8"),
  );
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  assert.equal(
    digest(await readFile(resolve(providerDirectory, "vendor", provenance.artifact))),
    provenance.sha256,
    "SDK archive differs from its frozen provenance",
  );
  const directory = await realpath(resolve(providerDirectory, "node_modules/@iris-memory/sdk"));
  for (const [file, expected] of Object.entries(provenance.files)) {
    assert.equal(digest(await readFile(resolve(directory, file))), expected, `SDK file: ${file}`);
  }
  const metadata = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8"));
  assert.equal(metadata.name, provenance.name);
  assert.equal(metadata.version, provenance.version);
  const require = createRequire(resolve(providerDirectory, "package.json"));
  const modulePath = require.resolve("@iris-memory/sdk");
  assert.equal(await realpath(modulePath), await realpath(resolve(directory, metadata.main)));
  const { AsyncIrisMemoryClient } = await import(pathToFileURL(modulePath).href);
  return { AsyncIrisMemoryClient, modulePath, metadata, provenance };
}
