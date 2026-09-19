// Conservative P0 input inventories. Reports, credentials, installation metadata and
// native build intermediates are not inputs; installed package code and .node files are.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { release } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import {
  assertValid,
  payloadDigest,
  type SchemaTypes,
} from "../../packages/contract-sdk/src/index.ts";
import { ROOT } from "./registry.ts";

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export const COVERAGE_ROOTS = [
  "apps",
  "packages",
  "plugins",
  "tools",
  "tests",
  "contracts/src",
  "contracts/generated",
  "contracts/fixtures",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".node-version",
  "tsconfig.json",
  "biome.json",
  ".npmrc",
  "node_modules",
].sort();
const INSTALL_METADATA = new Set([
  ".bin",
  ".modules.yaml",
  ".package-map.json",
  ".pnpm-workspace-state-v1.json",
]);
const INTERMEDIATES = new Set(["obj", "obj.target", ".cache", "config.gypi", "Makefile"]);
const CODE_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".cts",
  ".jsx",
  ".tsx",
  ".wasm",
  ".node",
]);
const AMBIGUOUS_CONFIG_EXTENSIONS = new Set([".json", ".jsonc", ".yaml", ".yml", ".toml"]);

export function rootPath(root: string, path: string): string {
  const full = resolve(root, path);
  if (!full.startsWith(resolve(root) + sep)) throw new Error(`Path escapes root: ${path}`);
  return full;
}

export function sourceDigest(root = ROOT): string {
  const digest = createHash("sha256");
  for (const name of readdirSync(join(root, "contracts/src"))
    .filter((f) => f.endsWith(".json"))
    .sort()) {
    digest
      .update(`${name}\0`)
      .update(readFileSync(join(root, "contracts/src", name)))
      .update("\0");
  }
  return digest.digest("hex");
}

export function buildManifest(kind: "sut" | "runner", root = ROOT): SchemaTypes["P0BuildManifest"] {
  const files: SchemaTypes["P0BuildFile"][] = [];
  const packageRoots: string[] = [];
  const visited = new Set<string>();
  const add = (path: string) => {
    if (visited.has(path)) return;
    visited.add(path);
    const full = rootPath(root, path);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) {
      const target = relative(resolve(root), realpathSync(full)).split(sep).join("/");
      rootPath(root, target);
      if (
        !path.startsWith("node_modules/") ||
        !["node_modules", "apps", "packages", "plugins"].some((base) =>
          target.startsWith(`${base}/`),
        )
      ) {
        throw new Error(`Source symlink is outside the dependency inventory: ${path}`);
      }
      files.push({
        path,
        kind: "symlink",
        symlink_target: target,
        sha256: sha256(target),
        size_bytes: Buffer.byteLength(target),
      });
      add(target);
    } else if (stat.isDirectory()) {
      for (const name of readdirSync(full).sort()) {
        if (name === ".DS_Store" || name === ".git" || name === ".env") continue;
        if (name.startsWith(".env.")) {
          // Runtime secrets stay excluded. A code-like name cannot hide a source
          // dependency; reject ambiguous directories rather than hiding their tree.
          const info = lstatSync(join(full, name));
          if (
            info.isDirectory() ||
            info.isSymbolicLink() ||
            AMBIGUOUS_CONFIG_EXTENSIONS.has(extname(name))
          )
            throw new Error(
              `Ambiguous .env configuration/directory/link in build inputs: ${path}/${name}`,
            );
          if (!CODE_EXTENSIONS.has(extname(name))) continue;
        }
        if (
          path.startsWith("node_modules") &&
          (INSTALL_METADATA.has(name) ||
            INTERMEDIATES.has(name) ||
            name.endsWith(".o") ||
            name.endsWith(".target.mk") ||
            (path === "node_modules/.pnpm" && name === "lock.yaml"))
        )
          continue;
        add(`${path}/${name}`);
      }
    } else if (stat.isFile()) {
      const bytes = readFileSync(full);
      files.push({
        path,
        kind: "file",
        symlink_target: null,
        sha256: sha256(bytes),
        size_bytes: bytes.length,
      });
      if (/(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(path))
        packageRoots.push(path.slice(0, -"/package.json".length));
    } else throw new Error(`Unsupported build input: ${path}`);
  };
  for (const path of ["package.json", "pnpm-lock.yaml", ".node-version", "node_modules"]) {
    if (!existsSync(join(root, path))) throw new Error(`Required build input missing: ${path}`);
  }
  for (const path of COVERAGE_ROOTS) if (existsSync(join(root, path))) add(path);
  files.sort((a, b) => a.path.localeCompare(b.path, "en"));
  const dependencies = packageRoots
    .sort()
    .map((path) => {
      const pkg = JSON.parse(readFileSync(join(root, path, "package.json"), "utf8")) as {
        name: string;
        version: string;
      };
      if (!pkg.name || !pkg.version) throw new Error(`Dependency identity missing: ${path}`);
      const contents = files
        .filter((f) => f.path.startsWith(`${path}/`))
        .map((f) => ({ ...f, path: f.path.slice(path.length + 1) }));
      return {
        name: pkg.name,
        version: pkg.version,
        package_digest: sha256(readFileSync(join(root, path, "package.json"))),
        artifact_digest: payloadDigest(contents),
      };
    })
    .sort((a, b) =>
      `${a.name}\0${a.version}\0${a.artifact_digest}`.localeCompare(
        `${b.name}\0${b.version}\0${b.artifact_digest}`,
        "en",
      ),
    );
  const body = {
    artifact_type: "p0-build-manifest" as const,
    kind,
    coverage_roots: COVERAGE_ROOTS,
    files,
    dependencies,
  };
  const manifest = { ...body, digest: payloadDigest(body) };
  assertValid("P0BuildManifest", manifest);
  return manifest;
}

export function executionEnvironment(
  dependencies: SchemaTypes["P0DependencyIdentity"][],
  root = ROOT,
): SchemaTypes["P0ExecutionEnvironment"] {
  const expectedNode = readFileSync(join(root, ".node-version"), "utf8").trim();
  if (process.versions.node !== expectedNode)
    throw new Error(`Expected Node ${expectedNode}, got ${process.versions.node}`);
  if (process.env.NODE_OPTIONS || process.env.NODE_PATH)
    throw new Error("Acceptance forbids unbound NODE_OPTIONS/NODE_PATH");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    packageManager: string;
  };
  const expectedPnpm = pkg.packageManager.replace(/^pnpm@/, "");
  const check = spawnSync("pnpm", ["--version"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      PATH: `${dirname(process.execPath)}${sep === "/" ? ":" : ";"}${process.env.PATH ?? ""}`,
    },
  });
  if (check.status !== 0 || check.stdout.trim() !== expectedPnpm)
    throw new Error("Actual pnpm version does not match packageManager");
  const result = {
    node_version: process.versions.node,
    node_executable_sha256: sha256(readFileSync(process.execPath)),
    pnpm_version: check.stdout.trim(),
    platform: process.platform,
    arch: process.arch,
    os_release: release(),
    dependencies,
  };
  assertValid("P0ExecutionEnvironment", result);
  return result;
}
