# ADR 0025：数据库页硬限制与空间耗尽回滚

状态：数据库分配页上限已实现；WAL 总量及确认专用预留仍未完成。日期：2026-09-07。

## 决策与配置

在 ADR 0024 的实际文件准入检查之外，对 Worker 的两个 SQLite 连接应用 `PRAGMA max_page_count`。所有经该连接执行的写入均受限制，包括不属于新 Cycle/Scene 准入的 Provider 状态和审计写入。

Runtime `persistence` 与独立 Client 的 `diskAdmission` 新增：

```json
{
  "stateMaxBytes": 1073741824,
  "telemetryMaxBytes": 67108864
}
```

默认 state 为 1 GiB、telemetry 为 64 MiB；各字段允许 16 MiB 至 1 TiB。实际页数上限为配置字节数除以数据库 page size 后向下取整。打开连接时核对当前 page count，再设置并读取实际生效的 max page count；已有数据库大于配置时拒绝打开，不删除数据，也不自动提高限制。每次重启重新应用限制，不依赖连接退出后 PRAGMA 仍有效。

`readDiskStatus()` 新增 `capacity`，分别报告实际页上限、已分配页字节数、扣除 freelist 后的已用字节数。任一数据库距离已用页上限不足 8 MiB 时，准入状态为 `database_limit`，Runtime ready 返回 503。实际 DB/WAL 文件高水位与文件系统剩余空间检查继续独立生效；freelist 不被误报为已归还给文件系统的空间。

## 事务失败与资源所有权

SQLite 原生 `SQLITE_FULL`（基础错误码 13，含扩展码）统一转换为安全的 `storage_not_ready`。该错误既可能来自页限制，也可能来自真实磁盘耗尽，不能单靠错误码断言具体来源。

SQLite 在部分空间耗尽情形下会自动回滚整个事务，包括内部 SAVEPOINT。适配器只在收到 FULL 且确认连接已不在事务中时记录这一事实；后续 ROLLBACK、ROLLBACK TO、RELEASE 清理不再用“无事务/无 Savepoint”覆盖原容量错误。普通事务错误不会因此被忽略。下一次正常事务继续执行，失败的状态替换不推进 revision。

数据库打开过程失败时，关闭已创建的 state/telemetry 连接及 Worker 独占锁。测试特别覆盖第二个数据库超额时的失败，证明随后以足够预算重开不会遗留锁。Worker 启动失败在安全日志中显示 `storage_not_ready`；Client 通过既有启动失败通道收到 `unavailable`，并非已经成功迁移后返回的业务容量错误。

## 验证

真实 Worker 测试仅通过公开 appendRecord 接口持续写入大记录，直到 16 MiB state 上限拒绝继续分配；核对失败记录不存在，所有先前成功记录均可逐项读回。随后尝试替换原隐私屏障，验证 FULL 自动回滚仍保留原状态和 revision。关闭后检查实际 state 文件不超过配置，重启重新核对页数上限及 not-ready；提高预算后原请求可完成。

Telemetry 使用包内受控 Migration 夹具分配 32 MiB，验证 16 MiB 上限下事务失败，64 MiB 下可正常迁移；再次降低预算拒绝启动，恢复预算后仍可打开。夹具不对 Core 数据库执行 SQL。

完整检查和真实 Core/Chromium 回归见 [本轮证据](../../../evidence/phase4-database-capacity-probe.json)。无需新 Migration，既有生成契约不变。

## 完整容量 Gate 仍开放

`max_page_count` 限制数据库页分配，**不限制 WAL 文件的总长度**。两个数据库的限制也不等于整个数据目录的硬上限。更新已有页仍可能持续扩大 WAL；当前没有为已活动 Scene 隔离不可被后台写入占用的物理空间。

后续仍须约束 WAL/checkpoint 行为、证明确认与收尾最坏分配量、验证预留不会被后台状态/隐私/交付侵占，并执行完整容量和旧快照恢复矩阵。页上限内的空间仍可能被其他进程消耗，不能承诺真实 ENOSPC 后确认必然成功。降低预算、回退到未实现本限制的旧二进制或恢复旧备份，都不能被描述为已经通过完整配额验收。
