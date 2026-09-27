import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { assertValid, type P0TrustedFile } from "../../contract-sdk/src/index.ts";
import { reject } from "./errors.ts";
import { uid } from "./files.ts";

/** Opaque immutable URL is made from the single verified buffer, never a path to reread. */
export async function verifiedEndpointUrl(artifact: P0TrustedFile): Promise<string> {
  assertValid("P0TrustedFile", artifact);
  if (
    !isAbsolute(artifact.path) ||
    resolve(artifact.path) !== artifact.path ||
    (await realpath(artifact.path)) !== artifact.path
  )
    reject("INSTALLATION_IDENTITY_DENIED");
  const file = await open(artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.uid !== uid() ||
      (info.mode & 0o022) !== 0 ||
      info.size > 32 * 1024 * 1024
    )
      reject("INSTALLATION_IDENTITY_DENIED");
    const bytes = Buffer.alloc(info.size + 1);
    let size = 0;
    for (;;) {
      const result = await file.read(bytes, size, bytes.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
      if (size > info.size) reject("INSTALLATION_IDENTITY_DENIED");
    }
    const actual = bytes.subarray(0, size);
    if (size !== info.size || createHash("sha256").update(actual).digest("hex") !== artifact.sha256)
      reject("INSTALLATION_IDENTITY_DENIED");
    return `data:text/javascript;base64,${actual.toString("base64")}`;
  } finally {
    await file.close();
  }
}
