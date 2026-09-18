import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { safeChildEnvironment } from "../packages/runtime/src/processes.ts";
import { composeBundle } from "../tools/lib/bundle.ts";
import { schemaDigest } from "../tools/lib/codegen.ts";
import { fakeDeviceFiles } from "../tools/lib/fake-device.ts";
import { loadRegistry, ROOT } from "../tools/lib/registry.ts";

function generate(
  directory: string,
  check = false,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(directory, "tools/generate.ts"), ...(check ? ["--check"] : [])],
      { cwd: directory, env: safeChildEnvironment(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 100000) child.kill("SIGKILL");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

test("p0.generation: empty generated directories, current-memory contracts, deterministic ESM and actual drift rejection", {
  timeout: 30000,
}, async () => {
  const directory = await mkdtemp("/private/tmp/bp0-generation-");
  try {
    // Explicit copy list: no reports, runtime credentials, future designs, branches or worktrees.
    for (const path of [
      "package.json",
      "tools/generate.ts",
      "tools/lib",
      "contracts/src",
      "packages/contract-sdk/src",
      "packages/runtime/src",
      "plugins/fake-device/main.ts",
      "plugins/fake-device/model.ts",
      "plugins/fake-device/protocol.ts",
      "plugins/fake-device/manifest.source.json",
    ]) {
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await cp(join(ROOT, path), join(directory, path), { recursive: true });
    }
    await symlink(join(ROOT, "node_modules"), join(directory, "node_modules"), "dir");
    const first = await generate(directory);
    assert.equal(first.code, 0, first.output);
    const generated = "plugins/fake-device/generated/endpoint.mjs";
    const text = await readFile(join(directory, generated), "utf8");
    assert.equal(
      text.includes(directory),
      false,
      text
        .split("\n")
        .filter((line) => line.includes(directory))
        .join("\n"),
    );
    const rootIndex = text.indexOf(ROOT);
    assert.equal(
      rootIndex,
      -1,
      text.slice(Math.max(0, rootIndex - 100), rootIndex + ROOT.length + 150),
    );
    assert.equal(text, await readFile(join(ROOT, generated), "utf8"));
    for (const path of [
      "contracts/generated/bundle.schema.json",
      "contracts/generated/types.ts",
      "contracts/generated/registries.ts",
      "contracts/generated/validators.d.mts",
      "contracts/generated/validators.mjs",
      "docs/generated/P0.md",
      "docs/generated/P1.md",
      "plugins/fake-device/generated/manifest.json",
    ]) {
      assert.equal(
        await readFile(join(directory, path), "utf8"),
        await readFile(join(ROOT, path), "utf8"),
        path,
      );
    }
    const clean = await generate(directory, true);
    assert.equal(clean.code, 0, clean.output);
    await writeFile(join(directory, generated), `${text}\n// deliberate isolated drift\n`);
    const drift = await generate(directory, true);
    assert.equal(drift.code, 1);
    assert.match(drift.output, /endpoint\.mjs/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const files = new Map<string, string>();
  for (const path of ["registries.ts", "validators.mjs", "types.ts"])
    files.set(
      `contracts/generated/${path}`,
      await readFile(join(ROOT, "contracts/generated", path), "utf8"),
    );
  const bundle = composeBundle(loadRegistry());
  const changed = structuredClone(bundle);
  changed.title = "Current in-memory test bundle";
  const currentDigest = schemaDigest(changed);
  const registryText = files.get("contracts/generated/registries.ts");
  assert.ok(registryText);
  files.set(
    "contracts/generated/registries.ts",
    registryText.replace(schemaDigest(bundle), currentDigest),
  );
  const output = await fakeDeviceFiles(files, changed);
  assert.equal(
    JSON.parse(output.get("plugins/fake-device/generated/manifest.json") ?? "null").schema_digest,
    currentDigest,
  );
  assert.ok(output.get("plugins/fake-device/generated/endpoint.mjs")?.includes(currentDigest));
  files.delete("contracts/generated/validators.mjs");
  await assert.rejects(fakeDeviceFiles(files, changed), /CURRENT_GENERATION_MISSING/);
});
