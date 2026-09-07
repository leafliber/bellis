# ADR 0026：检查点受阻时停止后续 WAL 写入

状态：事务边界写入拦截已实现；目录硬上限与确认专用物理预留仍开放。日期：2026-09-07。

## 决策

在 ADR 0024 的新工作准入与 ADR 0025 的数据库页限制之外，Worker 为 state、telemetry 各自检查真实 WAL 文件大小。Runtime `persistence.walHighWaterBytes` 与独立 Client `diskAdmission.walHighWaterBytes` 默认 64 MiB，允许 16 MiB 至 1 TiB。

连接不在事务内且 WAL 达到阈值时，尝试 `wal_checkpoint(TRUNCATE)`。仅在此次维护期间将 busy_timeout 设为 0，并在 finally 恢复 3000 ms。被旧快照占用的 WAL 不会导致 Worker 等待三秒；读取状态再次尝试回收，因此释放旧快照后 ready 可以自行恢复。

SQLite authorizer 区分读取和实际写操作，避免仅按 SQL 前缀或 run/get/all 方法推测。已准备的语句保存写属性，每次执行重新检查；CTE、RETURNING、触发器及 exec 也经过检查。显式事务在第一次实际写入时取得本事务的写入资格；已开始写入的事务继续完成或回滚。未能回收且达到阈值的后续写事务、自动提交写入返回安全 `storage_not_ready`，不修改原状态或 revision。只读事务、COMMIT、ROLLBACK 与 SAVEPOINT 清理仍可执行。

`readDiskStatus()` 报告每库共用的 `walHighWaterBytes`；任一 WAL 达到阈值且未被回收时 reason 为 `wal_pressure`，ready 为 false。该状态优先于页容量和目录软高水位。后台 Provider 状态、Outbox 与其他经过适配器的写入同样受到拦截；该阈值不是仅面向新 Cycle/Scene 的软准入开关。

## 实际验证

真实公共 Provider 状态接口在只读连接持续占用旧快照时反复改写大状态，直至返回容量错误。重复尝试后 WAL 文件长度保持不变，原已提交状态和 revision 可读，状态为 not-ready。释放快照后检查点截断文件、ready 恢复，写入成功且重启读回一致。

两个数据库分别验证缓存 UPDATE、CTE UPDATE RETURNING 的 get/all，以及 exec 都无法绕过拦截；同一压力状态下仍可执行只读事务和回滚。测试不修改配额、交付 ACK 或 Core 数据库。具体运行结果见实施记录。

## 未覆盖的上限

这是后续写入的阈值拦截，**不是 WAL 字节硬上限**。一次已取得资格的事务可能跨越阈值，缓存 spill、单事务写入量、迁移和临时文件的最坏分配仍须另行约束。本轮不关闭 spill，也不以可能非常大的内存增长换取未经验证的单事务界限。SQLite 官方说明 [cache_spill](https://www.sqlite.org/pragma.html#pragma_cache_spill) 控制事务中的脏页溢写；[journal_size_limit](https://www.sqlite.org/pragma.html#pragma_journal_size_limit) 也不能代替受阻检查点下的实时硬上限。

达到本阈值时，尚未开始写入的完成/取消确认也会暂停并保留待重试事实；它们尚无独立物理预留。不能用本轮通过替代四个活动计划、每计划 32 个片段、八个 Provider 的最坏确认分配证明，或完整的崩溃/旧备份/磁盘耗尽恢复矩阵。外部写者不经过此连接时不受此拦截约束；生产所有权仍由单 Worker 约定和独占守卫限定。
