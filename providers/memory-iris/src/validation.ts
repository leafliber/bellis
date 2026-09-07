import type { MemoryObserveEvent } from "@bellis/contracts/memory";

export function safeInteger(value: number, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${field} must be a safe integer >= ${minimum}`);
  }
  return value;
}

export function decimalToSafeInteger(value: string, field: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new RangeError(`${field} must be decimal`);
  return safeInteger(Number(value), field);
}

/** Cross-field producer rules; legacy schema-1 records remain readable. */
export function validateObservation(event: MemoryObserveEvent): void {
  if (event.occurredAtMs > event.committedAtMs) throw new Error("observation time order");
  if ((event.sourceStream === undefined) !== (event.sourceCursor === undefined)) {
    throw new Error("source stream and cursor must be supplied together");
  }
  if (event.sourceCursor !== undefined && !/^(0|[1-9][0-9]{0,17})$/.test(event.sourceCursor)) {
    throw new RangeError("source cursor exceeds Core decimal range");
  }
  if (event.effectState === "partial") {
    const range = event.effectProof?.confirmed_range;
    if (
      range === undefined ||
      range === null ||
      typeof range !== "object" ||
      Object.keys(range).length === 0
    )
      throw new Error("partial observation requires effect_proof.confirmed_range");
  } else if (event.effectProof !== undefined) {
    throw new Error("committed observation must not carry effect_proof");
  }
}
