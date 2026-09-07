# Phase 4：Observe、持久化与恢复

> 原构建计划的主题分册，保留原章节编号；章节目标不等于已交付能力。当前事实见 [实施状态](../../phase-4-implementation-status.md)，恢复 Gate 以 [ADR 0047](../../adr/0047-phase4a-recovery-scope-freeze.md) 为准。
> [返回构建指南](../../phase-4-development-guide.md)。跨分册的 § 引用按构建指南目录定位。

## 9. P4：Observe Outbox、持久化与恢复

### 9.1 Observe 事实边界

只有已提交事实可以观察：

- 已采用 Cycle 的 Context Manifest 摘要与 DecisionPacket 摘要；
- 已结算 Tool Result；
- Scene commit 只记录调度意图，不携带未来播放确认。Phase 4 新增独立的 Stage effect/progress 确认事实（具体 Wire 形态由 P0 冻结），确认包含 session/connection generation、scene/cue、segment 范围与幂等身份；
- assistant Observe 仅来自已持久化的确认范围。completed 使用已确认部分；部分播放后 cancelled/failed 仍只观察已确认前缀；零确认或重启后无法证明的内容不得推断为已播放；
- 接收确认后，在同一持久化事务中写 effect record 和 Observe 投影。旧 Scene commit/lifecycle 记录与历史协议不改写，不从完整计划文本推导播放事实（ADR 0006 替代 ADR 0005 决策 4 的提交时机）；
- 用户显式 remember/correct/forget 的采用与执行结果；
- 必要的 Audience/World 摘要，且先经过 privacy policy。

输入观察从可信 Signal 受理/持久化事实产生，身份包含 `(sessionId, Signal.source, Signal.id)`，重试去重；不得等模型采用后才把已收到输入当事实。原始输入与模型摘要区分来源，只有获准的内容进入 Core。

效果确认的最小目标是：绑定 Session、连接代际、Scene/Cue、Lane、已准备内容摘要、segment ID/范围和唯一 receipt；Runtime 验证其属于实际提交且可确认的输出，正文从已冻结 segment 映射提取，不采信客户端另传自由文本。音频 segment 以 Worklet 已渲染边界确认，字幕以实际应用确认；P0 冻结同一语义片段的指定 Lane/组合策略，防止字幕和音频重复记账。只能确认完整 segment 时，宁可不记最后未完成部分，也不按预计时长虚构文本前缀。

每次只投递尚未观察过的已确认增量，禁止把累积前缀反复记成新事实；partial 必须映射 `effect_proof.confirmed_range`，完整 committed 不发送该字段。取消后的迟到确认仅可作为独立、可验证的效果事实，不改写 Director 终态。只有传输 ACK、scene.started 或 scene.ended 时都不能推导未确认正文。

模型 delta、未采用候选 Context、未提交 Prepare、逐帧 Avatar 参数、音频采样和原始敏感正文不得进入 Observe。

### 9.2 Outbox 语义

- 在产生对应已提交事实的事务内写入 `memory.observe.v1` Outbox；
- 在 Cycle adoption 记录 Manifest 的同一事务内写入 `memory.usage.v1` Outbox，
  携带 returned / hostSelected / modelVisible 三个集合，fan-out 给声明了
  `usageReport` capability 的 Provider（决策 5）；
- `outboxId` 负责交付去重，业务幂等键负责 Provider 写入去重；
- 一个 Outbox 可以按 Provider fan-out，但每个目标状态必须独立记录；
- Provider 成功、可重试失败、永久拒绝和隐私撤销必须显式区分；
- 重试采用有界退避和最大尝试，最终进入 dead 并可对账；
- 内存 Claim/在途请求有界，已持久化 pending 使用独立磁盘配额，不因内存 Claim 已满而阻塞已有 Scene 的确认提交；
- 磁盘达到高水位时停止新 Cycle adoption/新场景准入，已活动 Scene 的完成/取消确认使用预留配额。P0 必须按最大活动 Scene 数和有界确认片段数计算预留，并验证恢复；配额耗尽时进入明确 not-ready，不承诺无限持续输出，也不删除未确认交付的行；
- dead 记录保留可对账身份，TTL 或最大尝试只触发显式 dead/运维状态，不静默清空。隐私撤销另按已冻结 tombstone 策略记录；
- Session 关闭停止新 Claim，在 Grace 内等待后中止；Lease 到期负责跨重启回收。

Iris 投递优先复用 `packages/persistence` 的 Outbox/Dispatcher，增加按 topic 路由的真实 Memory Publisher；现有只录制 scene.committed 的 Publisher 不接收 Memory topic。单 Provider 初期可每事件一条目标行，后续 fan-out 独立结算。

每个 source stream 只有一个逻辑投递序列；同 stream 未确认的较小 cursor 必须先处理，不能依靠当前按 available_at/outbox_id 排序的 Claim 保序。其他 stream 可在总并发上限内推进。Observation cursor 在事实投影事务内连续分配，业务 eventId/record idempotency_key 使用含宿主命名空间的稳定身份；不复用 Control Seq 或临时进程 ID。

Core Batch 最大 100 条，整批非法则零写入。A2 冻结有界批次清单、固定顺序、不可变 payload 与 ≤256 字符的幂等键；不能以不断拼接所有 outboxId 生成超长 key，也不能同 key 重排正文。对非法成员做显式隔离/诊断，剩余项若重组使用新的批次身份但保持原记录业务键。

在已校验 accepted/duplicate ACK 后才结算对应目标；保留 Core ACK 摘要与 agent watermark，不能把 source_watermark 用作 Recall minimum_watermark。当前通用 `observe(): Promise<void>` 可保持，Iris 的 ACK/对账元数据需经受控状态 Port 保存；如需跨宿主共享再由 A0 扩契约，不依赖随时丢失的诊断回调。ACK 丢失或本地保存失败按原键重试。

当前已实现实际 DB/WAL 占用驱动的新工作准入与 ready 状态，见 [ADR 0024](../../archive/phase-4/decisions/0024-phase4-disk-admission.md)；数据库页分配另受 [ADR 0025](../../archive/phase-4/decisions/0025-phase4-database-page-limits.md) 的连接级硬限制。检查点受旧快照阻塞时的后续写入拦截见 [ADR 0026](../../archive/phase-4/decisions/0026-phase4-wal-write-fence.md)。单次提交缓存检查与当前 Worker 写入的 WAL 边界见 [ADR 0027](../../archive/phase-4/decisions/0027-phase4-transaction-capacity.md)；活动 Scene 的独立持久收尾额度、最大形状测试与确认事务崩溃窗口见 [ADR 0028](../../archive/phase-4/decisions/0028-phase4-completion-reservations.md)；整个目录上限、操作系统实际耗尽与完整恢复矩阵仍未证明，不替代上述完整容量 Gate。

### 9.3 Migration 与恢复

建议新增 Migration，至少覆盖：

- Context Manifest 与采用引用；
- Memory Block/revision/tombstone 和 identity/privacy scope；
- Provider state、cache metadata 与失效事件；
- 已验证人格缓存（agentId / revision / contentHash / 渲染输入）与独立 effect/progress
  确认记录、片段范围和 Observe 投影；
- Observe target delivery 状态、attempt、lease、error code 和业务幂等键；
- Presence seed、行为目录 revision 和仅需重放的高层选择记录。

恢复规则：

- 已采用 Cycle 读取已记录 Manifest，不重新召回后替换；
- pending/in-flight Observe 按 Lease 恢复，Provider 按业务键幂等；
- 结果未知的非幂等 Memory 写入标记 `uncertain`，绝不自动重试；
- tombstone/privacy revision 在恢复早期装载，先于 Context cache 开放读取；
- Presence 不恢复过期 Timer 或动作进度；使用新单调时钟从安全 Base 状态启动；
- Directed Scene 的恢复继续服从 Phase 2 规则，不由 Presence 擅自补播。

Iris 对账必须覆盖 remote < local、remote > local、remote=null、gap_policy 变化、已删除事实和 host/Core 任一侧恢复旧快照。读取每 stream 的宿主不可变日志/目标 ACK 与 Core sourceCursor，补投已确认且仍被允许的未 ACK 事实；远端领先先核对是否为 ACK 丢失/另一个实例/旧宿主备份，不按远端最大值批量标记 delivered。不可修复的缺口隔离该 stream，并保留可操作的对账记录。

恢复先加载 Persona 撤销、privacy/tombstone 和身份映射，再开放 Context；随后恢复 Outbox 与 SSE pending invalidation。需 minimum_watermark 保证可见时使用已验证的 Core agent watermark，Core 投影落后则显式 partial/降级，不把持久 Observe ACK 当成立即可 Recall 的保证。Snapshot/审计恢复不自动重问模型、重播 Scene 或重放结果未知的非幂等工具。
