import {
  MemoryResourceInvalidationSchema,
  MemoryHistoryGapSchema,
  type MemoryHistoryGap,
  type MemoryResourceInvalidation,
} from "@bellis/contracts";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  MemoryObserveEvent,
  MemoryUsageReport,
  PersonaSnapshot,
} from "@bellis/contracts/memory";
import {
  PersonaSnapshotSchema,
  MemoryObserveEventSchema,
  MemoryUsageReportSchema,
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
  /** Retained after host ACK until explicit public revalidation resolves it. */
  readonly historyGap?: MemoryHistoryGap;
  readonly pendingResourceInvalidation?: MemoryResourceInvalidation;
  readonly legacyInvalidated?: boolean;
  readonly eventCursor?: string;
  /** Identity of the event at eventCursor; absent only in legacy state. */
  readonly eventId?: string;
  readonly sourceCursors: Readonly<Record<string, string>>;
  readonly personaCache: Readonly<Record<string, PersonaSnapshot>>;
  readonly pending: readonly PendingDelivery[];
  /** A pending invalidation forbids every offline fallback until a fresh read resolves it. */
  readonly personaBarriers?: Readonly<Record<string, PersonaReadBarrier>>;
}

export interface PersonaReadBarrier {
  readonly minimumRevision: string;
  readonly verifiedRevision?: string;
  readonly verifiedContentHash?: string;
  readonly reason: "invalidated" | "revised" | "recall-mismatch" | "revoked";
  readonly cursor?: string;
}

export interface AdapterStateStore {
  load(): Promise<AdapterPersistentState | undefined>;
  save(state: AdapterPersistentState): Promise<void>;
}

/** Validate recovery metadata before allowing its cache or cursor to participate in reads. */
const invalid = () => new Error("invalid Iris adapter recovery state");

export function parseAdapterState(value: unknown): AdapterPersistentState {
  const record = (item: unknown): Record<string, unknown> => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw invalid();
    return item as Record<string, unknown>;
  };
  const decimal = (item: unknown) => {
    if (typeof item !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(item)) throw invalid();
  };
  const state = record(value);
  if (state.version !== 1) throw invalid();
  if (state.legacyInvalidated !== undefined && typeof state.legacyInvalidated !== "boolean")
    throw invalid();
  if (state.pendingResourceInvalidation !== undefined)
    MemoryResourceInvalidationSchema.parse(state.pendingResourceInvalidation);
  if (state.eventCursor !== undefined) decimal(state.eventCursor);
  if (state.eventId !== undefined) {
    if (
      typeof state.eventId !== "string" ||
      !/^[!-~]{1,512}$/.test(state.eventId) ||
      typeof state.eventCursor !== "string" ||
      !/^[1-9][0-9]{0,18}$/.test(state.eventCursor) ||
      BigInt(state.eventCursor) > 9223372036854775807n
    )
      throw invalid();
  }
  if (state.historyGap !== undefined) {
    const gap = MemoryHistoryGapSchema.parse(state.historyGap);
    if (
      gap.providerId !== "iris" ||
      gap.cursor !== (state.eventCursor ?? "0") ||
      gap.eventId !== state.eventId
    )
      throw invalid();
  }
  for (const cursor of Object.values(record(state.sourceCursors))) decimal(cursor);
  for (const [agentId, snapshot] of Object.entries(record(state.personaCache))) {
    if (PersonaSnapshotSchema.parse(snapshot).agentId !== agentId) throw invalid();
  }
  for (const barrier of Object.values(record(state.personaBarriers ?? {}))) {
    const item = record(barrier);
    decimal(item.minimumRevision);
    if (!["invalidated", "revised", "recall-mismatch", "revoked"].includes(String(item.reason)))
      throw invalid();
    if (item.cursor !== undefined) decimal(item.cursor);
    if (item.verifiedRevision !== undefined || item.verifiedContentHash !== undefined) {
      decimal(item.verifiedRevision);
      if (
        typeof item.verifiedContentHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(item.verifiedContentHash)
      )
        throw invalid();
    }
  }
  if (!Array.isArray(state.pending)) throw invalid();
  for (const pending of state.pending) {
    const item = record(pending);
    if (typeof item.id !== "string" || item.id.length === 0) throw invalid();
    for (const key of ["createdAtMs", "attempts", "nextAttemptAtMs"]) {
      if (typeof item[key] !== "number" || !Number.isSafeInteger(item[key]) || item[key] < 0)
        throw invalid();
    }
    if (item.kind === "usage") MemoryUsageReportSchema.parse(item.payload);
    else if (item.kind === "observe" && Array.isArray(item.payload)) {
      for (const event of item.payload) MemoryObserveEventSchema.parse(event);
    } else throw invalid();
  }
  return structuredClone(value) as AdapterPersistentState;
}

export class MemoryAdapterStateStore implements AdapterStateStore {
  #state: AdapterPersistentState | undefined;

  public async load(): Promise<AdapterPersistentState | undefined> {
    return this.#state === undefined ? undefined : structuredClone(this.#state);
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
