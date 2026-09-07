# Phase 4 存储容量

本页将原 ADR 0024–0028 的增量实现按同一容量模型整理。历史原文和证据完整保留在 [决策归档](../../archive/phase-4/README.md)；归档不撤销已实现的约束，本文也不扩大验收结论。

## 已实现的约束

| 层次 | 行为与取舍 | 历史依据 |
| --- | --- | --- |
| 新工作准入 | 读取真实 DB/WAL/SHM 占用及文件系统余量；新 Signal、adoption、准备和 commit 在事务中检查；已确认事实与原身份重试保留 | [0024](../../archive/phase-4/decisions/0024-phase4-disk-admission.md) |
| 数据库页限制 | 对 state/telemetry 连接应用 `max_page_count`；FULL 回滚保持原状态，超额启动关闭连接和锁 | [0025](../../archive/phase-4/decisions/0025-phase4-database-page-limits.md) |
| WAL 写入拦截 | 检查点被旧快照阻塞且达到阈值时，拦截后续普通写事务；读取仍可用，释放快照后重新判断 | [0026](../../archive/phase-4/decisions/0026-phase4-wal-write-fence.md) |
| 单事务预算 | 禁用 cache spill，并使用同一 SQLite 的原生 progress/commit 检查限制缓存与 WAL 单次增量 | [0027](../../archive/phase-4/decisions/0027-phase4-transaction-capacity.md) |
| Scene 收尾额度 | Migration 16 将未用绑定、确认和关闭额度随准备持久化；普通写入必须保留该额度，收尾事实与扣减同事务提交 | [0028](../../archive/phase-4/decisions/0028-phase4-completion-reservations.md) |

这些约束分别处理准入、页分配、WAL 增长和已接纳工作的收尾，不能用其中一个阈值代替其他层。配置说明见 [运行说明](../../guides/iris-runtime.md)，规划中的完整容量要求见 [持久化构建分册 §9.2](../../plans/phase-4/guide/persistence.md)。

## 恢复事实与验收边界

重复确认和关闭不重复扣减；重启不恢复旧 Stage 为活动演出，而是使用原关闭额度释放余额、保留已提交回执和 Outbox。已有专项覆盖最大形状、外部快照阻塞、跨 Worker 重启及确认事务提交前后的本地崩溃。见 [收尾预算证据](../../evidence/phase4-completion-reserve-probe.json) 和 [恢复压力证据](../../evidence/phase4-completion-restart-pressure-probe.json)。

逻辑预算没有向操作系统预分配独占磁盘块。其他进程占用空间、真实 ENOSPC、文件系统分配开销、旧备份与完整 Core/Stage 进程组合仍需独立证明。根据 [ADR 0047](../../adr/0047-phase4a-recovery-scope-freeze.md)，这些扩展由 [Phase 4B 待办](../../plans/phase-4/backlog.md) 管理，不作为冻结 Phase 4A 恢复 Gate 的前置条件。
