# ADR 0008：Phase 4 Iris 接入与来源校验

> 状态：Accepted（计划与设计边界）；Runtime、Provider 和契约实现待 Phase 4 A0–A4。
> 日期：2026-09-06
> 依据：本次项目负责人要求先调研 Iris，再完善 Phase 4 接入计划；[调研证据](../phase-4-iris-integration-research.md)。
> 关联：[ADR 0005](./0005-memory-provider-seam-and-persona-ownership.md)、[ADR 0006](./0006-documentation-and-delivery-boundaries.md)、[ADR 0007](./0007-task-ownership-and-runtime-scope.md)。

## 1. 交付归属与顺序

Bellis Phase 4 以现有 `providers/memory-iris/` 为首个外部 MemoryProvider 和 PersonaSource，承担兼容修复、宿主装配与真实服务验收。原计划“适配器排除于 Phase 4、由 Iris Phase 11 跟踪”不再适用。

Iris Core 独立部署并拥有长期记忆、人格发布和内部存储。Bellis 通过版本化公共 SDK/HTTP 使用这些能力；Core 无 Bellis 依赖。Core Phase 11 的历史证据可以引用，Deferred 状态不再构成本宿主工作排期的依赖；本决定不扩大 Core pip 范围或恢复 AstrBot。

先通过 A0 兼容门槛，再在 Runtime 功能模块内形成 Recall + Persona + Usage + 确认输出 Observe 闭环。MCP、多 Provider、Presence/Avatar 是后续 Phase 4 能力；不阻塞第一条真实记忆链，也不能用第一条链通过宣称整个 Phase 4 完成。本地检索器主要承担离线测试，不另建生产长期记忆事实源。

## 2. 来源摘要与文本摘要

本节修订 ADR 0005 §2.1、ADR 0006 §5 中“所有 contentHash 都能按 Provider 返回文本原始字节复核”的解释。

- `ContextBlock.contentHash` 保留 Provider 的来源摘要，不能改成宿主自己算的摘要。Core 候选 hash 可能来自结构化 revision，也可能截取其 canonical hash；不承诺它等于 SHA-256(text)。
- 宿主配置/已验证适配器声明 hash 方案及版本，不让不可信响应自行选择降级验证策略。有完整输入时按对应 canonical 方案重算；缺少结构化输入时保留来源摘要，并在 Manifest 中明确记录“来源摘要透传，未独立重算”。该状态是可信传输与来源审计，不是密码学来源认证。
- `textHash` 独立记录收到的原文 UTF-8 SHA-256，`normalizedHash` 用于规范化去重；裁剪后的模型可见文本另留摘要与裁剪记录。它们都不能冒充上游 contentHash。
- Persona Snapshot 具有完整结构化内容，仍须校验 Core canonical hash；算法版本、跨语言数值/Unicode 和内容大小是验收项。错误 hash、未知必需方案或非法快照失败关闭。
- 三类摘要及验证状态先落实到宿主 Manifest/Adapter audit；只有确需跨包共享时才由 A0/P0 扩展契约与生成物。本文不代表当前 Schema 已新增字段。

## 3. 使用血缘与交付事实

每个 Iris Recall 保留独立 requestId、原始 returned 集合和 Recall persona revision。Usage 使用该版本并满足完整回显与子集约束；实际渲染的人格版本另外记录。Usage 在 Cycle adoption 事务内生成，未采用请求的“已请求模型”遥测不当成已采用 Usage。跨 Cycle 复用缓存时必须保留真实请求血缘，不伪造 Recall 请求。

Stage 真实效果确认、宿主 Observe 待交付、Core 持久接收、Core 后台索引可见是四个不同阶段。Scene commit、Core ACK 均不证明设备物理发声或派生记忆已经就绪。

部分效果映射为 `partial + effect_proof.confirmed_range`；完整 `committed` 不发送 Core 当前不允许的 effect_proof，宿主仍保存独立确认记录。取消/失败只投递此前已确认片段；同一片段只生成一次不可变业务事件，重试不扩大正文或改写确认范围。

## 4. 水位、失效与恢复

分离 Bellis Signal/Control 序号、Observation source cursor、Core agent watermark 和 SSE cursor。请求、ACK、缓存、Usage 都记录各自的域。数字型水位必须先验证 JS safe integer；需要无损大整数时先修订通用契约，不能从已经舍入的 number 恢复。

宿主持有唯一的新消息重试责任，复用持久 Outbox；Provider 不以第二个内存队列 ACK。按目标/stream 保序并逐项确认，远端领先/落后/null 均需对账，不能按最大 cursor 清空所有旧行。批次及幂等键不可变、有界；已永久删除或隐私撤销的旧内容不能因对账补投复活。

Persona 撤销、授权失败、hash 不符与暂时不可达分类处理。撤销先封锁新采用并取消未采用工作，持久化失效后才推进处理游标；刷新失败保留可恢复任务。只有已验证的新发布版可以解除撤销，静态兜底不覆盖撤销状态。Iris 的一个对象实现两个 Port，由宿主单一生命周期管理。

外部删除/隐私失效未形成可靠订阅或重验时，不启用可跨 Cycle 复用的 Iris Recall 结果缓存。Core `cache_until`/TTL 和 source watermark 本身不足以证明没有更新或删除。

## 5. 验收与兼容

A0 重新冻结实际安装版本、Migration/协商语义、能力、scope、错误分类和运行方式；旧 Schema 11 Fixture 不能替代当前 Core。A4 必须以真实 Core API/Worker、Bellis Runtime/DB Worker 和 Stage 确认完成消费验收，使用公共接口并保留重启证据。

本次不修改已有 Wire、Migration、`contentHash` 值或 Provider 包版本。后续变更 Mapping/Manifest/契约必须带版本与旧数据读取策略，保留 Phase 1–3 兼容路径及原 Gate；不把计划描述写成已交付协议。
