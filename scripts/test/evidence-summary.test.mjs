import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { summarizeReport } from "../evidence/summarize-report.mjs";

test("summary preserves incomplete conclusions and exposes missing/duplicate repetitions", () => {
  const report = {
    recovery: {
      status: "incomplete",
      casesPassed: 3,
      expectedCases: 4,
      requiredRepetitions: 2,
      scope: "Runtime only; no Core crashes",
      results: [
        { window: "before", target: "runtime", repetition: 1, eventId: "private-a" },
        { window: "before", target: "runtime", repetition: 1, eventId: "private-b" },
        { window: "after", target: "runtime", repetition: 2, eventId: "private-c" },
      ],
    },
    remaining: ["Core crashes"],
    sdkVersion: "0.11.2",
  };
  const raw = JSON.stringify(report);
  const summary = summarizeReport(raw, { path: "artifacts/evidence/run.json" });
  assert.equal(summary.recovery.status, "incomplete");
  assert.equal(summary.recovery.casesPassed, 3);
  assert.equal(summary.recovery.expectedCases, 4);
  assert.equal(summary.recovery.scope, report.recovery.scope);
  assert.deepEqual(summary.remaining, report.remaining);
  assert.equal(summary.recovery.resultsSummary.records, 3);
  assert.equal(summary.recovery.resultsSummary.groups[0].repetitionCount, 2);
  assert.equal(summary.recovery.resultsSummary.groups[0].uniqueRepetitions, 1);
  assert.equal(summary.recovery.resultsSummary.groups[1].minRepetition, 2);
  assert.equal(JSON.stringify(summary).includes("private-"), false);
  assert.equal(summary.rawReportSource.sha256, createHash("sha256").update(raw).digest("hex"));
});

test("nested reports retain smoke status, scalar facts and named case lists", () => {
  const raw = JSON.stringify({
    recovery: { status: "smoke-passed", cycleRecovery: { results: [] } },
    stageOutput: {
      observations: [{ eventId: "a" }],
      cycleAudit: [{ cycleId: "b" }],
      chromium: "passed",
    },
    cases: ["before", "after"],
    scope: "已验证范围",
  });
  const summary = summarizeReport(raw, { gitRevision: "abc", path: "old.json" });
  assert.equal(summary.recovery.status, "smoke-passed");
  assert.equal(summary.recovery.cycleRecovery.resultsSummary.records, 0);
  assert.equal(summary.stageOutput.observationsSummary.records, 1);
  assert.equal(summary.stageOutput.cycleAuditSummary.records, 1);
  assert.equal(summary.stageOutput.chromium, "passed");
  assert.deepEqual(summary.cases, ["before", "after"]);
  assert.equal(summary.rawReportSource.bytes, Buffer.byteLength(raw));
});
