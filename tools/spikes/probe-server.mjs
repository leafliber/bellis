// Serves the browser probe page on loopback. Run directly for the manual OBS probe:
//   pnpm spike:serve   -> http://127.0.0.1:17869/stage.html (fixed Origin)
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const files = new Map(
  ["stage.html", "probe.mjs", "worklet.mjs"].map((name) => [
    `/${name}`,
    readFileSync(new URL(`probes/${name}`, import.meta.url)),
  ]),
);

/** Starts the probe server; port 0 picks a free port. Resolves to the listening server. */
export function startProbeServer(port) {
  const server = createServer((request, response) => {
    const content = files.get(request.url);
    if (!content) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.setHeader(
      "Content-Type",
      request.url.endsWith(".mjs") ? "text/javascript" : "text/html",
    );
    response.setHeader("Cache-Control", "no-store");
    response.end(content);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startProbeServer(17869);
  console.log(`Probe page: http://127.0.0.1:${server.address().port}/stage.html (Ctrl+C to stop)`);
}
