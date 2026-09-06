import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  MemoryObserveEvent,
  MemoryUsageReport,
  PersonaSnapshot,
} from "@bellis/contracts/memory";

export type PendingDelivery =
  | {
      readonly id: string;
      readonly kind: "observe";
      readonly payload: readonly MemoryObserveEvent[];
      readonly createdAtMs: number;
      readonly attempts: number;
      readonly nextAttemptAtMs: number;
    }
  | {
      readonly id: string;
      readonly kind: "usage";
      readonly payload: MemoryUsageReport;
      readonly createdAtMs: number;
      readonly attempts: number;
      readonly nextAttemptAtMs: number;
    };

export interface AdapterPersistentState {
  readonly version: 1;
  readonly eventCursor?: string;
  readonly sourceCursors: Readonly<Record<string, string>>;
  readonly personaCache: Readonly<Record<string, PersonaSnapshot>>;
  readonly pending: readonly PendingDelivery[];
}

export interface AdapterStateStore {
  load(): Promise<AdapterPersistentState | undefined>;
  save(state: AdapterPersistentState): Promise<void>;
}

export class MemoryAdapterStateStore implements AdapterStateStore {
  #state: AdapterPersistentState | undefined;

  public async load(): Promise<AdapterPersistentState | undefined> {
    return this.#state;
  }

  public async save(state: AdapterPersistentState): Promise<void> {
    this.#state = structuredClone(state);
  }
}

interface EncryptedEnvelope {
  readonly version: 1;
  readonly algorithm: "aes-256-gcm";
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

/** Atomic, owner-only persistence for bounded retry metadata and verified persona cache. */
export class JsonAdapterStateStore implements AdapterStateStore {
  readonly #path: string;
  readonly #key: Buffer | undefined;

  public constructor(path: string, options: { encryptionKey?: Uint8Array } = {}) {
    this.#path = path;
    if (options.encryptionKey !== undefined && options.encryptionKey.byteLength !== 32) {
      throw new RangeError("encryptionKey must contain exactly 32 bytes");
    }
    this.#key =
      options.encryptionKey === undefined ? undefined : Buffer.from(options.encryptionKey);
  }

  public async load(): Promise<AdapterPersistentState | undefined> {
    let encoded: string;
    try {
      encoded = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const decoded: unknown = JSON.parse(encoded);
    if (this.#key === undefined) return decoded as AdapterPersistentState;
    const envelope = decoded as EncryptedEnvelope;
    if (envelope.algorithm !== "aes-256-gcm") throw new Error("unsupported state encryption");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8")) as AdapterPersistentState;
  }

  public async save(state: AdapterPersistentState): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const plaintext = JSON.stringify(state);
    let encoded = plaintext;
    if (this.#key !== undefined) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const envelope: EncryptedEnvelope = {
        version: 1,
        algorithm: "aes-256-gcm",
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };
      encoded = JSON.stringify(envelope);
    }
    const temporaryPath = `${this.#path}.${process.pid}.tmp`;
    await writeFile(temporaryPath, encoded, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.#path);
    await chmod(this.#path, 0o600);
  }
}
