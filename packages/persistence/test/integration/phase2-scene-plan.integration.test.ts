import { afterAll, describe, expect, it } from "vitest";
import { WORKER_FIXTURE, cleanupTempDataDirectory, createTempDataDirectory } from "../helpers.js";
import {
  createPersistenceClient,
  type CommitSceneInput,
  type PersistenceClient,
} from "../../src/index.js";
import type { Scene, ScenePlan } from "@bellis/contracts";
import { ScenePlanSchema } from "@bellis/contracts";
import { DatabaseSync } from "node:sqlite";

/**
 * Phase 2 ScenePlan 持久化（Migration 0002 / scene-execution.md §9）：
 * commitScene 携带 plan 写入 scenes.plan_json；不携带保持 NULL（Phase 1
 * 行为不变）；plan.sceneId 与请求不一致稳定拒绝。
 */

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SCENE_ID = "44444444-4444-4444-8444-444444444444";
const CYCLE_ID = "33333333-3333-4333-8333-333333333333";

const SCENE: Scene = {
  schemaVersion: 1,
  sceneId: SCENE_ID,
  cycleId: CYCLE_ID,
  groups: [
    {
      schemaVersion: 1,
      groupId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      lanes: ["audio", "subtitle"],
      level: "hard",
    },
  ],
  deadlineMs: 500,
  interruptPolicy: "fade",
};

const PLAN: ScenePlan = {
  schemaVersion: 1,
  scene: SCENE,
  cues: [
    {
      schemaVersion: 1,
      cueId: "55555555-5555-4555-8555-555555555555",
      lane: "audio",
      anchor: "scene_start",
      offsetMs: 0,
      intent: { speechRef: "plan" },
    },
  ],
};

let client: PersistenceClient | null = null;
const dirs: string[] = [];

async function freshClient(): Promise<PersistenceClient> {
  const dir = createTempDataDirectory("bellis-p2-plan-");
  dirs.push(dir);
  const created = createPersistenceClient({ dataDirectory: dir, worker: WORKER_FIXTURE });
  await created.migrate();
  await created.ensureSession({
    sessionId: SESSION_ID,
    createdAtMs: 0,
    trace: { traceId: "0123456789abcdef0123456789abcdef" },
  });
  client = created;
  return created;
}

function commitInput(overrides?: Partial<CommitSceneInput>): CommitSceneInput {
  return {
    sceneId: SCENE_ID,
    cycleId: CYCLE_ID,
    sessionId: SESSION_ID,
    scene: SCENE,
    idempotencyKey: `plan-${Math.random().toString(36).slice(2)}`,
    requestFingerprint: "phase2-plan-test",
    watermarks: [],
    outbox: [],
    trace: { traceId: "0123456789abcdef0123456789abcdef" },
    ...overrides,
  };
}

function readPlanJson(dir: string, sceneId: string): string | null {
  const db = new DatabaseSync(`${dir}/state.db`);
  try {
    const row = db.prepare("SELECT plan_json FROM scenes WHERE scene_id = ?").get(sceneId);
    const value = row?.["plan_json"];
    return value === null || value === undefined ? null : String(value);
  } finally {
    db.close();
  }
}

afterAll(async () => {
  await client?.close();
  for (const dir of dirs) {
    cleanupTempDataDirectory(dir);
  }
});

describe("Phase 2 ScenePlan 持久化", () => {
  it("commitScene 携带 plan：事务内写入 plan_json（可审计完整计划）", async () => {
    const c = await freshClient();
    const result = await c.commitScene(commitInput({ plan: PLAN }));
    expect(result.duplicate).toBe(false);
    const stored = readPlanJson(dirs[dirs.length - 1]!, SCENE_ID);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!).scene.sceneId).toBe(SCENE_ID);
    expect(JSON.parse(stored!).cues).toHaveLength(1);
  });

  it("不携带 plan：plan_json 为 NULL（Phase 1 行为不变）", async () => {
    const c = await freshClient();
    await c.commitScene(commitInput());
    expect(readPlanJson(dirs[dirs.length - 1]!, SCENE_ID)).toBeNull();
  });

  it("plan.sceneId 与请求不一致：scene_invalid 拒绝且不落库", async () => {
    const c = await freshClient();
    const mismatched: ScenePlan = ScenePlanSchema.parse({
      ...PLAN,
      softTimeoutMs: PLAN.softTimeoutMs ?? 500,
      scene: { ...SCENE, sceneId: "44444444-4444-4444-8444-4444444444ff" },
    });
    await expect(c.commitScene(commitInput({ plan: mismatched }))).rejects.toThrow(
      /plan scene id does not match/,
    );
    expect(readPlanJson(dirs[dirs.length - 1]!, SCENE_ID)).toBeNull();
  });

  it("幂等重放（同键同摘要）返回 duplicate，plan_json 不重复写入", async () => {
    const c = await freshClient();
    const input = commitInput({ plan: PLAN });
    const first = await c.commitScene(input);
    const second = await c.commitScene(input);
    expect(second.duplicate).toBe(true);
    expect(second.committedAtMs).toBe(first.committedAtMs);
  });
});
