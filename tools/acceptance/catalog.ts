// These are executable case identities, not another invariant registry. Tool cases
// come from literal node:test titles; SUT cases must be added with their real runner.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../lib/build-manifest.ts";
import { ROOT } from "../lib/registry.ts";

export function caseId(testId: string, title: string): string {
  return `${testId}.${sha256(title).slice(0, 16)}`;
}

export function toolCases(
  testId: string,
  runner: string,
  root = ROOT,
): { id: string; title: string }[] {
  const source = readFileSync(join(root, runner), "utf8");
  const titles = [...source.matchAll(/\btest\(\s*"((?:[^"\\]|\\.)*)"/g)].map(
    (m) => JSON.parse(`"${m[1]}"`) as string,
  );
  if (
    !titles.length ||
    titles.some((title) => !title.startsWith(`${testId}:`)) ||
    new Set(titles).size !== titles.length
  )
    throw new Error(`No unambiguous literal case catalog for ${testId}`);
  return titles.map((title) => ({ id: caseId(testId, title), title }));
}

// Fail closed until a real SUT suite owns a reviewed scenario catalog. W3-W7 add
// entries here alongside actual process-driving assertions, never PASS constants.
export const sutScenarios: Readonly<Record<string, readonly string[]>> = {};

/** Required P0 machine coverage; excludes unreachable unattended_approved state.
 * Disabled admission is tested as rejection, never enabled just for coverage.
 * Scenario owners add actual traces for these rows; this function runs no SUT.
 */
export function p0TransitionRequirements(machines: import("../lib/registry.ts").Machine[]) {
  type Row = Omit<
    import("../../packages/contract-sdk/src/index.ts").SchemaTypes["P0TransitionCoverage"],
    "scenario_id"
  >;
  const rows: Row[] = [];
  for (const machine of machines.filter((m) => m.phase === "P0")) {
    const name = machine.id as Row["machine"];
    for (const transition of machine.transitions.filter((t) => t.phase === "P0")) {
      for (const state of transition.source.filter((s) => s !== "unattended_approved")) {
        const disabled = transition.event === "approve_unattended";
        rows.push({
          machine: name,
          state,
          event: transition.event,
          guard: transition.guard,
          disposition: disabled ? "disabled_rejected" : "accepted",
        });
        if (!disabled && transition.guard !== "always")
          rows.push({
            machine: name,
            state,
            event: transition.event,
            guard: transition.guard,
            disposition: "guard_rejected",
          });
      }
    }
    for (const state of machine.states.filter((s) => s !== "unattended_approved")) {
      rows.push({
        machine: name,
        state,
        event: "__unregistered__",
        guard: "none",
        disposition: machine.terminal.includes(state) ? "terminal_rejected" : "table_rejected",
      });
    }
    for (const state of machine.terminal)
      rows.push({
        machine: name,
        state,
        event: machine.id === "ExecutionGrant" ? "approve" : "local_ack",
        guard: "none",
        disposition: "terminal_rejected",
      });
  }
  return rows;
}
