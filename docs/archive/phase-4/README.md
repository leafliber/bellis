# Phase 4 历史归档

此目录冻结保存实施过程，不再追加执行切片。原 ADR 编号不重用，原决策正文保留；移动位置不表示撤销兼容性约束。当前主题入口为 [存储容量](../../phase-4/storage-capacity.md)、[历史恢复](../../phase-4/history-recovery.md)，当前状态见 [实施状态](../../phase-4-implementation-status.md)。

- [实施历史](./implementation-history.md)

## 历史决策与切片记录

- [ADR 0024：SQLite 实际占用与新工作准入](./decisions/0024-phase4-disk-admission.md)
- [ADR 0025：数据库页硬限制与空间耗尽回滚](./decisions/0025-phase4-database-page-limits.md)
- [ADR 0026：检查点受阻时停止后续 WAL 写入](./decisions/0026-phase4-wal-write-fence.md)
- [ADR 0027：连接级事务容量与 WAL 单次增量](./decisions/0027-phase4-transaction-capacity.md)
- [ADR 0028：活动演出的持久收尾额度](./decisions/0028-phase4-completion-reservations.md)
- [ADR 0029：SSE 恢复游标的事件身份](./decisions/0029-phase4-event-checkpoint-identity.md)
- [ADR 0030：历史缺口的宿主持久屏障](./decisions/0030-phase4-history-gap-barrier.md)
- [ADR 0031：历史重验的持久范围清单](./decisions/0031-phase4-history-revalidation-inventory.md)
- [ADR 0032：Claim 纠正的事务内失效通知](./decisions/0032-phase4-claim-correction-events.md)
- [ADR 0033：Recall 发布与重放的 Canonical 核验](./decisions/0033-phase4-recall-replay-revalidation.md)
- [ADR 0034：原 Recall 请求的批量重验](./decisions/0034-phase4-recall-batch-revalidation.md)
- [ADR 0035：实际 Recall 请求的持久准备记录](./decisions/0035-phase4-original-recall-requests.md)
- [ADR 0036：历史清单的核验批次与逐项结论](./decisions/0036-phase4-history-verification-records.md)
- [ADR 0037：原 Recall 请求的受控核验调度](./decisions/0037-phase4-recall-revalidation-coordinator.md)
- [ADR 0038：持久恢复发现与宿主取消归属](./decisions/0038-phase4-history-recovery-discovery.md)
- [ADR 0039：受控后台历史核验](./decisions/0039-phase4-background-history-recovery.md)
- [ADR 0040：Runtime 启动与运行期历史恢复状态](./decisions/0040-phase4-runtime-history-recovery.md)
