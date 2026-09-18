import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type P0EndpointObservation,
  type P0ObservationStreamEnd,
  type P0ProcessObservation,
  type P0ProtocolObservation,
  validate,
} from "../packages/contract-sdk/src/index.ts";
import { safeChildEnvironment } from "../packages/runtime/src/processes.ts";
import { repository } from "./p0-identity.helpers.ts";

type Record =
  | P0EndpointObservation
  | P0ObservationStreamEnd
  | P0ProcessObservation
  | P0ProtocolObservation;
export function records(raw: string): Record[] {
  assert.ok(raw.endsWith("\n"), "capture must contain complete final lines");
  return raw
    .slice(0, -1)
    .split("\n")
    .map((line) => {
      const value: unknown = JSON.parse(line);
      if (
        validate("P0ProcessObservation", value) ||
        validate("P0ProtocolObservation", value) ||
        validate("P0EndpointObservation", value) ||
        validate("P0ObservationStreamEnd", value)
      )
        return value;
      return assert.fail("unrecognized observation line");
    });
}
export function protocolRecords(raw: string): P0ProtocolObservation[] {
  return records(raw).filter(
    (r): r is P0ProtocolObservation =>
      "record_type" in r && r.record_type === "p0-protocol-observation",
  );
}
export function processRecords(raw: string): P0ProcessObservation[] {
  return records(raw).filter(
    (r): r is P0ProcessObservation =>
      "record_type" in r && r.record_type === "p0-process-observation",
  );
}
export function completeStreams(raw: string): void {
  const byStream = new Map<
    string,
    { next: number; ended: boolean; pid: number | null; clock: string | null }
  >();
  for (const record of records(raw)) {
    const endpoint = "observation_seq" in record;
    const stream = endpoint
      ? "endpoint"
      : record.record_type === "p0-observation-stream-end"
        ? record.stream
        : record.record_type === "p0-process-observation"
          ? "process"
          : "protocol";
    const instance = endpoint
      ? record.endpoint_fact.endpoint_instance_id
      : record.source_instance_id;
    const key = `${instance}:${stream}`;
    const state = byStream.get(key) ?? { next: 0, ended: false, pid: null, clock: null };
    assert.equal(state.ended, false, `record after end: ${key}`);
    assert.equal(record.dropped_observations, 0, `actual observation loss: ${key}`);
    const clock = endpoint
      ? record.endpoint_fact.observed_at.clock_domain
      : record.observed_at.clock_domain;
    if (state.clock !== null) assert.equal(clock, state.clock, `clock changed: ${key}`);
    state.clock = clock;
    if (!endpoint) {
      if (state.pid !== null) assert.equal(record.source_pid, state.pid, `PID changed: ${key}`);
      state.pid = record.source_pid;
    }
    if (!endpoint && record.record_type === "p0-observation-stream-end") {
      assert.equal(record.next_seq, state.next, key);
      state.ended = true;
    } else {
      assert.equal(endpoint ? record.observation_seq : record.source_seq, state.next, key);
      state.next++;
    }
    byStream.set(key, state);
  }
  for (const [key, state] of byStream)
    assert.equal(state.ended, true, `missing actual end: ${key}`);
}
export function capture(args: string[], name: string, environment = safeChildEnvironment()) {
  const child = spawn(process.execPath, args, {
    cwd: repository,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  let total = 0,
    overflow = false;
  const collect = (chunks: Buffer[], bytes: Buffer) => {
    total += bytes.length;
    if (total > 16 * 1024 * 1024) {
      overflow = true;
      child.kill("SIGKILL");
      return;
    }
    chunks.push(bytes);
  };
  child.stdout.on("data", (bytes: Buffer) => collect(stdout, bytes));
  child.stderr.on("data", (bytes: Buffer) => collect(stderr, bytes));
  const closed = once(child, "close");
  const output = () => ({
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
    overflow,
  });
  const save = async () => {
    const directory = join(repository, "reports/p0/w5o/raw");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${name}.stderr.ndjson`), Buffer.concat(stderr));
    await writeFile(join(directory, `${name}.stdout`), Buffer.concat(stdout));
    assert.equal(overflow, false, "bounded raw capture overflowed");
  };
  return { child, closed, save, output };
}
