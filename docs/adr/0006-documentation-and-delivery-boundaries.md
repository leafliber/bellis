# ADR 0006：文档权威性、来源去重与 Phase 4 交付边界

> 2026-09-06 架构审查修订：任务所有权、工具恢复事实、调用列表范围、场景终态、Seq 分段预留及 Provider 接缝以 [ADR 0007](./0007-task-ownership-and-runtime-scope.md) 为准。 本文保留历史决策/实施过程；与新决策冲突的描述不再作为当前实现要求。

> 状态：Accepted
>
> 日期：2026-09-06
>
> 决策背景：构建文档审查及项目负责人要求修复已构建部分的文档/代码、修复未构建部分的文档。
>
> 关联：[ADR 0004](./0004-phase-3-decision-boundaries.md)、[ADR 0005](./0005-memory-provider-seam-and-persona-ownership.md)、[构建与验收状态](../guides/build-and-validation.md)

## 1. 文档权威性与实现状态

代码中的公共 Port/Schema 是现有类型的唯一真相源，长期架构不复制第二套方法签名。
完成态参考记录交付事实和已知缺口；历史实施计划保留原目标，不因局部实现通过测试就宣称所有 Gate 完成。
稳定协议区分包级可选能力和 Runtime 实际装配：当前跨重启只恢复 Seq 并对账 Snapshot，不承诺磁盘 Replay；Prepare Deadline 由 Runtime Director 执行；Stage reason 为有界开放字符串。

根 `pnpm check` 先构建再检查；CI 另执行 `pnpm test:acceptance`，覆盖 Phase 1–3 Demo、Phase 2 Crash 和真实 Chromium。依赖下载与 Chromium 安装是离线验收的准备步骤。

紧急输入的演出取消不依赖活跃模型 Turn 是否存在：已结束的 Turn 仍可能留有播放中的 Scene。新 interrupt Turn 经 PerformancePort/Director 取消旧演出后才请求模型，防止漏停或误停新一轮输出；浏览器专项与单元测试覆盖这一顺序。

## 2. Signal 来源去重与无损序号

落实 ADR 0004 的来源作用域：去重键为 `(sessionId, Signal.source, Signal.id)`，相同来源重试回显原序号，不同来源可以拥有相同 ID。内存与持久化实现保持一致。
Migration 0005 前向替换唯一索引，旧行的 source 从原 signal_json 读取；不重写历史 ID、sequence 或 Migration 0004 checksum。

序号保持规范十进制 TEXT，比较/排序使用数字位数再按字节比较，递增只在 bigint 中完成。禁止经 SQLite INTEGER 或 JS number 中转，覆盖十进制位数变化、2^53 和 2^63 边界。

## 3. 修正 ADR 0005 的 Observe 时机

本节替代 ADR 0005 决策 4 中“Scene commit 记录已确认输出片段范围”的要求。
Scene commit 是调度意图，发生在播放前；不能证明音频/字幕实际生效。
Phase 4 须新增独立、幂等的 effect/progress 确认事实，在接收可信 Stage 确认后同事务写确认记录和 Observe 投影。

确认应绑定 Session、连接代际、Scene/Cue 和 segment 范围；P0 冻结 Wire/持久化形态及范围合并、乱序、重复和重启规则。当前未实现此协议，不回写到稳定 Scene 文档。
completed、cancelled、failed 都只能观察已确认部分：零确认时不产生 assistant 内容；部分播放后取消仍可记录已确认前缀。历史 ScenePlan 的整段文字不能补成播放事实。

## 4. Observe/Usage ACK 与有限容量

`observe/reportUsage` 成功只表示远端持久接收或其业务幂等确认。内存入队、后台任务已安排均不算成功。
调用由宿主后台 Outbox 执行，远端错误/超时/取消返回给宿主；确认之前宿主必须保留行及重试责任。不同 Provider 独立结算。
现有 Iris 独立 Provider 改为等待远端成功，旧 pending 保留兼容恢复；TTL 过期转为需对账状态，不静默删除。宿主 Phase 4 Outbox 尚待实现。

Phase 4 的内存 Claim/在途任务有界，持久 pending 使用磁盘配额。高水位停止新 Cycle/Scene 准入，预留已活动场景的完成/取消确认空间。P0 根据活动数和最大确认片段数确定预留，并测试满载/恢复。
达到磁盘硬限制时明确 not-ready，不能同时承诺“无限不反压、容量有界且绝不丢失”。最大重试/TTL 只触发保留身份的 dead/对账状态，隐私撤销按 tombstone 策略另行审计。

## 5. Context 与 Persona 的 Phase 4 冻结范围

当前 `contracts/memory.ContextContribution` 是 Memory 专属响应。宿主采用另一个待实现的 `AssemblyContribution`；非记忆贡献不伪造召回路由、mappingVersion 或 personaRevision。宿主注册策略决定 section/trust，外部字段不能提升可信等级。
当前 MemoryProvider 未导出工具方法；P0 必须冻结独立 Memory Tool 能力或正式扩展，P3 继续走现有 Tool Runtime。

ADR 0005 的 `contentHash` 仍校验 Provider 原文，规范化去重另用 normalizedHash。
其分类规则澄清为：未知宿主 canonical category 拒绝；Provider 原始分类允许经已声明、确定性结构映射转为合法 canonical category，原值放 providerCategory，不从自然语言猜分类。

PersonaSource 的 subscribe 可选不代表可变人格可以永不更新。不可变 Source 可省略；可变 Source 必须提供订阅，或配置有界后台轮询/全量重验。运行中暂时不可达可继续已验证发布版，恢复后追平；Cycle 内不做网络等待。
稳定人格 hash 只覆盖 core/traits/narrative，不含瞬时 state、fetchedAt、origin；state 过期回 baseline 不翻转 promptEpoch。发布版/rendererVersion 变化才更新 Epoch。
revoked 阻止旧人格继续采用新决策，并取消尚未采用的旧人格工作；已提交输出仍按实际确认记录，不能抹去历史。

P2 负责 Memory Gateway 和独立 persona-runtime，P6 负责 Runtime 装配；Gate 必须覆盖人格渲染、Epoch 稳定性、缓存/静态兜底、撤销及断线重启。这些仍是 Phase 4 实施要求，不因本 ADR 获接受而视为已构建。

## 6. 兼容与验证

- Wire v1、已有 Scene Commit/快照不改变；Control/Scene 文档按已交付行为澄清。
- Migration 0005 保留历史数据，升级后不得退回只认识 0004 的可执行文件；需要回滚应用时使用升级前备份，不能编辑已记录的 checksum。
- Iris 的 Promise 成功时机收紧：独立消费者需要保留重试，不能假设调用返回仅代表入队；不改变返回类型。
- 子任务停止 P99 ≤100ms 保留为性能目标。端到端 Turn settlement 与子任务停止分开命名；未完成足量、分层实测前不能声称 P99 已验收。
