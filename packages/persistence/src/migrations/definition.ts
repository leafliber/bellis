/**
 * Migration 定义（P2 文档 §6.2）。
 *
 * SQL 文本内嵌在版本化 TS 模块中而不是独立 .sql 文件：tsc 不会复制 .sql
 * 到 dist，而 Migration 必须随包产物发布（“构建必须确保 SQL 文件进入包
 * 产物”）。规则等价：注册表按 version 排序，checksum 对 SQL 文本计算
 * SHA-256，已合入 Migration 不允许原地改写（checksum 会失配并拒绝启动）。
 */

export interface MigrationDefinition {
  /** 固定宽度递增版本，从 1 开始，不允许缺口。 */
  readonly version: number;
  /** 稳定名称（与源文件名对应，如 "initial"）。 */
  readonly name: string;
  /** 完整 SQL 文本；在单个事务中执行。 */
  readonly sql: string;
}

/** 校验注册表：严格递增、从 1 开始、无重复、无缺口。 */
export function validateMigrationRegistry(migrations: readonly MigrationDefinition[]): void {
  let expected = 1;
  for (const migration of migrations) {
    if (migration.version !== expected) {
      throw new Error(
        `migration registry invalid: expected version ${expected}, got ${migration.version} (${migration.name})`,
      );
    }
    if (!Number.isInteger(migration.version)) {
      throw new Error(`migration version must be an integer: ${migration.name}`);
    }
    expected += 1;
  }
}
