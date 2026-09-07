/** Conservative per-transaction pager budgets, including clean cached pages.
 * One confirmation fans out to all (at most eight) frozen Provider targets. */
export const COMPLETION_CACHE_BYTES = {
  binding: 512 * 1024,
  confirmation: 2 * 1024 ** 2,
  close: 512 * 1024,
} as const;
export type CompletionKind = keyof typeof COMPLETION_CACHE_BYTES;
export function completionCacheBytes(kind: CompletionKind, pageSize: number): number {
  return COMPLETION_CACHE_BYTES[kind] * Math.max(1, Math.ceil(pageSize / 4096));
}
export interface CompletionCounts {
  readonly bindings: number;
  readonly confirmations: number;
  readonly closes: number;
}
export interface CompletionOperation {
  readonly sceneId: string;
  readonly kind: CompletionKind;
}
export function transactionWalBytes(cacheBytes: number, pageSize: number): number {
  return cacheBytes + Math.ceil(cacheBytes / pageSize) * 24 + pageSize + 65536 + 32;
}
export function transactionAuxiliaryBytes(cacheBytes: number, pageSize: number): number {
  const frames = Math.ceil(cacheBytes / pageSize) + Math.ceil(65536 / (pageSize + 24)) + 1;
  // SQLite wal-index uses 32KiB regions for 4096 frames; the first region is
  // smaller. One extra region also covers an existing partial region.
  return 32768 * (Math.ceil(frames / 4096) + 1);
}
export function completionBudget(counts: CompletionCounts, pageSize: number) {
  const entries = [
    [counts.bindings, completionCacheBytes("binding", pageSize)],
    [counts.confirmations, completionCacheBytes("confirmation", pageSize)],
    [counts.closes, completionCacheBytes("close", pageSize)],
  ] as const;
  return {
    databaseBytes: entries.reduce((n, [count, bytes]) => n + count * bytes, 0),
    auxiliaryBytes: entries.reduce(
      (n, [count, bytes]) => n + count * transactionAuxiliaryBytes(bytes, pageSize),
      0,
    ),
    walBytes: entries.reduce(
      (n, [count, bytes]) => n + count * transactionWalBytes(bytes, pageSize),
      0,
    ),
  };
}
export const MAX_COMPLETION_COUNTS: CompletionCounts = {
  bindings: 128,
  confirmations: 128,
  closes: 4,
};
