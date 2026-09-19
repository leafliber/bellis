// Local report files only. Descriptor checks narrow races but do not make parent
// directory replacement by another process with the same permissions impossible.
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { SchemaTypes } from "../../packages/contract-sdk/src/index.ts";
import { rootPath, sha256 } from "../lib/build-manifest.ts";
import { ROOT } from "../lib/registry.ts";

function evidencePath(path: string, root: string): string {
  if (
    !path.startsWith("reports/") ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Evidence path must be canonical and under reports; path escapes reports");
  if (realpathSync(root) !== resolve(root)) throw new Error("Evidence root must be canonical");
  return rootPath(root, path);
}

function checkParents(full: string, root: string, create = false): void {
  let parent = resolve(root);
  for (const name of relative(parent, dirname(full)).split(sep)) {
    parent = join(parent, name);
    if (create && !existsSync(parent)) mkdirSync(parent, { mode: 0o700 });
    if (!lstatSync(parent).isDirectory() || realpathSync(parent) !== parent)
      throw new Error("evidence symlink escape or non-directory parent");
  }
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && b.isFile();
}

function checkOpenedPath(full: string, root: string, opened: Stats): void {
  checkParents(full, root);
  const current = lstatSync(full);
  if (current.isSymbolicLink() || realpathSync(full) !== full || !sameFile(opened, current))
    throw new Error("evidence path changed or symlink escape");
}

export function artifactBytes(artifact: SchemaTypes["EvidenceArtifact"], root = ROOT): Buffer {
  const full = evidencePath(artifact.path, root);
  checkParents(full, root);
  if (lstatSync(full).isSymbolicLink()) throw new Error("evidence symlink escape");
  const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > 64 * 1024 * 1024)
      throw new Error("invalid evidence size/type");
    checkOpenedPath(full, root, before);
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error("evidence truncated during read");
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, offset)) throw new Error("evidence grew during read");
    const after = fstatSync(fd);
    if (
      !sameFile(before, after) ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("evidence changed during read");
    checkOpenedPath(full, root, after);
    if (sha256(bytes) !== artifact.sha256) throw new Error("evidence hash mismatch");
    return bytes;
  } finally {
    closeSync(fd);
  }
}

export function writeArtifact(
  path: string,
  bytes: string | Buffer,
  root = ROOT,
): SchemaTypes["EvidenceArtifact"] {
  const full = evidencePath(path, root);
  checkParents(full, root, true);
  const fd = openSync(
    full,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const before = fstatSync(fd);
    checkOpenedPath(full, root, before);
    writeFileSync(fd, bytes);
    const after = fstatSync(fd);
    if (!sameFile(before, after) || after.size !== Buffer.byteLength(bytes))
      throw new Error("evidence write incomplete");
    checkOpenedPath(full, root, after);
    return { path, sha256: sha256(bytes) };
  } finally {
    closeSync(fd);
  }
}
