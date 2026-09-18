import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { verifyInstallation } from "../packages/runtime/src/config.ts";
import { verifiedEndpointUrl } from "../packages/runtime/src/endpoint-loader.ts";
import { safeChildEnvironment, terminateChild } from "../packages/runtime/src/processes.ts";
import { createProductionFixture, endpointMaterials } from "./p0-endpoint.helpers.ts";
import { repository } from "./p0-identity.helpers.ts";

test("p0.loader: real launcher rejects replacement after successful preflight while private fd is still withheld", {
  timeout: 10000,
}, async () => {
  const fixture = await createProductionFixture();
  const { config } = await endpointMaterials(fixture);
  await verifyInstallation(fixture.config.installation);
  const child = spawn(process.execPath, [join(repository, "apps/host/endpoint-launcher.mjs")], {
    env: safeChildEnvironment(),
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  let output = "";
  let error = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    error += chunk.toString();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(child.exitCode, null);
    assert.equal(output, "");
    await writeFile(config.entry_artifact.path, 'process.stdout.write("REPLACEMENT_EXECUTED");\n');
    const fd = child.stdio[3];
    assert.ok(fd && "end" in fd);
    fd.end(JSON.stringify(config));
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    assert.equal(child.exitCode, 1);
    assert.equal(output, "");
    assert.equal(error, "ENDPOINT_STARTUP_REJECTED\n");
  } finally {
    await terminateChild(child);
    await fixture.cleanup();
  }
});

test("p0.loader module: production read/hash core executes its original bytes after path replacement", async () => {
  const fixture = await createProductionFixture();
  try {
    const path = join(fixture.directory, "buffer-fixture.mjs");
    const bytes = Buffer.from('export const observed = "original-verified-buffer";\n');
    await writeFile(path, bytes, { mode: 0o600 });
    const url = await verifiedEndpointUrl({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    await writeFile(path, 'export const observed = "replaced-path";\n');
    // Synthetic module evidence using the same core; not a device effect or SUT grant.
    assert.equal((await import(url)).observed, "original-verified-buffer");
    assert.match(await readFile(path, "utf8"), /replaced-path/);
    await assert.rejects(
      verifiedEndpointUrl({ path, sha256: createHash("sha256").update(bytes).digest("hex") }),
      /INSTALLATION_IDENTITY_DENIED/,
    );
  } finally {
    await fixture.cleanup();
  }
});
