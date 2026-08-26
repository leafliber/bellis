import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PersistenceError, createPersistenceClient } from "../../src/index.js";
import type { PersistenceClient } from "../../src/index.js";
import {
  CYCLE_ID,
  SCENE_ID,
  SESSION_ID,
  TRACE,
  WORKER_FIXTURE,
  cleanupTempDataDirectory,
  createTempDataDirectory,
  cycleId,
  makeOutboxMessage,
  makeScene,
  makeSessionRecord,
  outboxId,
  sceneId,
} from "../helpers.js";

/**
 * 真实 Worker 全链路集成测试（docs/protocols/persistence-and-recovery.md）。
 * 每个测试文件使用独立临时数据目录；成功/失败后都清理。
 */

let dataDirectory: string;
let client: PersistenceClient;
const tempDirs: string[] = [];

async function commitInput(n: number, overrides?: { watermark?: bigint }) {
  return {
    sceneId: sceneId(n),
    cycleId: cycleId(n),
    sessionId: SESSION_ID,
    scene: makeScene({ sceneId: sceneId(n), cycleId: cycleId(n) }),
    idempotencyKey: `key-${n}`,
    requestFingerprint: `fp-${n}`,
    watermarks: [{ source: "asr", watermark: overrides?.watermark ?? BigInt(n) }],
    outbox: [makeOutboxMessage({ outboxId: outboxId(n) })],
    trace: TRACE,
  };
}

beforeAll(async () => {
  dataDirectory = createTempDataDirectory();
  client = createPersistenceClient({
    dataDirectory,
    worker: WORKER_FIXTURE,
    wallClockMs: 1_700_000_000_000,
    recordIds: [],
  });
  await client.migrate();
  await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 1, trace: TRACE });
});

afterAll(async () => {
  await client.close();
  cleanupTempDataDirectory(dataDirectory);
  for (const dir of tempDirs) {
    cleanupTempDataDirectory(dir);
  }
});

afterEach(() => {
  // 主 client 的 Worker 常驻；本文件所有临时 client 都在各自测试内 close。
  expect(process.getActiveResourcesInfo().filter((r) => r === "Worker").length).toBeLessThanOrEqual(
    1,
  );
});

/** 索引测试专用 sceneId（不与其它测试的聚合前缀冲突）。 */
function indexSceneId(n: number): string {
  return `55555555-5555-4555-8555-5555555500${String(n).padStart(2, "0")}`;
}

describe("Session 生命周期", () => {
  it("ensureSession 幂等；同 ID 不同 createdAtMs 冲突", async () => {
    await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 1, trace: TRACE });
    await expect(
      client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 2, trace: TRACE }),
    ).rejects.toMatchObject({ code: "session_conflict" });
  });

  it("未创建 Session 时 readRecoveryState 返回 session_not_found", async () => {
    await expect(
      client.readRecoveryState("77777777-7777-4777-8777-777777777777"),
    ).rejects.toMatchObject({ code: "session_not_found" });
  });
});

describe("Session Records", () => {
  it("追加 + 按聚合序号单调唯一", async () => {
    const agg = "turn-1";
    const mk = (seq: number) =>
      makeSessionRecord({
        recordId: `77777777-7777-4777-8777-${seq.toString().padStart(12, "0")}`,
        recordType: "turn.appended",
        aggregateId: agg,
        aggregateSeq: seq.toString(10),
      });
    await client.appendRecord({ record: mk(1), trace: TRACE });
    await client.appendRecord({ record: mk(2), trace: TRACE });
    await expect(client.appendRecord({ record: mk(2), trace: TRACE })).rejects.toMatchObject({
      code: "record_conflict",
    });
    await expect(client.appendRecord({ record: mk(1), trace: TRACE })).rejects.toMatchObject({
      code: "record_conflict",
    });
  });

  it("非法 Record 在 RPC Payload 校验处拒绝（不执行 SQL）", async () => {
    await expect(
      client.appendRecord({
        record: makeSessionRecord({ recordType: "" }),
        trace: TRACE,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("未知 Session 的 Record 拒绝（FK 语义）", async () => {
    await expect(
      client.appendRecord({
        record: makeSessionRecord({ sessionId: "77777777-7777-4777-8777-777777777777" }),
        trace: TRACE,
      }),
    ).rejects.toMatchObject({ code: "session_not_found" });
  });

  it("活动 Scene 索引：非终态 UPSERT、可证终态 DELETE、不可验证 payload 保守保留", async () => {
    const lifecycle = (n: number, to: string, at: number, payloadOverrides = {}) =>
      makeSessionRecord({
        recordId: `99999999-9999-4999-8999-${(n * 100 + at).toString().padStart(12, "0")}`,
        recordType: "scene_lifecycle",
        occurredAtMs: at,
        aggregateId: `scene-lifecycle:${indexSceneId(n)}`,
        aggregateSeq: String(at),
        payload: {
          payloadVersion: 1,
          sceneId: indexSceneId(n),
          cycleId: indexSceneId(n),
          from: "x",
          to,
          ...payloadOverrides,
        },
      });
    // 在途 → 索引行；再推进 → UPSERT 更新状态。
    await client.appendRecord({ record: lifecycle(1, "preparing", 1), trace: TRACE });
    await client.appendRecord({ record: lifecycle(1, "running", 2), trace: TRACE });
    let rows = await client.listActiveScenes(SESSION_ID);
    expect(rows.filter((row) => row.sceneId === indexSceneId(1)).map((row) => row.state)).toEqual([
      "running",
    ]);
    // 可证终态 → DELETE（写侧同事务）。
    await client.appendRecord({ record: lifecycle(1, "completed", 3), trace: TRACE });
    rows = await client.listActiveScenes(SESSION_ID);
    expect(rows.some((row) => row.sceneId === indexSceneId(1))).toBe(false);
    // payload 无版本（不可验证）→ 保守保留 unknown（绝不当作已知格式）。
    await client.appendRecord({
      record: lifecycle(2, "completed", 4, { payloadVersion: 2 }),
      trace: TRACE,
    });
    rows = await client.listActiveScenes(SESSION_ID);
    const unknown = rows.find((row) => row.sceneId === indexSceneId(2));
    expect(unknown?.state).toBe("unknown");
    // aggregateId 兜底：payload 缺 sceneId 时以聚合前缀归属。
    await client.appendRecord({
      record: makeSessionRecord({
        recordId: "99999999-9999-4999-8999-000000000099",
        recordType: "scene_lifecycle",
        occurredAtMs: 5,
        aggregateId: `scene-lifecycle:${indexSceneId(3)}`,
        payload: { to: "scheduled" },
      }),
      trace: TRACE,
    });
    rows = await client.listActiveScenes(SESSION_ID);
    // payload 无版本不可信（to 不采信）→ unknown；sceneId 归属仍由
    // aggregateId 前缀兜底（行存在即未证终态）。
    expect(rows.some((row) => row.sceneId === indexSceneId(3) && row.state === "unknown")).toBe(true);
  });

  it("recordType 过滤 + 倒序最近窗口（生命周期专用查询语义）", async () => {
    // 插入 70 条混合记录：早期 lifecycle 与近期 lifecycle 之间夹大量
    // 审计记录——固定升序窗口会取到最早一批（历史缺陷），倒序 +
    // recordType 过滤必须取到最近的 lifecycle 证据。
    for (let i = 0; i < 70; i += 1) {
      const recordType = i < 20 || i >= 60 ? "scene_lifecycle" : "phase2_audit_noise";
      await client.appendRecord({
        record: makeSessionRecord({
          recordId: `88888888-8888-4888-8888-${(i + 1).toString().padStart(12, "0")}`,
          recordType,
          occurredAtMs: i + 1,
          aggregateId: `scene-lifecycle:44444444-4444-4444-8444-4444440000${String(i).padStart(2, "0")}`,
          aggregateSeq: String(i + 1),
        }),
        trace: TRACE,
      });
    }
    const window = await client.listRecords({
      sessionId: SESSION_ID,
      recordType: "scene_lifecycle",
      order: "desc",
      limit: 5,
    });
    expect(window).toHaveLength(5);
    expect(window.every((record) => record.recordType === "scene_lifecycle")).toBe(true);
    // 倒序返回最近 5 条 lifecycle（occurredAtMs 70..66），绝不包含
    // 最早 20 条（历史缺陷：升序固定窗口取到 1..N）。
    expect(window.map((record) => record.occurredAtMs)).toEqual([70, 69, 68, 67, 66]);
  });

  it("按 trace / session / aggregate 索引查询", async () => {
    const byTrace = await client.listRecords({ traceId: TRACE.traceId });
    expect(byTrace.length).toBeGreaterThanOrEqual(2);
    const bySession = await client.listRecords({ sessionId: SESSION_ID });
    expect(bySession.every((record) => record.sessionId === SESSION_ID)).toBe(true);
    const byAggregate = await client.listRecords({ aggregateId: "turn-1" });
    expect(byAggregate.map((record) => record.aggregateSeq)).toEqual(["1", "2"]);
  });

  it("读到未知 schemaVersion 返回兼容性错误，不盲转", async () => {
    const raw = new DatabaseSync(join(dataDirectory, "state.db"));
    raw.exec("PRAGMA busy_timeout = 3000;");
    try {
      raw
        .prepare(
          `INSERT INTO session_records
             (record_id, session_id, record_type, aggregate_id, aggregate_seq, trace_id,
              occurred_at_ms, schema_version, payload_json)
           VALUES (?, ?, ?, NULL, NULL, ?, ?, 99, '{}')`,
        )
        .run("88888888-8888-4888-8888-888888888888", SESSION_ID, "future.record", TRACE.traceId, 1);
    } finally {
      raw.close();
    }
    await expect(client.listRecords({ traceId: TRACE.traceId })).rejects.toMatchObject({
      code: "record_version_unknown",
    });
    // 不触碰坏行的查询仍然可用。
    await expect(client.listRecords({ aggregateId: "turn-1" })).resolves.toHaveLength(2);
  });
});

describe("原子 commitScene", () => {
  it("成功提交：Scene/Record/Watermark/Outbox/Idempotency 同事务落库", async () => {
    const result = await client.commitScene(await commitInput(1));
    expect(result.duplicate).toBe(false);
    expect(result.committedAtMs).toBe(1_700_000_000_000);
    const records = await client.listRecords({ aggregateId: `scene-commit:${SESSION_ID}` });
    expect(records.some((record) => record.recordType === "scene_committed")).toBe(true);
    const stats = await client.readOutboxStats();
    expect(stats.pending).toBe(1);
  });

  it("幂等重放返回第一次结果；不同摘要冲突", async () => {
    const replay = await client.commitScene(await commitInput(1));
    expect(replay.duplicate).toBe(true);
    expect(replay.committedAtMs).toBe(1_700_000_000_000);
    const conflicting = { ...(await commitInput(1)), requestFingerprint: "fp-other" };
    await expect(client.commitScene(conflicting)).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    // 冲突不改变第一次结果。
    expect((await client.readOutboxStats()).pending).toBe(1);
  });

  it("Watermark 倒退 → 整体回滚，无任何部分提交", async () => {
    const statsBefore = await client.readOutboxStats();
    const recordsBefore = (await client.listRecords({ aggregateId: `scene-commit:${SESSION_ID}` }))
      .length;
    const before = await client.readRecoveryState(SESSION_ID);
    await expect(client.commitScene(await commitInput(2, { watermark: 0n }))).rejects.toMatchObject(
      { code: "watermark_regression" },
    );
    expect(await client.readOutboxStats()).toEqual(statsBefore);
    expect((await client.listRecords({ aggregateId: `scene-commit:${SESSION_ID}` })).length).toBe(
      recordsBefore,
    );
    const after = await client.readRecoveryState(SESSION_ID);
    expect(after.signalWatermarks).toEqual(before.signalWatermarks);
    expect(after.lastCommittedScene?.sceneId).toBe(before.lastCommittedScene?.sceneId);
  });

  it("Scene Payload 与入参 ID 不一致 → scene_invalid 且回滚", async () => {
    const mismatched = makeScene({ sceneId: SCENE_ID, cycleId: CYCLE_ID });
    await expect(
      client.commitScene({
        sceneId: sceneId(3),
        cycleId: cycleId(3),
        sessionId: SESSION_ID,
        scene: mismatched,
        idempotencyKey: "key-3",
        requestFingerprint: "fp-3",
        watermarks: [],
        outbox: [],
        trace: TRACE,
      }),
    ).rejects.toMatchObject({ code: "scene_invalid" });
  });

  it("相同 cycle 重复提交不同幂等键 → scene_conflict 回滚", async () => {
    await client.commitScene(await commitInput(4));
    const dupCycle = {
      ...(await commitInput(5)),
      scene: makeScene({ sceneId: sceneId(5), cycleId: cycleId(4) }),
      cycleId: cycleId(4),
    };
    await expect(client.commitScene(dupCycle)).rejects.toMatchObject({ code: "scene_conflict" });
  });
});

describe("Server Seq", () => {
  it("单调推进；相等幂等；倒退拒绝", async () => {
    expect(
      await client.advanceServerSeq({ sessionId: SESSION_ID, latestServerSeq: 100n, trace: TRACE }),
    ).toBe(100n);
    expect(
      await client.advanceServerSeq({ sessionId: SESSION_ID, latestServerSeq: 100n, trace: TRACE }),
    ).toBe(100n);
    expect(
      await client.advanceServerSeq({ sessionId: SESSION_ID, latestServerSeq: 130n, trace: TRACE }),
    ).toBe(130n);
    await expect(
      client.advanceServerSeq({ sessionId: SESSION_ID, latestServerSeq: 129n, trace: TRACE }),
    ).rejects.toMatchObject({ code: "seq_regression" });
    const recovery = await client.readRecoveryState(SESSION_ID);
    expect(recovery.latestServerSeq).toBe(130n);
    expect(recovery.signalWatermarks.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Client 生命周期", () => {
  it("未 migrate 的客户端拒绝业务操作", async () => {
    // 独立目录：同目录第二个 Worker 会被独占守卫拒绝（见 worker-lock 测试）。
    const virginDir = createTempDataDirectory("bellis-p2-virgin-");
    tempDirs.push(virginDir);
    const virgin = createPersistenceClient({ dataDirectory: virginDir, worker: WORKER_FIXTURE });
    try {
      await expect(
        virgin.ensureSession({ sessionId: SESSION_ID, createdAtMs: 1, trace: TRACE }),
      ).rejects.toMatchObject({ code: "not_migrated" });
    } finally {
      await virgin.close();
    }
  });

  it("close 后调用拒绝 closed", async () => {
    const ephemeralDir = createTempDataDirectory("bellis-p2-closed-");
    tempDirs.push(ephemeralDir);
    const ephemeral = createPersistenceClient({
      dataDirectory: ephemeralDir,
      worker: WORKER_FIXTURE,
    });
    await ephemeral.close();
    await expect(ephemeral.migrate()).rejects.toMatchObject({ code: "closed" });
  });

  it("数据目录必须是绝对路径（没有仓库内默认值）", () => {
    expect(() => createPersistenceClient({ dataDirectory: "relative/db" })).toThrow(
      PersistenceError,
    );
  });
});
