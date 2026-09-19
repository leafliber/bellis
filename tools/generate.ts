// Regenerates every derived file from contracts/src. With --check, compares instead of writing.
//   pnpm generate          write contracts/generated/* and docs/generated/*
//   pnpm generate --check  exit 1 if any generated file is stale
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { phaseBriefs } from "./lib/briefs.ts";
import { composeBundle } from "./lib/bundle.ts";
import {
  bundleText,
  registriesModule,
  typesModule,
  validatorDeclarations,
  validatorsModule,
} from "./lib/codegen.ts";
import { fakeDeviceFiles } from "./lib/fake-device.ts";
import { loadRegistry, ROOT } from "./lib/registry.ts";

const GENERATED_DIRS = ["contracts/generated", "docs/generated", "plugins/fake-device/generated"];

async function generatedFiles(): Promise<Map<string, string>> {
  const registry = loadRegistry();
  const bundle = composeBundle(registry);
  const files = new Map<string, string>([
    ["contracts/generated/bundle.schema.json", bundleText(bundle)],
    ["contracts/generated/types.ts", typesModule(bundle)],
    ["contracts/generated/registries.ts", registriesModule(registry, bundle)],
    ["contracts/generated/validators.d.mts", validatorDeclarations(bundle)],
    ["contracts/generated/validators.mjs", await validatorsModule(bundle)],
  ]);
  for (const [phase, text] of Object.entries(phaseBriefs(registry, bundle))) {
    files.set(`docs/generated/${phase}.md`, text);
  }
  for (const [path, content] of await fakeDeviceFiles(files, bundle)) files.set(path, content);
  return files;
}

/** Files present in the generated folders but no longer produced. */
function strayFiles(expected: Map<string, string>): string[] {
  return GENERATED_DIRS.flatMap((dir) =>
    existsSync(join(ROOT, dir)) ? readdirSync(join(ROOT, dir)).map((name) => `${dir}/${name}`) : [],
  ).filter((path) => !expected.has(path));
}

async function main() {
  const check = process.argv.includes("--check");
  const files = await generatedFiles();
  const stray = strayFiles(files);
  if (check) {
    const stale = [...files]
      .filter(([path, text]) => {
        const full = join(ROOT, path);
        return !existsSync(full) || readFileSync(full, "utf8") !== text;
      })
      .map(([path]) => path);
    if (stale.length || stray.length) {
      console.error(
        `Generated files are out of date; run \`pnpm generate\`:\n${[...stale, ...stray].join("\n")}`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`Checked ${files.size} generated files.`);
    return;
  }
  for (const [path, text] of files) {
    const full = join(ROOT, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  for (const path of stray) rmSync(join(ROOT, path));
  const removed = stray.length ? `, removed ${stray.length} stale` : "";
  console.log(`Generated ${files.size} files${removed} under ${GENERATED_DIRS.join(", ")}.`);
}

await main();
