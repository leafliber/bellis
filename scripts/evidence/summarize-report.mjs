import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const detailFields = new Set(["results", "cases", "cycleAudit", "observations"]);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// Counts describe recorded rows, not independently verified pass/fail conclusions.
function summarizeRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const dimensions = Object.fromEntries(
      ["window", "target", "checkpoint", "status"]
        .filter((key) => row[key] !== undefined)
        .map((key) => [key, row[key]]),
    );
    const key = JSON.stringify(dimensions);
    const group = groups.get(key) ?? { ...dimensions, records: 0, repetitions: [] };
    group.records++;
    if (Number.isInteger(row.repetition)) group.repetitions.push(row.repetition);
    groups.set(key, group);
  }
  return {
    records: rows.length,
    groups: [...groups.values()].map(({ repetitions, ...group }) => ({
      ...group,
      ...(repetitions.length
        ? {
            repetitionCount: repetitions.length,
            uniqueRepetitions: new Set(repetitions).size,
            minRepetition: Math.min(...repetitions),
            maxRepetition: Math.max(...repetitions),
          }
        : {}),
    })),
  };
}

export function summarizeReport(raw, source) {
  const compact = (value) => {
    if (Array.isArray(value)) return value.map(compact);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) =>
        detailFields.has(key) &&
        Array.isArray(entry) &&
        entry.every((row) => row !== null && typeof row === "object" && !Array.isArray(row))
          ? [`${key}Summary`, summarizeRows(entry)]
          : [key, compact(entry)],
      ),
    );
  };
  return {
    reportFormat: "bellis-evidence-summary-v1",
    ...compact(JSON.parse(raw)),
    rawReportSource: { ...source, bytes: Buffer.byteLength(raw), sha256: sha256(raw) },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output, artifactUrl] = process.argv.slice(2);
  if (!input || !output)
    throw new Error("Usage: summarize-report.mjs <raw.json> <summary.json> [CI artifact URL]");
  const raw = await readFile(input, "utf8");
  const summary = summarizeReport(raw, { path: input, ...(artifactUrl ? { artifactUrl } : {}) });
  await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`);
}
