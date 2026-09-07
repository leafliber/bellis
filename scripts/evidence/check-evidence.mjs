import { execFileSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { detailFields } from "./summarize-report.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const errors = [];
let total = 0;
async function checkDirectory(directory) {
  for (const entry of await readdir(new URL(directory, new URL("../../", import.meta.url)), {
    withFileTypes: true,
  })) {
    const path = `${directory}${entry.name}`;
    if (entry.isDirectory()) {
      await checkDirectory(`${path}/`);
      continue;
    }
    if (!entry.name.endsWith(".json")) continue;
    const bytes = await readFile(`${root}${path}`);
    total += bytes.length;
    if (entry.name.endsWith("-raw.json"))
      errors.push(`${path}: raw reports belong in artifacts/evidence/`);
    if (bytes.length > 32 * 1024) errors.push(`${path}: exceeds 32 KiB summary budget`);
    const visit = (value) => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (
          detailFields.has(key) &&
          Array.isArray(child) &&
          child.some((row) => row && typeof row === "object")
        )
          errors.push(`${path}: per-run ${key} must be summarized`);
        visit(child);
      }
    };
    try {
      visit(JSON.parse(bytes));
    } catch {
      errors.push(`${path}: invalid JSON`);
    }
  }
}
await checkDirectory("docs/evidence/");
if (total > 1024 * 1024)
  errors.push(
    "docs/evidence/: exceeds 1 MiB total budget; replace superseded summaries instead of appending runs",
  );
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split(
  "\0",
);
for (const path of tracked.filter((candidate) =>
  /(^|\/)(test-results|playwright-report|artifacts)\//u.test(candidate),
)) {
  // Deleted tracked files remain in the index until the user stages this change.
  if (
    await stat(`${root}${path}`).then(
      () => true,
      () => false,
    )
  )
    errors.push(`${path}: generated output must not be tracked`);
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else console.info(`evidence: summaries checked (${total} bytes)`);
