/** Preserve Python JSON numeric spellings before the SDK's JSON.parse loses 1.0/-0.0. */
class WireNumber {
  constructor(readonly source: string) {}
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (char) => char.codePointAt(0)!);
  const b = Array.from(right, (char) => char.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

function canonical(value: unknown): string {
  if (value instanceof WireNumber) return value.source;
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .toSorted(compareCodePoints)
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function personaCanonicalFromWire(text: string): string {
  const wire = JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value !== "number") return value;
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new RangeError("persona number exceeds the lossless JSON range");
    }
    if (context?.source === undefined) throw new Error("JSON parse source context is required");
    return new WireNumber(context.source);
  }) as { revision: { core: unknown; traits: unknown; narrative: unknown } };
  return canonical({
    canonical_json_version: 1,
    content: {
      core: wire.revision.core,
      traits: wire.revision.traits,
      narrative: wire.revision.narrative,
    },
  });
}
