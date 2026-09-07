# ADR 0012：Provider 状态与 Persona 持久读屏障

状态：已实施 A3 人格切片，完整隐私/遗忘 Gate 仍未关闭。日期：2026-09-06。

## 问题

删除进程内 Persona 缓存不足以表达撤销。刷新失败、写盘失败或进程重启后，旧缓存和静态兜底可能重新进入模型上下文。宿主超时也不能证明 Provider 已经停止底层请求，直接释放并发名额会使后台重试持续堆积。

## 决策

1. `MemoryProviderContext.stateStore` 是宿主拥有的可选持久状态端口。Runtime 通过现有 DB Worker RPC 提供它；Migration 9 按业务 appInstanceId、agent、space、identity scope、privacy domain 的摘要与 Provider ID 隔离。连接随机 ID、Session 重连和 privacyRevision 不改变此键。它不是授权判断或长期记忆事实源。
2. 每个状态版本递增并以预期版本写入。旧写者不能覆盖新状态；相同预期版本、相同内容的 ACK 丢失重试仅在精确后继版本确认幂等。读取校验 JSON 字节数与 SHA-256。最多 128 行、每行 256KiB、总正文 8MiB；容量耗尽拒绝写入，不驱逐屏障。这不是整个数据库、WAL 或历史账本的磁盘上限。
3. 默认 Iris 装配采用宿主端口。独立运行保留内存 Store；显式指定的 `stateStore` 保留调用方选择。恢复前校验 version 1 元数据，其可选 `personaBarriers` 保存最低合法发布版本、已验证版本/摘要、失效原因和事件 cursor。普通缓存、事件 cursor 和 Observe 源 cursor 各司其职。
4. 失效先在内存封锁并取消尚未采用的宿主 Context，再持久登记；事件处理等待登记和权威刷新成功后才推进已处理 cursor。刷新失败保留屏障，不能使用已验证缓存或同身份 staticPersona。撤销版本 N 后只接受合法发布版 N+1 或更高版本；普通失效可以由同版本、同摘要的权威 live 响应解除。授权失败也登记屏障。
5. 新 Persona 只有通过发布状态、身份、摘要、版本下限和持久保存检查后才可读取。失效过程中到达的旧刷新响应不能安装；保存失败重新封锁。没有事件能力或有限事件流暂时为空时，也执行有界后台 current 重验，覆盖瞬时 state 更新；版本与摘要不变时不翻转 Prompt Epoch。
6. Iris 网络操作默认最多 4 秒，可配置 1–30000ms。每种操作最多一个底层在途调用；Observe/Usage 共用投递名额。调用超时后，底层 Promise 尚未结束就保留名额。Runtime 的 Memory Publisher 同样保留每个 Provider 的投递名额。stop 取消后台网络请求；迟到响应不能安装 Persona，释放 Surface Lease 使用独立的有界清理请求。结果未知的远端写仍由原 Outbox 身份重试。

## 验证与未关闭范围

Provider 故障注入覆盖文件恢复、SSE 刷新失败、撤销后旧版重现、协商授权失败后的离线启动、迟到刷新、持久保存失败、非协作请求与无事件能力的 state 更新。DB Worker 集成覆盖重启、跨范围读取、ACK 丢失重试、旧写者和容量边界。真实 Core/Stage 短闭环另验证宿主状态端口、Recall、Persona、Observe、Usage 和输出确认兼容。

这些证据不等于完整 A3/A4：通用资源 tombstone、隐私策略 generation 的 adoption 事务复核、旧 Observe/Usage 与确认历史的抑制、Iris 四工具、历史不足/旧快照恢复和双进程崩溃矩阵仍需实施。主线程默认 Session 与 Stage 后续绑定之间的恢复隔离也尚待关闭。只有 Surface `off` 有真实服务证据。
