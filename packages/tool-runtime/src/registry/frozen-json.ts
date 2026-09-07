import { JsonValueSchema } from "@bellis/contracts";

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Registered declarations and compiled calls must not change while waiting for approval. */
export function frozenJsonCopy<T>(value: T): T {
  const parsed = JsonValueSchema.parse(value);
  return freeze(JSON.parse(JSON.stringify(parsed)) as T);
}
