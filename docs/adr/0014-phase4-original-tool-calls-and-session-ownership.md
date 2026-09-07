# ADR 0014：原始工具调用恢复与 Session 所有权

状态：基础路径已实施；Iris 实际请求冻结与未知结果对账仍待交付。日期：2026-09-06。

## 问题

Phase 3 的 planned 行仅有工具名称及幂等键摘要，重启后无法恢复原始参数和业务键。重复 adoption 还可以省略工具列表而被当作成功。宿主绑定 Stage 的真实 Session 时，Loop 的工具上下文仍保留启动占位 Session；管道也没有恢复新 Session 的未消费输入。

## 决策

1. Migration 11 在独立 `phase4_tool_calls` 表保存原始 `ToolCall` JSON、SHA-256 和字节数，主键及外键绑定 Session/Tool Run。宿主在 Cycle adoption 同一事务中写入；身份、工具名或幂等键摘要不符时，Cycle、planned 行、调用正文及水位全部回滚。正文最多 64KiB，全部正文最多 8MiB、4096 行。容量耗尽拒绝新采用，不淘汰尚待处理的调用。
2. `phase4ReadToolCall(sessionId, toolRunId)` 是可信持久层的逐项读取接口，返回前复核正文摘要、长度及 planned 身份。它不将正文加入审计、模型请求或整个恢复状态列表。旧 Phase 3 调用没有正文时返回 null，不从摘要推测参数。
3. adoption 重放必须保持原 packet 摘要、工具集合、身份、原始参数和幂等键；省略或修改调用均拒绝。原始 JSON 按当前协议解析顺序比较，恢复直接使用保存值，不重新构造键顺序或业务键。读取与重放不会自动执行工具；running 在恢复后仍标为 uncertain。
4. 只有尚未接收输入、没有恢复事实且没有活动 Turn 的占位宿主可以绑定另一 Session。绑定后重新创建管道并恢复目标 Session；后续 ingest 和恢复读取等待该过程完成。输入进入异步 append 前即固定所有权，避免绑定穿过尚未完成的写入。已有工作切换 Session 必须创建新的宿主；同一逻辑 Session 重连可以复用。
5. Loop 在 Turn 开始时捕获可信 Session ID，采用和整个 Turn 的工具执行沿用它。采用适配器拒绝 Session 已变化的调用，Tool Runtime 的持久运行事件携带执行上下文的 Session。演出宿主在绑定回调拒绝时恢复原 Session，生命周期仓储也只在决策宿主接受后改绑。

## 验证与边界

真实 DB Worker 测试覆盖重启后的原参数/原键读取、running→uncertain、跨 Session 查无结果、改变参数/键/工具集合的重放拒绝、身份与大小错误整事务回滚、旧行 null、审计不含正文。真实宿主测试预先写入目标 Session 的未消费 Signal，从空占位 Session 改绑后恢复输入，证明工具上下文、采用和运行记录均属于目标 Session。异步 append 单元测试验证已有输入拒绝改绑。

本表保存的是原始模型调用，不是已经注入可信 actor/scope/purpose/expected revision 的 Iris 请求；它不满足完整的写调用恢复 Gate。后续需冻结并持久保存实际公共 SDK 请求，提供确认策略、业务幂等键、Lease 及未知结果对账；未经这些步骤，不开放 Iris 写工具。隐私变更下待消费 Signal/Tool Result 的过滤、Core Session 映射、真实删除/Legal Hold/外部失效、全库/WAL/审计配额、A4 崩溃矩阵及 Phase 4B 均仍待完成。
