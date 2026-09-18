/** Strict protocol parser. JSON.parse alone silently accepts duplicate object keys. */
export function parseJson(source: string): unknown {
  if (Buffer.byteLength(source, "utf8") > 16 * 1024 * 1024) throw new Error("JSON_TOO_LARGE");
  let at = 0;
  const space = () => {
    while (/[\t\n\r ]/.test(source[at] ?? "x")) at++;
  };
  const fail = (): never => {
    throw new Error(`JSON_INVALID at ${at}`);
  };
  const string = (): string => {
    const start = at++;
    while (at < source.length) {
      const c = source[at++];
      if (c === "\\") at++;
      else if (c === '"') {
        const value: string = JSON.parse(source.slice(start, at));
        for (const point of value) {
          const code = point.codePointAt(0) ?? 0;
          if (code >= 0xd800 && code <= 0xdfff) fail();
        }
        return value;
      }
    }
    return fail();
  };
  const value = (depth: number): void => {
    if (depth > 64) throw new Error("JSON_TOO_DEEP");
    space();
    const c = source[at];
    if (c === '"') {
      string();
    } else if (c === "{" || c === "[") {
      const object = c === "{";
      const end = object ? "}" : "]";
      const keys = new Set<string>();
      at++;
      space();
      if (source[at] === end) {
        at++;
        return;
      }
      for (;;) {
        space();
        if (object) {
          if (source[at] !== '"') fail();
          const key = string();
          if (keys.has(key)) throw new Error("JSON_DUPLICATE_KEY");
          keys.add(key);
          space();
          if (source[at++] !== ":") fail();
        }
        value(depth + 1);
        space();
        if (source[at] === end) {
          at++;
          break;
        }
        if (source[at++] !== ",") fail();
      }
    } else {
      const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
        source.slice(at),
      );
      if (!token) fail();
      const raw = token?.[0] ?? "";
      if (/^-?\d/.test(raw) && !Number.isFinite(Number(raw))) fail();
      at += raw.length;
    }
  };
  value(0);
  space();
  if (at !== source.length) fail();
  return JSON.parse(source);
}
