import { personaCanonicalFromWire } from "./persona-canonical.js";

/** Public SDK fetch seam: classify HTTP failures before successful DTO validation. */
export class IrisBoundaryError extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    public readonly reasonCode?: string,
  ) {
    // Never include remote error bodies, credentials or memory text in logs.
    super(`Iris request rejected: ${code}`);
    this.name = "IrisBoundaryError";
  }
}

export function checkedIrisFetch(transport: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const response = await transport(input, { ...init, redirect: "error" });
    if (response.ok) {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const persona = /\/v1\/personas\/[^/]+\/current$/.test(url.pathname);
      const limit = persona ? 262_144 : 1_048_576;
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          if (reader === undefined) break;
          init?.signal?.throwIfAborted();
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > limit)
            throw new IrisBoundaryError(
              persona ? "persona_too_large" : "response_too_large",
              false,
            );
          chunks.push(part.value);
        }
      } finally {
        await reader?.cancel();
      }
      init?.signal?.throwIfAborted();
      const raw = Buffer.concat(chunks);
      if (persona) {
        const wire = raw.toString("utf8");
        const value = JSON.parse(wire) as Record<string, unknown>;
        value.bellisCanonicalPersonaV1 = personaCanonicalFromWire(wire);
        return new Response(JSON.stringify(value), {
          status: response.status,
          headers: { "content-type": "application/json" },
        });
      }
      // The public SDK parses only a bounded body. Core's event poll is finite;
      // retaining its content-type preserves SDK SSE parsing and replay behavior.
      return new Response(response.status === 204 || response.status === 205 ? null : raw, {
        status: response.status,
        headers: response.headers,
      });
    }
    let code = "http_error";
    let reasonCode: string | undefined;
    let retryable = response.status === 429 || response.status >= 500;
    // Error payloads are untrusted and bounded independently of success payloads.
    const reader = response.body?.getReader();
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      if (reader !== undefined) {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 16_384) break;
          chunks.push(part.value);
        }
      }
      if (bytes <= 16_384) {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          error?: { code?: unknown; retryable?: unknown; details?: { reason_code?: unknown } };
        };
        if (
          typeof payload.error?.code === "string" &&
          /^[a-z][a-z0-9_.-]{0,127}$/.test(payload.error.code) &&
          typeof payload.error.retryable === "boolean"
        ) {
          code = payload.error.code;
          retryable = payload.error.retryable;
          const reason = payload.error.details?.reason_code;
          if (
            typeof reason === "string" &&
            [
              "fts_rebuild_pending",
              "fts_builder_unknown",
              "fts_generation_stale",
              "fts_index_corrupt",
              "fts_unavailable",
              "fts_as_of_unsupported",
            ].includes(reason)
          )
            reasonCode = reason;
        }
      }
    } catch {
      init?.signal?.throwIfAborted();
    } finally {
      await reader?.cancel();
    }
    // An authorization failure never becomes a retryable offline fallback.
    if (response.status === 401 || response.status === 403) retryable = false;
    throw new IrisBoundaryError(code, retryable, response.status, reasonCode);
  };
}
