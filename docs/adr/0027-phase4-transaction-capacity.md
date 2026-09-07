# ADR 0027：连接级事务容量与 WAL 单次增量

状态：已接入并验证原生提交检查；确认专用预留和完整容量 Gate 仍开放。日期：2026-09-07。

## 决策

ADR 0026 在事务边界阻止后续写入，但单个已准入事务仍能反复溢写并扩大 WAL。本轮为两个业务连接禁用 `cache_spill`，并增加小型 SQLite C 扩展，以 Node 已嵌入的 SQLite API 表读取连接缓存状态、注册 progress 与 commit hook。没有引入第二个 SQLite 引擎，也没有设置会影响其他连接的全局 heap limit。

Runtime `persistence.transactionCacheMaxBytes` 与独立 Client 的同名 `diskAdmission` 字段，默认 8 MiB，允许 4–64 MiB。该字段包含连接所有 pager cache 的字节数，包括干净页；并不是纯正文大小。每 32 条 VM 指令检查一次，提交时再次检查。超过预算的语句中断，超预算提交由 SQLite 转为回滚；两条错误路径均映射为 `storage_not_ready`。准备 SQL 时的中断若留下外层事务，适配器先回滚，再释放可回收缓存和重置 guard。清理不会把真实自动回滚后的“无事务”当成新的业务错误。

执行后的 `cache_spill=0` 会被读回核对。Worker 适配器禁止业务 SQL 设置 PRAGMA、ATTACH/DETACH 和调用扩展控制函数；SQLite 在迁移中使用的只读 quick_check/integrity_check 继续允许。固定的包内扩展加载完成后立即关闭扩展加载。缺失二进制、ABI 不兼容或容量检查无法启用时拒绝启动，没有无保护回退路径。

SQLite 的 [commit hook](https://www.sqlite.org/c3ref/commit_hook.html) 可以把提交转换为回滚；[连接状态](https://www.sqlite.org/c3ref/c_dbstatus_options.html) 提供 pager cache 用量；[cache_spill](https://www.sqlite.org/pragma.html#pragma_cache_spill) 决定事务中的脏页是否溢写。本实现使用 Node 的默认 pager，缓存页的分配量包含页内容，因而预算对待提交页内容给出保守上界。不能将这一前提移植为任意第三方 page-cache/VFS 实现的保证。

## WAL 边界

在已确认使用 WAL、关闭 spill 且独占写入的连接中，一次提交只写有界的脏页清单。报告的每库 WAL 边界为：

`walHighWaterBytes + transactionCacheMaxBytes + ceil(transactionCacheMaxBytes / pageSize) * 24 + pageSize + 65536 + 32`

额外部分覆盖 WAL 帧头、一个完整填充帧、最大 64 KiB 扇区填充及文件头。适配器沿用 ADR 0026 的阈值检查，在下一次写事务开始前回收或拒绝；`readDiskStatus().capacity` 增加 `stateWalLimitBytes` 与 `telemetryWalLimitBytes`。该边界针对经过当前连接的写入；旧二进制留下的大 WAL 或外部写者不被本实现追溯约束。旧 WAL 必须回收后才能恢复新写入。

## 构建与验证范围

`pnpm build` 使用 C 编译器构建包内扩展。SQLite 官方公开头文件已随源代码固定，构建不联网；输出与源码/头文件/平台/架构摘要写入 dist。Windows CI 增加 MSVC 环境配置，macOS 使用系统 cc。原生代码、ABI 要求及头文件来源见 [native README](../../packages/persistence/native/README.md)。Windows 实际结果仍须以远端工作流为准。

真实 SQLite 测试在一个事务中反复改写约 100 MB 的逻辑数据，验证提交前 WAL 文件不增长，提交增量落在预算以内。超预算自动提交、显式事务和 SAVEPOINT 提交都回滚，原行/revision 保留，后续小写入和重启仍可成功。两个数据库均覆盖，并以不同预算的并存连接验证隔离。既有页限制与旧快照拦截测试继续回归。

本轮根检查 1035 项单元/性质测试、240 项集成测试通过，补充的中断/RETURNING 断言经专项复验。Provider 80 项、真实 Core/Chromium 及 24 次恢复冒烟通过；完整恢复 Gate 保持未完成。见 [本轮证据](../evidence/phase4-transaction-capacity-probe.json)。

## 仍须完成

Pager cache 预算不是整个进程内存硬上限：progress 检查间隔可能短暂超调，语句临时分配和其他文件也需要独立的完整资源审计。总目录配额、已有 Scene 的完成/取消专用预留、预留恢复和 ENOSPC 故障矩阵没有因本轮变为通过。普通写入与确认仍共用额度；后续必须在这个单次提交边界基础上分配不可被后台写入侵占的收尾预算。
