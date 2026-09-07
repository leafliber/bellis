import { z } from "zod";
import { PersistenceError } from "./errors.js";

const MiB = 1024 * 1024;
/** Admission-time free-space floor. Effects are bounded to four plans and 32
 * segments per plan; a worst-case physical allocation guarantee remains separate. */
export const MINIMUM_COMPLETION_HEADROOM_BYTES = 160 * MiB;
export const DISK_ADMISSION_WRITE_MARGIN_BYTES = 8 * MiB;
export interface PersistenceDiskAdmissionOptions {
  readonly highWaterBytes?: number;
  readonly stateMaxBytes?: number;
  readonly walHighWaterBytes?: number;
  readonly transactionCacheMaxBytes?: number;
  readonly telemetryMaxBytes?: number;
  readonly completionHeadroomBytes?: number;
}
export function diskAdmissionOptions(value: PersistenceDiskAdmissionOptions = {}) {
  const highWaterBytes = value.highWaterBytes ?? 512 * MiB;
  const transactionCacheMaxBytes = value.transactionCacheMaxBytes ?? 8 * MiB;
  const walHighWaterBytes = value.walHighWaterBytes ?? 64 * MiB;
  const stateMaxBytes = value.stateMaxBytes ?? 1024 * MiB;
  const telemetryMaxBytes = value.telemetryMaxBytes ?? 64 * MiB;
  const completionHeadroomBytes =
    value.completionHeadroomBytes ?? MINIMUM_COMPLETION_HEADROOM_BYTES;
  if (
    ![
      highWaterBytes,
      completionHeadroomBytes,
      stateMaxBytes,
      telemetryMaxBytes,
      walHighWaterBytes,
      transactionCacheMaxBytes,
    ].every(Number.isSafeInteger) ||
    [stateMaxBytes, telemetryMaxBytes, walHighWaterBytes].some(
      (bytes) => bytes < 16 * MiB || bytes > 1024 ** 4,
    ) ||
    transactionCacheMaxBytes < 4 * MiB ||
    transactionCacheMaxBytes > 64 * MiB ||
    highWaterBytes < 16 * MiB ||
    highWaterBytes > 1024 ** 4 ||
    completionHeadroomBytes < MINIMUM_COMPLETION_HEADROOM_BYTES ||
    completionHeadroomBytes > 1024 ** 4
  )
    throw new PersistenceError("invalid_request", "invalid persistence disk admission budget");
  return {
    highWaterBytes,
    completionHeadroomBytes,
    stateMaxBytes,
    telemetryMaxBytes,
    walHighWaterBytes,
    transactionCacheMaxBytes,
  };
}
const bytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const PersistenceDiskStatusSchema = z.strictObject({
  ready: z.boolean(),
  reason: z.enum(["ready", "high_water", "completion_headroom", "database_limit", "wal_pressure"]),
  databaseBytes: bytes,
  walBytes: bytes,
  walHighWaterBytes: bytes,
  transactionCacheMaxBytes: bytes,
  auxiliaryBytes: bytes,
  totalBytes: bytes,
  availableBytes: bytes,
  highWaterBytes: bytes,
  completionHeadroomBytes: bytes,
  admissionWriteMarginBytes: bytes,
  capacity: z
    .strictObject({
      stateLimitBytes: bytes,
      stateWalLimitBytes: bytes,
      stateAllocatedBytes: bytes,
      stateUsedBytes: bytes,
      stateReservedBytes: bytes,
      stateReservedWalBytes: bytes,
      stateReservedAuxiliaryBytes: bytes,
      activeCompletionReservations: bytes,
      telemetryLimitBytes: bytes,
      telemetryWalLimitBytes: bytes,
      telemetryAllocatedBytes: bytes,
      telemetryUsedBytes: bytes,
    })
    .optional(),
});
export type PersistenceDiskStatus = z.infer<typeof PersistenceDiskStatusSchema>;
