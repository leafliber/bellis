import { transactionWalBytes, transactionAuxiliaryBytes } from "../completion-budget.js";
import { statSync, statfsSync } from "node:fs";
import { join } from "node:path";
import {
  diskAdmissionOptions,
  DISK_ADMISSION_WRITE_MARGIN_BYTES,
  type PersistenceDiskAdmissionOptions,
  type PersistenceDiskStatus,
} from "../disk-admission.js";
import { PersistenceError } from "../errors.js";

/** The DB Worker is the only writer and invokes this inside new fact transactions.
 * Include WAL and both databases: delivered rows and old manifests still consume disk. */
export class DiskAdmission {
  readonly #directory: string;
  readonly #capacity: (() => NonNullable<PersistenceDiskStatus["capacity"]>) | undefined;
  readonly #options: ReturnType<typeof diskAdmissionOptions>;
  constructor(
    directory: string,
    options?: PersistenceDiskAdmissionOptions,
    capacity?: () => NonNullable<PersistenceDiskStatus["capacity"]>,
  ) {
    this.#capacity = capacity;
    this.#directory = directory;
    this.#options = diskAdmissionOptions(options);
  }
  read(): PersistenceDiskStatus {
    const size = (name: string, required = false): number => {
      try {
        return statSync(join(this.#directory, name)).size;
      } catch (error) {
        if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw new PersistenceError("storage_not_ready", "persistence disk state unavailable");
      }
    };
    const capacity = this.#capacity?.();
    const stateDatabaseBytes = size("state.db", true),
      telemetryDatabaseBytes = size("telemetry.db", true);
    const databaseBytes = stateDatabaseBytes + telemetryDatabaseBytes;
    const stateWalBytes = size("state.db-wal"),
      telemetryWalBytes = size("telemetry.db-wal");
    const walBytes = stateWalBytes + telemetryWalBytes;
    const auxiliaryBytes =
      size("state.db-shm") +
      size("telemetry.db-shm") +
      size("worker-lock.db", true) +
      size("worker-lock.db-journal");
    const totalBytes = databaseBytes + walBytes + auxiliaryBytes;
    let availableBytes: number;
    try {
      const fs = statfsSync(this.#directory, { bigint: true });
      const available = fs.bavail * fs.bsize;
      availableBytes = Number(
        available > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : available,
      );
    } catch {
      throw new PersistenceError("storage_not_ready", "persistence disk state unavailable");
    }
    if (!Number.isSafeInteger(totalBytes) || availableBytes < 0)
      throw new PersistenceError("storage_not_ready", "persistence disk state unavailable");
    const { highWaterBytes, completionHeadroomBytes, walHighWaterBytes, transactionCacheMaxBytes } =
      this.#options;
    const held = capacity?.activeCompletionReservations
      ? capacity.stateReservedBytes +
        capacity.stateReservedWalBytes +
        capacity.stateReservedAuxiliaryBytes +
        Math.max(0, capacity.stateAllocatedBytes - stateDatabaseBytes) +
        Math.max(0, capacity.telemetryAllocatedBytes - telemetryDatabaseBytes) +
        transactionCacheMaxBytes +
        transactionWalBytes(transactionCacheMaxBytes, 512) +
        transactionAuxiliaryBytes(transactionCacheMaxBytes, 512) +
        1024 ** 2
      : 0;
    const reason =
      Math.max(stateWalBytes, telemetryWalBytes) >= walHighWaterBytes
        ? "wal_pressure"
        : capacity &&
            (capacity.stateLimitBytes - capacity.stateUsedBytes - capacity.stateReservedBytes <
              (capacity.activeCompletionReservations
                ? Math.max(DISK_ADMISSION_WRITE_MARGIN_BYTES, transactionCacheMaxBytes)
                : DISK_ADMISSION_WRITE_MARGIN_BYTES) ||
              capacity.telemetryLimitBytes - capacity.telemetryUsedBytes <
                DISK_ADMISSION_WRITE_MARGIN_BYTES)
          ? "database_limit"
          : totalBytes + DISK_ADMISSION_WRITE_MARGIN_BYTES > highWaterBytes
            ? "high_water"
            : availableBytes <
                Math.max(completionHeadroomBytes + DISK_ADMISSION_WRITE_MARGIN_BYTES, held)
              ? "completion_headroom"
              : "ready";
    return {
      ...(capacity === undefined ? {} : { capacity }),
      ready: reason === "ready",
      reason,
      databaseBytes,
      walBytes,
      walHighWaterBytes,
      transactionCacheMaxBytes,
      auxiliaryBytes,
      totalBytes,
      availableBytes,
      highWaterBytes,
      completionHeadroomBytes,
      admissionWriteMarginBytes: DISK_ADMISSION_WRITE_MARGIN_BYTES,
    };
  }
  assertNewWork = (): void => {
    if (!this.read().ready)
      throw new PersistenceError("storage_not_ready", "persistence disk admission unavailable");
  };
}
