import { constants, createReadStream, type Stats } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  assertValid,
  type P0OperatorCredential,
  type P0PeerIdentity,
  parseJson,
} from "../../contract-sdk/src/index.ts";
import { reject } from "./errors.ts";

export function requireRuntimeVersion(): void {
  if (process.env.NODE_OPTIONS || process.env.NODE_PATH)
    throw new Error("NODE_LOAD_INJECTION_DENIED");
  if (process.versions.node !== "24.21.0") throw new Error("NODE_VERSION_REQUIRED_24_21_0");
}

export function uid(): number {
  if (!process.getuid) throw new Error("P0_LOCAL_USER_UNSUPPORTED");
  return process.getuid();
}

export async function secureDirectory(directory: string): Promise<void> {
  if (
    !isAbsolute(directory) ||
    resolve(directory) !== directory ||
    (await realpath(directory)) !== directory
  )
    reject("INSTALLATION_IDENTITY_DENIED");
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== uid() ||
    (info.mode & 0o777) !== 0o700
  )
    reject("INSTALLATION_IDENTITY_DENIED");
}

export async function controlledPath(
  path: string,
  directory: string,
  mustExist: boolean,
  socket = false,
): Promise<void> {
  await secureDirectory(directory);
  if (!isAbsolute(path) || resolve(path) !== path || dirname(path) !== directory)
    reject("INSTALLATION_IDENTITY_DENIED");
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !mustExist) return;
    throw error;
  }
  if (
    !mustExist ||
    info.isSymbolicLink() ||
    info.uid !== uid() ||
    (info.mode & 0o777) !== 0o600 ||
    (socket ? !info.isSocket() : !info.isFile())
  )
    reject("INSTALLATION_IDENTITY_DENIED");
}

export async function readControlled(path: string, maxBytes = 1_048_576): Promise<Buffer> {
  await controlledPath(path, dirname(path), true);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.uid !== uid() ||
      (info.mode & 0o777) !== 0o600 ||
      info.size > maxBytes
    )
      reject("INSTALLATION_IDENTITY_DENIED");
    return await file.readFile();
  } finally {
    await file.close();
  }
}

export function decodeJson(bytes: Buffer): unknown {
  return parseJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export async function readCredential(path: string): Promise<P0OperatorCredential> {
  const value = decodeJson(await readControlled(path));
  assertValid("P0OperatorCredential", value);
  return value;
}

export async function readServiceIdentity(socketPath: string): Promise<P0PeerIdentity> {
  await controlledPath(socketPath, dirname(socketPath), true, true);
  const value = decodeJson(await readControlled(`${socketPath}.identity.json`));
  assertValid("P0PeerIdentity", value);
  return value;
}

/** Only removes the inode this owner created, never a replacement at the same path. */
export class OwnedPaths {
  #paths = new Map<string, { dev: number; ino: number }>();
  async remember(path: string): Promise<void> {
    const s = await lstat(path);
    this.#paths.set(path, { dev: s.dev, ino: s.ino });
  }
  async matches(path: string): Promise<boolean> {
    const expected = this.#paths.get(path);
    try {
      const s = await lstat(path);
      return !!expected && s.dev === expected.dev && s.ino === expected.ino;
    } catch {
      return false;
    }
  }
  async writeIdentity(path: string, identity: P0PeerIdentity): Promise<void> {
    await controlledPath(path, dirname(path), false);
    const file = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(JSON.stringify(identity));
    } finally {
      await file.close();
    }
    await this.remember(path);
  }
  async cleanup(): Promise<void> {
    for (const path of this.#paths.keys())
      if (await this.matches(path)) await unlink(path).catch(() => {});
    this.#paths.clear();
  }
}

export async function readPrivateBootstrap(fd = 3, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  const stream = createReadStream("", { fd, autoClose: true });
  const abort = () => stream.destroy(new Error("BOOTSTRAP_CANCELLED"));
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => stream.destroy(new Error("BOOTSTRAP_TIMEOUT")), 5000);
  try {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const raw of stream) {
      const chunk = Buffer.from(raw);
      size += chunk.length;
      if (size > 16 * 1024 * 1024) throw new Error("BOOTSTRAP_LIMIT");
      chunks.push(chunk);
    }
    return decodeJson(Buffer.concat(chunks));
  } finally {
    signal?.removeEventListener("abort", abort);
    clearTimeout(timer);
    stream.destroy();
  }
}
