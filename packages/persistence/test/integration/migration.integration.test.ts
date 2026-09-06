import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createPersistenceClientForTesting } from "../../src/client/persistence-client.js";
import type { PersistenceClient } from "../../src/index.js";
import { STATE_MIGRATIONS, TELEMETRY_MIGRATIONS } from "../../src/migrations/registry.js";
import type { MigrationDefinition } from "../../src/migrations/definition.js";
import {
  SESSION_ID,
  TRACE,
  WORKER_FIXTURE,
  cleanupTempDataDirectory,
  createTempDataDirectory,
  cycleId,
  makeScene,
  sceneId,
} from "../helpers.js";

/**
 * 真实 Worker + 真实临时 SQLite 文件的 Migration 集成测试（docs/protocols/persistence-and-recovery.md）：
 * 重复幂等、checksum 篡改拒绝、注册表外版本拒绝、失败注册表回滚与续跑。
 */

let dataDirectory: string;

afterAll(() => {
  cleanupTempDataDirectory(dataDirectory);
});

function openState(): DatabaseSync {
  const db = new DatabaseSync(join(dataDirectory, "state.db"));
  db.exec("PRAGMA busy_timeout = 3000;");
  return db;
}

/** 原始生命周期 Record 落库（模拟 0003 之前构建的写侧形态）。 */
function insertLifecycle(
  db: DatabaseSync,
  input: {
    readonly n: number;
    readonly to?: string;
    readonly occurredAtMs: number;
    readonly payload?: string;
    readonly payloadVersion?: number;
    readonly aggregateSeq?: string;
    readonly payloadSceneId?: string;
  },
): void {
  const payload =
    input.payload ??
    JSON.stringify({
      payloadVersion: input.payloadVersion ?? 1,
      sceneId: input.payloadSceneId ?? sceneId(input.n),
      cycleId: cycleId(input.n),
      from: "committing",
      ...(input.to === undefined ? {} : { to: input.to }),
    });
  db.prepare(
    `INSERT INTO session_records
       (record_id, session_id, record_type, aggregate_id, aggregate_seq,
        trace_id, occurred_at_ms, schema_version, payload_json)
     VALUES (?, ?, 'scene_lifecycle', ?, ?, ?, ?, 1, ?)`,
  ).run(
    `lifecycle-upgrade-${input.n}-${input.occurredAtMs}-${input.aggregateSeq ?? "x"}`,
    SESSION_ID,
    `scene-lifecycle:${sceneId(input.n)}`,
    input.aggregateSeq ?? String(input.occurredAtMs),
    TRACE.traceId,
    input.occurredAtMs,
    payload,
  );
}

async function withClient(
  migrations?: { state?: MigrationDefinition[] },
  run: (client: PersistenceClient) => Promise<void> = async () => {},
): Promise<void> {
  const client = createPersistenceClientForTesting(
    { dataDirectory, worker: WORKER_FIXTURE },
    migrations === undefined ? {} : { migrations },
  );
  try {
    await run(client);
  } finally {
    await client.close();
  }
}

describe("Migration 集成", () => {
  it("重复 migrate 幂等；telemetry.db 一同迁移", async () => {
    dataDirectory = createTempDataDirectory("bellis-p2-mig-");
    await withClient(undefined, async (client) => {
      await client.migrate();
      await client.migrate();
    });
    const db = openState();
    try {
      const rows = db.prepare("SELECT version FROM schema_migrations").all();
      expect(rows).toEqual(STATE_MIGRATIONS.map(({ version }) => ({ version })));
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'sessions'").get(),
      ).toBeDefined();
    } finally {
      db.close();
    }
  });

  it("已应用 checksum 被篡改 → 拒绝启动，业务不可用", async () => {
    const db = openState();
    try {
      db.exec("UPDATE schema_migrations SET checksum = 'deadbeef' WHERE version = 1");
    } finally {
      db.close();
    }
    await withClient(undefined, async (client) => {
      await expect(client.migrate()).rejects.toMatchObject({
        code: "migration_checksum_mismatch",
      });
      await expect(
        client.ensureSession({
          sessionId: "11111111-1111-4111-8111-111111111111",
          createdAtMs: 1,
          trace: { traceId: "0123456789abcdef0123456789abcdef" },
        }),
      ).rejects.toMatchObject({ code: "not_migrated" });
    });
  });

  it("恢复正确 checksum 后可继续启动", async () => {
    const realChecksum = createHash("sha256")
      .update((STATE_MIGRATIONS[0] as MigrationDefinition).sql, "utf8")
      .digest("hex");
    const db = openState();
    try {
      db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run(realChecksum);
    } finally {
      db.close();
    }
    await withClient(undefined, async (client) => {
      await client.migrate();
    });
  });

  it("库中存在注册表外的已应用版本 → migration_invalid", async () => {
    const db = openState();
    try {
      db.exec(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at_ms) VALUES (99, 'ghost', 'x', 1)",
      );
    } finally {
      db.close();
    }
    await withClient(undefined, async (client) => {
      await expect(client.migrate()).rejects.toMatchObject({ code: "migration_invalid" });
    });
    const db2 = openState();
    try {
      db2.exec("DELETE FROM schema_migrations WHERE version = 99");
    } finally {
      db2.close();
    }
  });

  it("注入的失败 Migration 回滚；同目录随后用合法注册表续跑", async () => {
    const broken: MigrationDefinition[] = [
      STATE_MIGRATIONS[0] as MigrationDefinition,
      { version: 2, name: "broken", sql: "CREATE TABLE broken (this is not sql" },
    ];
    await withClient({ state: broken }, async (client) => {
      await expect(client.migrate()).rejects.toBeInstanceOf(Error);
    });
    // 断点续跑：版本 1 已应用且 checksum 未变，内建注册表直接就绪。
    await withClient(undefined, async (client) => {
      await client.migrate();
      await client.ensureSession({
        sessionId: "11111111-1111-4111-8111-111111111111",
        createdAtMs: 1,
        trace: { traceId: "0123456789abcdef0123456789abcdef" },
      });
    });
  });

  it("v2 → v3 真实升级：0003 回填既有生命周期事实（五轮评审修复 2）", async () => {
    dataDirectory = createTempDataDirectory("bellis-p2-mig-upgrade-");
    // ---- 旧版构建（0001/0002）建库：提交 Scene A + 落库生命周期事实 ----
    await withClient(
      {
        state: [
          STATE_MIGRATIONS[0] as MigrationDefinition,
          STATE_MIGRATIONS[1] as MigrationDefinition,
        ],
      },
      async (client) => {
        await client.migrate();
        await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 1, trace: TRACE });
        await client.commitScene({
          sceneId: sceneId(1),
          cycleId: cycleId(1),
          sessionId: SESSION_ID,
          scene: makeScene({ sceneId: sceneId(1), cycleId: cycleId(1) }),
          idempotencyKey: "upgrade-1",
          requestFingerprint: "fp-1",
          watermarks: [],
          outbox: [],
          trace: TRACE,
        });
      },
    );
    // 生命周期 Record 以原始 SQL 落库：0003 之前的构建没有索引写侧
    //（现 repo 的 appendRecord 在 v2 库会因 active_scenes 缺表而失败，
    // 正如旧版二进制不含索引写侧）。
    const db = openState();
    try {
      insertLifecycle(db, { n: 1, to: "scheduled", occurredAtMs: 2000 }); // 在途（已提交）
      insertLifecycle(db, { n: 2, to: "running", occurredAtMs: 2100 }); // 在途（未提交）
      insertLifecycle(db, { n: 3, to: "completed", occurredAtMs: 2200 }); // 终态 → 无行
      insertLifecycle(db, { n: 4, occurredAtMs: 2300, payload: "not json" }); // 坏 payload → unknown
      insertLifecycle(db, { n: 5, to: "scheduled", occurredAtMs: 1000 }); // 最新记录为终态
      insertLifecycle(db, { n: 5, to: "completed", occurredAtMs: 2400 }); //   → 无行
      insertLifecycle(db, {
        n: 6,
        to: "running",
        occurredAtMs: 2500,
        payloadVersion: 2, // 未知 payload 版本 → unknown（不静默当作已知格式）
      });
      // aggregate sequence 权威（与写侧一致）：seq=2/completed 墙钟反而
      // 更早（2800 < 3000）——墙钟排序会错误保留 running 行。
      insertLifecycle(db, { n: 7, to: "running", occurredAtMs: 3000, aggregateSeq: "1" });
      insertLifecycle(db, { n: 7, to: "completed", occurredAtMs: 2800, aggregateSeq: "2" });
      // 伪 UUID payload（36 位形状但非十六进制）：不可信 → unknown，
      // sceneId 归属回退 aggregate 前缀（绝不被采信为已知 running）。
      insertLifecycle(db, {
        n: 8,
        to: "running",
        occurredAtMs: 2900,
        payloadSceneId: "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz",
      });
    } finally {
      db.close();
    }
    // ---- 升级：完整注册表只应用 0003 并回填 ----
    await withClient(undefined, async (client) => {
      await client.migrate();
      const active = await client.listActiveScenes(SESSION_ID);
      expect(active).toEqual([
        {
          sceneId: sceneId(1),
          cycleId: cycleId(1),
          state: "scheduled",
          updatedAtMs: 2000,
          durable: true,
          durableCycleId: cycleId(1),
        },
        {
          sceneId: sceneId(2),
          cycleId: cycleId(2),
          state: "running",
          updatedAtMs: 2100,
          durable: false,
          durableCycleId: null,
        },
        {
          sceneId: sceneId(4),
          cycleId: null,
          state: "unknown",
          updatedAtMs: 2300,
          durable: false,
          durableCycleId: null,
        },
        {
          sceneId: sceneId(6),
          cycleId: null,
          state: "unknown",
          updatedAtMs: 2500,
          durable: false,
          durableCycleId: null,
        },
        {
          sceneId: sceneId(8),
          cycleId: null,
          state: "unknown",
          updatedAtMs: 2900,
          durable: false,
          durableCycleId: null,
        },
      ]);
    });
    const db2 = openState();
    try {
      expect(db2.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
      ]);
      // 历史生命周期事实原样保留（回填只读不改写）。
      expect(
        db2
          .prepare(
            "SELECT COUNT(*) AS n FROM session_records WHERE record_type = 'scene_lifecycle'",
          )
          .get(),
      ).toEqual({ n: 10 });
    } finally {
      db2.close();
    }
  });

  it("telemetry.db 具备底座表且与 state.db 相互独立", async () => {
    const db = new DatabaseSync(join(dataDirectory, "telemetry.db"));
    try {
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'telemetry_events'").get(),
      ).toBeDefined();
      const rows = db.prepare("SELECT version FROM schema_migrations").all();
      expect(rows).toEqual([{ version: 1 }]);
      expect(TELEMETRY_MIGRATIONS.length).toBe(1);
    } finally {
      db.close();
    }
  });
});
