import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createPersistenceClient } from "@bellis/persistence";
import type { RuntimeHandle } from "../../src/index.js";
import {
  WORKER_FIXTURE,
  createTempDataDirectory,
  cleanupTempDataDirectory,
  startTestRuntime,
  originFor,
} from "../helpers.js";

it("reports disk pressure as not-ready while the live process and recovery reads remain available", async () => {
  const dataDirectory = createTempDataDirectory("runtime-disk-readiness-");
  const persistence = createPersistenceClient({
    dataDirectory,
    worker: WORKER_FIXTURE,
    diskAdmission: { highWaterBytes: 16 * 1024 ** 2 },
  });
  let runtime: RuntimeHandle | undefined;
  try {
    await persistence.migrate();
    runtime = await startTestRuntime({ dataDirectory, persistenceClient: persistence });
    const read = (kind: "ready" | "live") =>
      fetch(`${originFor(runtime!)}/api/v1/health/${kind}`, {
        headers: { origin: originFor(runtime!) },
      });
    expect((await read("ready")).status).toBe(200);
    const db = new DatabaseSync(`${dataDirectory}/state.db`);
    try {
      db.exec(
        "CREATE TABLE disk_pressure (payload BLOB); INSERT INTO disk_pressure VALUES(zeroblob(16777216));",
      );
    } finally {
      db.close();
    }
    const response = await read("ready");
    expect(response.status).toBe(503);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ code: "not_ready", message: "runtime is not ready" });
    expect(JSON.stringify(body)).not.toContain(dataDirectory);
    expect((await read("live")).status).toBe(200);
    expect((await persistence.readDiskStatus()).reason).toBe("high_water");
    expect((await persistence.readOutboxStats()).dead).toBe(0);
  } finally {
    await runtime?.close();
    await persistence.close();
    cleanupTempDataDirectory(dataDirectory);
  }
});
