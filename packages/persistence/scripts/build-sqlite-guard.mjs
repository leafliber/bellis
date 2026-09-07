import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "dist", "native");
const suffix =
  process.platform === "win32" ? ".dll" : process.platform === "darwin" ? ".dylib" : ".so";
const binary = join(output, `bellisguard${suffix}`);
const metadata = join(output, "build.json");
const pendingBinary = join(output, `bellisguard-build-${process.pid}${suffix}`);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const sources = [
  "native/sqlite-guard.c",
  "native/sqlite/sqlite3.h",
  "native/sqlite/sqlite3ext.h",
  "scripts/build-sqlite-guard.mjs",
];
const signature = sha(
  JSON.stringify({
    platform: process.platform,
    arch: process.arch,
    sources: sources.map((file) => sha(readFileSync(join(root, file)))),
  }),
);
if (existsSync(binary) && existsSync(metadata)) {
  const previous = JSON.parse(readFileSync(metadata, "utf8"));
  if (previous.signature === signature && previous.binarySha256 === sha(readFileSync(binary)))
    process.exit(0);
}
mkdirSync(output, { recursive: true });
let compiler, args;
if (process.platform === "win32") {
  compiler = "cl.exe";
  args = [
    "/nologo",
    "/LD",
    "/O2",
    "/W4",
    "/WX",
    "/TC",
    "native/sqlite-guard.c",
    `/Fo${join(output, "sqlite-guard.obj")}`,
    "/link",
    `/OUT:${pendingBinary}`,
  ];
} else {
  compiler = "cc";
  args = [
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-fPIC",
    process.platform === "darwin" ? "-dynamiclib" : "-shared",
    "native/sqlite-guard.c",
    "-o",
    pendingBinary,
  ];
}
const result = spawnSync(compiler, args, { cwd: root, stdio: "inherit" });
if (result.error || result.status !== 0) {
  throw new Error(
    `SQLite capacity guard build failed. Install a C compiler${process.platform === "win32" ? " and run in a Visual Studio Developer shell" : ""}.`,
    { cause: result.error },
  );
}
renameSync(pendingBinary, binary);
writeFileSync(
  metadata,
  JSON.stringify(
    {
      signature,
      platform: process.platform,
      arch: process.arch,
      binarySha256: sha(readFileSync(binary)),
    },
    null,
    2,
  ) + "\n",
);
console.log(`Built SQLite capacity guard: ${resolve(binary)}`);
