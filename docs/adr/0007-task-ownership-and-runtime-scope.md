# ADR 0007：任务所有权、恢复事实与当前能力收敛

> 状态：Accepted；实现与验证状态见 `docs/guides/build-and-validation.md`。
>
> 日期：2026-09-06
>
> 本决策修订 ADR 0001/0003/0004/0005/0006 中与下述内容冲突的执行、传输和扩展语义；历史 ADR 保留原始决策。Node 基线与数据库 Worker 隔离不变。

## 1. 单一任务所有者

Decision Trigger 的有界 Mailbox 是唯一等待队列。Loop 同步登记接受的 Turn，忙碌时拒绝另一个 Turn，interrupt 先取消并回收未采用输入，再由 Mailbox 等待当前 Turn 释放。关闭取消所有已接受任务，不能在 close 后启动模型或提交决策。

Tool Runtime 拥有整次调用列表的生命周期，包括排队和后台节点；前台完成只解除调用者的等待，调度持续到全部节点结算。父取消与 Runtime close 必须结算未启动节点并中止运行节点。

Scene Director 的终态不可被迟到的数据库完成、发送完成、Stage 回执改写。每个异步边界后检查执行是否仍有效；数据库提交不能撤回时，保留已经完成的事务事实并停止后续输出。uncertain 是当前执行的终态，后续人工/恢复对账使用独立记录。

## 2. 工具执行事实与审计分离

Tool Run 的开始和结束属于恢复事实，使用可等待的持久化 Port。开始事实成功落库后才调用工具；开始写失败不得产生副作用。结束写失败向调用者显式报告，磁盘中的 running 留给恢复转换为 uncertain。普通日志和指标仍可尽力写入；不能吞掉关键状态写入失败并报告成功。取消、拒绝、缓存命中等路径也要留下结算事实。

Cycle adoption 后、dispatch 前崩溃仍不自动重问模型、不重播外部动作。这是至多一次派发的取舍；已消费不等于已完成，不能据此宣称外部效果恰好一次。

## 3. 收窄工具执行计划

当前只支持最多八个无显式依赖的工具调用，按输入顺序返回前台结果，保留并发上限、资源互斥、权限、取消和有界缓存。非空或非法 dependsOn 明确拒绝，不静默忽略。需要前一步结果的工作进入下一 Cycle。compileDag/executeDag 暂保留为源码兼容名称，不表示已经支持通用 DAG；环检测、拓扑深度和背景依赖均不属于当前能力。

## 4. 场景准备与结束

Stage 拥有各 Lane 的准备任务和超时；hard Lane 受整场准备 Deadline 约束，soft Lane 受更短的 softTimeoutMs 约束，超时中止并报告 unavailable。Runtime 对有界的整包 ready 做纯结果检查；不再保留未接通的增量 Barrier 等待机制。缺省 softTimeoutMs 为 500ms，编译结果显式携带模型 SyncPolicy 的值。

Commit 只启动已准备的 Lane；缺席或迟到丢弃也必须产生明确结束结果，不能留下等待者。场景执行有独立的有界结束等待，超时走取消/uncertain，不能凭时间经过宣称效果完成。detached 输出不在本轮扩展；遥测与记忆写入由宿主后台任务承担。

scene.started 必须来自 Lane 的实际开始确认；音频由 Worklet 确认，DOM 输出在应用后确认。Runtime 按 scene+lane 汇总，不把单个 Lane 与自身比较当作同步证明。调度时间、Worklet 渲染确认和设备物理发声不是同一测量；不得以调度指标证明端到端 P95/P99。

## 5. Control 序号的兼容性优化

本轮保留现有 Wire、ACK 与同进程 Replay，通过一次持久化预留 1024 个 Seq，消除逐帧写库。sessions.latest_server_seq 改为已持久预留上界，可能大于实际发送序号，不能用作业务完成游标。消息使用已预留区间时无需写库；区间不足先扩展再发送，扩展失败关闭连接。

同进程重连保留实际 nextSeq、ACK 与 Replay；跨重启跳过未使用的预留区间，从上界之后开始，历史缺口走 Snapshot。旧数据库的精确水位可作为初始预留上界，无需回写历史 Migration。区间必须先落库，绝不能改成发送后批量补写。epoch+seq 暂不引入；只有需要更换跨进程恢复模型时再升级 Wire。

## 6. 宿主与 Provider 接缝

Decision Host 接受工具注册函数；无注入时工具目录为空。Demo 工具和固定 TTS 在启动/测试入口显式选择。验收 recorder 可选且有界，宿主不保留无限历史。演出服务依赖流式 TTS Port，Media Sender 逐帧拉取并传播取消；Fake Provider 只是该 Port 的确定性实现。真实商业 Provider、模型输出结束前的推测 Prepare 和首音频统计验收仍需单独交付，不能由接口存在推导完成。

Memory 的最小贡献只要求身份、版本与有界内容块；召回路由、人格关联、租约等特有信息是可选扩展。PersonaSource 保持独立，纯检索 Provider 不需要伪造人格版本。Iris 保留真实元数据并验证兼容性。

Phase 4 先交付一个 PersonaSource、一个 MemoryProvider、一次确认输出后的 Observe；先在宿主功能模块中验证职责，再依据独立使用需求拆包。多 Provider fan-out、完整注册治理和四个新 Runtime 包不再是首条纵向链路的前置。

## 7. 验证与保留边界

回归覆盖接受后立即关闭、连续 interrupt、后台排队后前台返回、状态写失败、durable 期间断线、soft 准备超时、迟到丢弃、逐 Lane 开始聚合、Seq 预留跨重启与扩展失败、无 Demo 注入及简易 Memory Provider。完成态文档只记录已运行的证据。

保留单一决策权、纯 Compiler、关键事务与 Outbox、DB Worker、跨端单调时钟和未知结果不自动重放。这些边界服务于已经存在的外部副作用和跨端执行。
