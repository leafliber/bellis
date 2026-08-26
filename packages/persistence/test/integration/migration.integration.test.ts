import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createPersistenceClientForTesting } from "../../src/client/persistence-client.js";
import type { PersistenceClient } from "../../src/index.js";
import { STATE_MIGRATIONS, TELEMETRY_MIGRATIONS } from "../../src/migrations/registry.js";
import type { MigrationDefinition } from "../../src/migrations/definition.js";
import { WORKER_FIXTURE, cleanupTempDataDirectory, createTempDataDirectory } from "../helpers.js";

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
      expect(rows).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
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
