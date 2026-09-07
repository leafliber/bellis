import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadInstalledIrisSdk } from "./iris-installed-sdk.mjs";

/** The production SDK installation exercises the real Core HTTP boundary. */
export async function runEventCheckpointProbe(baseUrl, credential, client) {
  const { metadata, modulePath, AsyncIrisMemoryClient } = await loadInstalledIrisSdk();
  const capabilities = await client.negotiate(["v1"]);
  assert.ok(capabilities.capabilities.includes("events.checkpoint.v1"));
  const events = await client.events({ after: "0", signal: AbortSignal.timeout(5000) });
  const anchor = events.at(-1);
  assert.ok(anchor, "Public deletion probe must produce a real event anchor");
  let sent, status;
  const candidate = new AsyncIrisMemoryClient(baseUrl, {
    bearerToken: credential.token,
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      sent = {
        cursor: headers.get("last-event-id"),
        eventId: headers.get("x-iris-after-event-id"),
      };
      const response = await fetch(input, init);
      status = response.status;
      return response;
    },
  });
  const successors = await candidate.events({
    after: anchor.cursor,
    afterEventId: anchor.event_id,
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(status, 200);
  assert.deepEqual(sent, { cursor: anchor.cursor, eventId: anchor.event_id });
  assert.ok(successors.every((event) => BigInt(event.cursor) > BigInt(anchor.cursor)));
  for (const checkpoint of [
    { after: anchor.cursor, afterEventId: `different-history:${randomUUID()}` },
    { after: String(BigInt(anchor.cursor) + 100_000n), afterEventId: anchor.event_id },
  ]) {
    await assert.rejects(
      candidate.events({ ...checkpoint, signal: AbortSignal.timeout(5000) }),
      /event stream failed with 410/,
    );
    assert.equal(status, 410);
    assert.deepEqual(sent, { cursor: checkpoint.after, eventId: checkpoint.afterEventId });
  }
  return {
    status: "passed",
    sdkVersion: metadata.version,
    sdkInstalledSha256: createHash("sha256")
      .update(await readFile(modulePath))
      .digest("hex"),
    anchor: { cursor: anchor.cursor, eventId: anchor.event_id },
    checkedSuccessors: successors.length,
    acceptedCheckpointStatus: 200,
    rejectedCheckpointStatuses: [410, 410],
    scope:
      "Production installed SDK -> real installed Core API/Worker; original event anchor, mismatched identity and unknown cursor. No Bellis gap revalidation or old-backup restoration claim.",
  };
}
