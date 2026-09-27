import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { build } from "esbuild";
import { parseJson } from "../../packages/contract-sdk/src/json.ts";
import { schemaDigest } from "./codegen.ts";
import { ROOT, type SchemaDocument } from "./registry.ts";

export const fakeDeviceBuiltins = new Set([
  "node:crypto",
  "node:events",
  "node:fs",
  "node:fs/promises",
  "node:net",
  "node:path",
]);
const prefix = "contracts/generated/";

/** Every generated dependency comes from this invocation's Map, even on an empty generated directory. */
export async function fakeDeviceFiles(
  files: ReadonlyMap<string, string>,
  bundle: SchemaDocument,
): Promise<Map<string, string>> {
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: ["plugins/fake-device/main.ts"],
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "node",
    target: "node24",
    splitting: false,
    legalComments: "none",
    charset: "utf8",
    minifyWhitespace: true,
    logLevel: "silent",
    logOverride: {
      "unsupported-dynamic-import": "error",
      "unsupported-require-call": "error",
      "indirect-require": "error",
      "direct-eval": "error",
    },
    plugins: [
      {
        name: "current-contracts",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) => {
            const path = relative(ROOT, resolve(args.resolveDir || ROOT, args.path)).replaceAll(
              "\\",
              "/",
            );
            if (!path.startsWith(prefix)) return;
            if (!files.has(path)) throw new Error(`CURRENT_GENERATION_MISSING:${path}`);
            return { path, namespace: "current-contracts" };
          });
          builder.onLoad({ filter: /.*/, namespace: "current-contracts" }, (args) => {
            const path = args.path;
            const contents = files.get(path);
            if (contents === undefined) throw new Error(`CURRENT_GENERATION_MISSING:${path}`);
            return {
              contents,
              resolveDir: dirname(join(ROOT, args.path)),
              loader: path.endsWith(".ts") ? "ts" : path.endsWith(".json") ? "json" : "js",
            };
          });
        },
      },
    ],
  });
  if (result.warnings.length || result.outputFiles.length !== 1)
    throw new Error("FAKE_DEVICE_SINGLE_ESM_REQUIRED");
  for (const input of Object.values(result.metafile.inputs))
    for (const dependency of input.imports)
      if (
        ["dynamic-import", "require-call", "require-resolve"].includes(dependency.kind) ||
        (dependency.external && !fakeDeviceBuiltins.has(dependency.path))
      )
        throw new Error(`FAKE_DEVICE_IMPORT_DENIED:${dependency.path}`);
  for (const output of Object.values(result.metafile.outputs))
    for (const dependency of output.imports)
      if (
        !dependency.external ||
        dependency.kind !== "import-statement" ||
        !fakeDeviceBuiltins.has(dependency.path)
      )
        throw new Error("FAKE_DEVICE_OUTPUT_IMPORT_DENIED");
  const source = parseJson(
    readFileSync(join(ROOT, "plugins/fake-device/manifest.source.json"), "utf8"),
  );
  if (!source || typeof source !== "object" || Array.isArray(source) || "schema_digest" in source)
    throw new Error("FAKE_DEVICE_MANIFEST_SOURCE_INVALID");
  const manifest = { ...source, schema_digest: schemaDigest(bundle) };
  const output = result.outputFiles[0];
  if (!output) throw new Error("FAKE_DEVICE_OUTPUT_MISSING");
  return new Map([
    ["plugins/fake-device/generated/endpoint.mjs", output.text],
    ["plugins/fake-device/generated/manifest.json", `${JSON.stringify(manifest, null, 2)}\n`],
  ]);
}
