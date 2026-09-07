import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DiskAdmission } from "../../src/worker/disk-admission.js";

it("does not interpret a missing mandatory database as zero usage and newly available capacity", () => {
  const directory = mkdtempSync(join(tmpdir(), "disk-admission-files-"));
  const admission = new DiskAdmission(directory);
  try {
    for (const name of ["state.db", "telemetry.db", "worker-lock.db"])
      writeFileSync(join(directory, name), Buffer.alloc(4096));
    expect(admission.read().totalBytes).toBe(3 * 4096);
    unlinkSync(join(directory, "state.db"));
    expect(() => admission.read()).toThrow("persistence disk state unavailable");
    expect(() => admission.assertNewWork()).toThrow("persistence disk state unavailable");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
