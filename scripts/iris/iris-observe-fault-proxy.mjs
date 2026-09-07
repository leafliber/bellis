import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";

/** Trusted local fault transport. The destination is fixed; no credentials are logged. */
export async function createObserveFaultProxy(baseUrl, window) {
  const origin = new URL(baseUrl).origin;
  let release,
    announce,
    latched = false;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const checkpoint = new Promise((resolve) => {
    announce = resolve;
  });
  const requests = [],
    active = new Set(),
    controllers = new Set();
  const server = createServer((request, response) => {
    const controller = new AbortController();
    controllers.add(controller);
    const operation = (async () => {
      const url = new URL(request.url, baseUrl);
      assert.equal(url.origin, origin);
      let bytes = 0;
      const chunks = [];
      for await (const chunk of request) {
        bytes += chunk.length;
        assert.ok(bytes <= 262144);
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const isObserve = request.method === "POST" && url.pathname === "/v1/observations:batch";
      const entry = isObserve
        ? {
            records: JSON.parse(body.toString()).records,
            key: request.headers["idempotency-key"],
            bodyDigest: createHash("sha256").update(body).digest("hex"),
            responseForwarded: false,
          }
        : undefined;
      if (entry) {
        assert.ok(requests.length < 8);
        requests.push(entry);
      }
      const hold = entry && !latched && window !== "observation-sdk-ack-before-host-delivered";
      if (hold) latched = true;
      if (hold && window === "observation-before-http-publish") {
        announce(entry);
        await gate;
      }
      const headers = { ...request.headers };
      delete headers.host;
      delete headers.connection;
      delete headers["content-length"];
      const upstream = await fetch(url, {
        method: request.method,
        headers,
        ...(body.length ? { body } : {}),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      });
      const payload = Buffer.from(await upstream.arrayBuffer());
      assert.ok(payload.length <= 2097152);
      if (entry) {
        assert.equal(upstream.status, 200);
        entry.receipt = JSON.parse(payload.toString());
      }
      if (hold && window === "core-observation-committed-before-http-ack") {
        announce(entry);
        await gate;
      }
      if (!response.destroyed) {
        response.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") ?? "application/json",
        });
        response.end(payload);
        if (entry) entry.responseForwarded = true;
      }
    })()
      .catch((error) => {
        if (!response.destroyed) {
          response.statusCode = 502;
          response.end(JSON.stringify({ error: "test_proxy_failed", detail: error.name }));
        }
      })
      .finally(() => {
        active.delete(operation);
        controllers.delete(controller);
      });
    active.add(operation);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    release,
    async checkpoint() {
      let timer;
      try {
        return await Promise.race([
          checkpoint,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Observe transport checkpoint timeout")),
              20000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      release();
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await Promise.allSettled([...active]);
    },
  };
}
