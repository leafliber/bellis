# Phase 4：Provider、Persona 与工具

> 原构建计划的主题分册，保留原章节编号；章节目标不等于已交付能力。当前事实见 [实施状态](../../phase-4-implementation-status.md)，恢复 Gate 以 [ADR 0047](../../adr/0047-phase4a-recovery-scope-freeze.md) 为准。
> [返回构建指南](../../phase-4-development-guide.md)。跨分册的 § 引用按构建指南目录定位。

## 7. P2：Memory Gateway、Iris Provider 与 Persona

### 7.1 MemoryProvider Port

当前原型 Port 以 [`@bellis/contracts/memory`](../../../packages/contracts/src/memory/index.ts) 为唯一代码定义，本指南不复制另一份接口。它包含 `id/capabilities/provideContext` 以及可选 `observe/reportUsage/start/stop`。

Memory Tool 接口尚未导出。P0 必须冻结 listTools/executeTool 的版本化输入输出、权限与取消映射，决定它作为独立 MemoryToolProvider 能力还是扩展 Port；不得在完成前引用不存在的 MemoryToolDefinition/Call/Result 为稳定类型。P3 仍须通过 Tool Runtime 实现 §8.2。

Port 经配置驱动的 `MemoryProviderRegistry` 注册；Provider 只依赖 contracts 的 memory 子路径，不依赖 runtime/persistence/transport/scene-runtime。这里是可信 Provider 的窄接缝，完整第三方沙箱、Marketplace、热更新仍不属于 Phase 4。

`observe/reportUsage` 成功意味着远端持久接收或业务幂等确认；普通内存排队不算成功。错误/超时/取消必须返回宿主 Outbox，宿主保留重试责任，调用发生在后台投递任务中。当前 Iris 已有的独立方法也遵守此 ACK 边界；其旧 pending 只供迁移对账，不作为新消息的成功确认。

Provider 不得：

- 返回 system/developer role 或指示 Builder 改写旧消息；
- 自行启动模型请求、Tool Cycle 或 Scene；
- 读取未授予的 privacy domain；
- 根据未验证的展示用户名跨平台合并身份；
- 在超时后继续占用无限资源或把迟到结果写入当前 Cycle；
- 把网络凭据、原始异常正文或私有内容写入普通日志。

### 7.2 Gateway 调度与隔离

- Provider 数量、单 Provider 并发、总在途查询和结果字节数全部有上限；
- 所有 Provider 并行启动，使用一个共享前台 Deadline；
- 每个 Provider 有独立 semaphore、Abort、健康状态、错误计数和短路策略；
- 失败以显式结果进入 Manifest Audit，不让 `Promise.all` 的单一 reject 丢掉其他贡献；
- 热缓存回退必须标记 `stale`、原 revision 和年龄，且继续受 tombstone 检查；
- Provider 目录顺序稳定，错误输出顺序稳定，避免重放漂移。

### 7.3 身份、隐私与冲突

- `identityScope` 只能由已鉴权平台映射或本地 Profile 产生，不能直接相信弹幕 payload；
- 未完成可信映射前，Session 内显示名只形成 Session-local identity；
- Provider 查询与缓存键必须带 privacy domain；
- private/relationship 类 Block 默认不进入跨直播公开 Context；
- 冲突事实按组呈现来源、revision 和置信度，不由 Gateway 静默覆盖；
- privacy policy 收紧触发高优先级失效，先封锁读路径，再异步清理持久化副本。

Manifest 绑定 scope 的 invalidation/privacy generation，在发起模型请求与 adoption 前分别复核。生成期间发生 Forget/授权撤销时取消尚未采用的旧工作，后续 Cycle 重新构建；不修改已经冻结的 Manifest，也不让其绕过最新 tombstone。已发送给模型的正文无法追溯撤回，审计应如实记录请求时间与失效时间。

宿主侧持久 generation、资源 tombstone、采用/输入/输出事务复核与旧消息抑制见 [ADR 0013](../../adr/0013-phase4-memory-policy-transactions.md)。注册 Forget 与收到的外部删除事件已接通，后者见 [ADR 0022](../../adr/0022-phase4-resource-invalidations.md)。生产四工具完整授权、事件历史缺口重验与普通纠正通知仍待交付。

### 7.4 确定性测试 Provider

本地 Provider 是与 Iris 共用宿主路径的离线测试实现，不建立第二套生产长期记忆系统：

- 使用有界内存 Fixture；恢复测试复用宿主 SQLite Worker/受控 Repository Port，不直接打开 Core 数据库；
- 提供确定性文本/标签索引，不以 embedding 或外部模型作为正确性前提；
- 支持 viewer、relationship、fact、episode、task 类 Block；
- search/read 为 pure 或 idempotent；remember/correct/forget 使用稳定业务幂等键；
- 每次纠正/遗忘递增 revision，遗忘写 tombstone；
- 读取始终先应用最新 tombstone/privacy revision；
- 大正文按 Block 预算截断，原始敏感数据不进入模型审计或普通日志。

待消费 Signal/Tool Result 的策略版本核验已接通，见 [ADR 0021](../../adr/0021-phase4-local-input-privacy.md)。接纳版本与来源 Manifest 决定本地输入是否可见，完整当前批次的聚合信息继续保留；这不替代可信入口和证据授权。

本节 remember/correct/forget/tombstone 用于验证宿主行为；真实语义必须由 Iris 公共接口另验，不能因 Fixture 支持就宣称 Core 能力已接通。

### 7.5 PersonaSource 与 Persona Slot

Persona Source 管理、确定性 Renderer 和就绪门禁先在宿主功能模块中实现；若独立使用需求成立，再按 P2 的职责候选迁入 persona-runtime。
`subscribe` 可选仅适用于不可变 Source，或宿主已配置有界后台轮询的 Source。可变 Source 无订阅也无轮询时拒绝配置。
断线后按游标追平；没有游标的 Source 后台全量重验，不在 Cycle 前台请求。远端不可达时继续已验证发布版，但瞬时 state 仍按固定快照时间过期回 baseline。
发布内容 hash 仅覆盖稳定 core/traits/narrative，不含 state/fetchedAt/origin；进行中 Cycle 保持旧快照，revoked 则取消尚未采用的工作并阻止旧人格继续提交。

人格事实源在外部记忆系统，Bellis 只做消费与渲染
（[ADR 0005](../../adr/0005-memory-provider-seam-and-persona-ownership.md) 决策 3）。
`PersonaSource` 由 **Runtime 配置拥有，不由 Memory Gateway 调度**——它不共享
记忆的前台 Deadline。

- 返回**结构化 `PersonaSnapshot`**，不是 Prompt 文本；渲染由 Bellis 自己的
  确定性模板完成，同一快照必须字节稳定。
- 发布版本进 Stable Prefix 的 Persona Slot，位置在安全与直播规则**之后**；
  `(agentId, revision, contentHash, rendererVersion)` 参与 `promptEpoch`。
- 瞬时状态进 Dynamic Tail 的 `trusted: true` / `placement: "working"` 块，
  **不参与** `promptEpoch`，避免情绪变化击穿前缀缓存。
- 在 `start()` 与失效通知时编译；换入原子且发生在 Cycle 边界之外，进行中的
  Cycle 保持其快照人格（不变量 2）。
- 渲染器丢弃任何试图声明工具权限、改写输出协议或放宽安全规则的字段并告警。

启动期就绪门禁与降级：

| 情况                                         | 行为                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 对端不可达，有已验证缓存且 hash 通过         | `verified-cache`，degraded，允许开播                                                                    |
| 对端不可达，无缓存，配置了 `staticPersona`   | `static-fallback`，degraded，允许开播                                                                   |
| 对端不可达，无缓存，无静态兜底               | **not ready，拒绝开播**                                                                                 |
| 运行中对端不可达                             | 继续已验证发布版；Cycle 内不重拉，后台按订阅/有界轮询追平                                               |
| 召回响应的人格版本/哈希与已编译不一致        | 封锁旧缓存、取消尚未采用的旧 Context，后台重拉后重建                                                    |
| 发布版本 `revoked`、授权撤销或 hash/身份不符 | **立即 fail closed**；持久化封锁状态，不用旧缓存或同身份 staticPersona 绕过；只在取得合法新发布版后恢复 |

`staticPersona` 是离线兜底，不是事实源。

失效任务必须先持久登记或完成处理，再推进 SSE 的已处理 cursor；刷新失败保留待办，断线或历史不足时全量重验。除发布版失效外，还须覆盖瞬时 state 更新/过期，不能只依赖 Recall mismatch。一个 Iris 实例实现 MemoryProvider/PersonaSource 时 start/stop 只各执行一次；配置中的业务 appInstanceId 与进程启动随机 ID、Outbox claim owner 分开。

已实现的人格持久状态端口、版本冲突与后台请求边界见 [ADR 0012](../../adr/0012-phase4-provider-state-and-persona-barriers.md)。该切片不替代资源 tombstone、隐私 adoption 屏障与完整恢复 Gate。

### 7.6 Iris 公共接口映射与配置

以下路径已存在于当前 Core/SDK；表中宿主装配、错误分类和适配修复为 A0–A3 待交付。Iris 接入不经过 MCP。

| 宿主能力         | Core 公共路径 / SDK 方法                                                      | 必须保留的语义                                                                                          |
| ---------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 启动协商         | `GET /v1/capabilities`、`POST /v1/negotiation` / `negotiate`                  | 实际 DB/发布清单/协商版本分别记录；当前 manifest=14、capability 真源=11 的差异先关闭                    |
| PersonaSource    | `GET /v1/personas/{agent_id}/current` / `currentPersona`                      | 结构化内容、发布 revision/hash、state baseline/TTL；发布人格与 Recall 数据独立                          |
| provideContext   | `POST /v1/recall` / `recall`                                                  | scope、actors、purpose、deadline_at、token_budget、allow_partial；完整候选集合、路由降级及 request 血缘 |
| reportUsage      | `POST /v1/recall/{request_id}/usage` / `reportRecallUsage`                    | 原始 returned 集合完整回显；两个子集；使用该 Recall 的 persona_revision，非后来换入的人格版本           |
| observe          | `POST /v1/observations:batch` / `observeBatch`                                | 持久接收/重复确认、不可变事件身份、每 stream cursor、partial proof；ACK 不等于后台认知完成              |
| source 对账      | `GET /v1/observations/cursors/{source_stream}` / `sourceCursor`               | 数字安全范围、null、gap_policy；禁止最大游标推定全部送达                                                |
| 更新通知         | `GET /v1/events` / `events({after, signal})`                                  | 有限 SSE 拉取，宿主重复轮询/退避；event cursor 与 agent watermark 分开                                  |
| Surface 可选能力 | `/v1/active-surfaces:acquire`、`/{lease_id}:heartbeat`、`/{lease_id}:release` | off/advisory/required 与 Core 策略匹配；Proof/旧 epoch/丢租分类和显式支持范围                           |

运行配置由 Runtime 校验后注入，至少包含：启用开关、允许的 base URL、业务 token 的环境/文件引用、稳定 appInstanceId/agentId/spaceId、可选且真实存在的 Core sessionId/spaceGroupId 映射、PersonaSource/staticPersona、Memory Deadline/Token/响应字节预算、后台刷新/交付 timeout、重试与磁盘配额、Surface 模式。名称由 A0 冻结，不能把本表当成已有配置键。

可信配置文件与固定启动入口已接入，见 [ADR 0041](../../adr/0041-phase4-iris-launch-configuration.md)、[运行说明](../../iris-runtime-operations.md) 和 [配置样例](../../examples/iris-runtime.json)。该入口只接受凭据引用，默认支持范围与 Surface off 保持；输入身份授权、写工具装配和凭据轮换仍待完成。

- tenant、业务 appInstanceId 与能力由 Core 凭据派生；不能由模型、浏览器或弹幕提供。scope 只能收窄；日志/Prompt/Stage 不携带 token。
- Bellis Session ID 与 Core Session ID 显式映射并落盘；无映射的 session scope 配置拒绝启动，不能把随机 UUID 当作已有 Core Session。只使用 space scope 必须显式配置并接受其跨 Session 语义。 当前宿主只接受 `scope: { kind: "space", acknowledgeCrossSession: true }`，启动前落盘核对本地 Session 归属；Core Session 映射尚未支持，见 [ADR 0023](../../adr/0023-phase4-explicit-memory-scope.md)。
- Recall actors 由可信 Signal/Profile 映射产生，不由显示名合并。Observation 的 actor_external_identity_id 经公共身份解析/受控初始化获得，需扩展或结构化映射当前 MemoryObserveEvent；不凭用户输入生成内部 entity ID。首包必须验证“同一用户输入 → 观察归属 → 下次查询”的链路。
- 无 actor 的 idle/world Cycle 不构造假的 viewer；可不发起 Recall并记录原因。Core 授权可读后，Builder 仍执行公开直播输出策略；空标签不自动解释为公开。
- 先校验 resource type，再允许 categoryMap 收窄；未知类型始终拒绝，viewer 只能由宿主可信 identity 规则产生。保留 resource_ref、scope、subject_entity_id、scores/final_score 的有界 audit；不同候选的同一资源需保留 Usage 血缘。

### 7.7 Iris 取消、错误和失效门槛

Context 前台默认总预算 200ms、上限 250ms，包含 Gateway 排队/传输/校验；deadlineMs 表示剩余时长，转换到 Core deadline_at 时使用配对的单调时钟与墙钟。后台启动/轮询/Observe/Usage/Lease 各有独立 timeout，并挂在 Runtime 生命周期 Abort 下；循环内不等待 Persona 网络刷新。

当前 SDK 的 Recall/Observe/Usage/Persona 读请求支持 signal，但 start/stop 调用链和 search/显式写工具仍需补全。响应体解析也须受字节/时间限制，未知扩展字段在有界 audit 内保留。stop 先停止轮询/Claim，取消并回收在途请求，最后释放 Lease 和状态存储，禁止 fire-and-forget 刷新在关闭后换入数据。

| 错误类别                                              | 前台/人格行为                                           | 后台交付行为                                           |
| ----------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------ |
| 超时、断网、可重试 429/5xx、database_busy             | Recall 明确降级；人格仅暂时不可达可使用已验证未撤销缓存 | 保留行，有界退避/Retry-After；不阻塞当前回复           |
| 鉴权/授权失效、不兼容版本、非法 DTO/hash              | 停用受影响能力；人格不走旧值兜底；就绪状态体现原因      | 进入需配置修复/对账状态；保留身份，不无限盲重试        |
| idempotency_key_reused、revision_mismatch、cursor_gap | 不生成新的业务键掩盖冲突                                | 对账或死信；不改写旧 payload，不跳过 stream 中缺失事实 |
| lease_fenced/expired、required 无有效 Proof           | 停止该受限能力；宿主不据此宣称全局演出互斥              | 保留 pending；恢复权限/有效 Lease 后依原业务键处理     |
| privacy/forget/revoked 失效                           | 先封锁读路径与新采用，再清缓存；取消未采用旧工作        | 已撤销内容按策略抑制并审计，不因重试/恢复重新写回      |

Runtime readiness 已接入实际 Persona/隐私准入状态；明确鉴权拒绝锁定当前 Iris 实例，停止后台网络重试并持久封锁 Persona 回退。真实 Core 公开凭据撤销验证及范围见 [ADR 0042](../../adr/0042-phase4-memory-readiness.md)。零重叠凭据轮换、私有引用替换及保留原事实的显式重启也已通过真实公开接口验证，见 [ADR 0043](../../adr/0043-phase4-credential-rotation.md)。

SDK/HTTP Adapter 必须解析状态码和 ErrorEnvelope，不能把所有 4xx/5xx 都压成 ContractValidationError 后重试。Required Surface 只有服务端 Proof 检查与宿主行为都通过真实矩阵才可声明支持；首个单宿主集成可使用明确配置的 off 模式，不能暗中降低服务端 required。

SSE 历史缺口不能用过滤后游标是否连续判断。Core 新增的可协商事件身份校验及 SDK 可选参数见 [ADR 0029](../../archive/phase-4/decisions/0029-phase4-event-checkpoint-identity.md)；公开契约和 Bellis 成对身份持久化已实现。宿主持久缺口屏障见 [ADR 0030](../../archive/phase-4/decisions/0030-phase4-history-gap-barrier.md)：暂停采用及投递，保留已确认事实和原 Outbox，真实隐私撤销继续独立生效。Provider 已接入事件 410 与旧状态缺少身份的持久报告，重启继续保持屏障；正式成对校验请求、公开全量重验与解除仍待接入。重验范围的持久清单、分批读取、快照变化检测见 [ADR 0031](../../archive/phase-4/decisions/0031-phase4-history-revalidation-inventory.md)；遍历完成不代表远端重验通过。

公开 Claim Correct 及其撤回引起的 Claim/Relation 级联现已在 Canonical 事务中产生旧修订失效事件，见 [ADR 0032](../../archive/phase-4/decisions/0032-phase4-claim-correction-events.md)。真实 Worker 停止期间通知仍能取消 Bellis 旧 Context，有限截止值允许后续有效修订进入新 Context；其他资源修改通知及完整公共重验仍待完成。

Recall 的首次响应发布与原请求重放现已在各自事务中重验候选和 Persona，失效返回冲突并保持原 Usage 血缘，见 [ADR 0033](../../archive/phase-4/decisions/0033-phase4-recall-replay-revalidation.md)。此处单响应核验不能替代缺口清单的跨请求一致性与安全解除。

已新增只读公开批量核验 `POST /v1/recall:revalidate`，以完整原请求指纹检查存档集合，在单个读取快照中返回逐项结论，见 [ADR 0034](../../archive/phase-4/decisions/0034-phase4-recall-batch-revalidation.md)。宿主已在实际发送前持久保存完整准备请求，重启后的清单正文与真实 HTTP 请求一致并通过公开核验，见 [ADR 0035](../../archive/phase-4/decisions/0035-phase4-original-recall-requests.md)。准备记录不证明远端收到。核验批次和逐项结论已持久绑定清单与原请求摘要，见 [ADR 0036](../../archive/phase-4/decisions/0036-phase4-history-verification-records.md)；清单变化使旧结论和迟到响应失效。独立维护核验通道与清单分批调度已接通，见 [ADR 0037](../../archive/phase-4/decisions/0037-phase4-recall-revalidation-coordinator.md)；发送前复核真实隐私屏障，旧策略请求仍待明确授权。持久恢复发现和宿主取消归属见 [ADR 0038](../../archive/phase-4/decisions/0038-phase4-history-recovery-discovery.md)：复用有效 runId，隐私变化或关闭先取消旧维护任务。受控后台轮询、暂时失败重试和在途容量约束已接入，见 [ADR 0039](../../archive/phase-4/decisions/0039-phase4-background-history-recovery.md)。可信恢复配置已接入 Runtime 启动与运行期缺口状态，维护期间关闭决策入口并保持 readiness 503，见 [ADR 0040](../../archive/phase-4/decisions/0040-phase4-runtime-history-recovery.md)。全部事实覆盖、跨批次一致性和安全解除继续实施。

## 8. P3：Iris Memory Tools 与后续 MCP Adapter

### 8.1 MCP 适配边界

Phase 4B 支持本地 stdio 与 Streamable HTTP 两种受控传输，协议版本与依赖在该包开工时核验。Adapter 负责：

- 建立、能力协商、健康检查、Deadline、Abort、重连和优雅关闭；
- 把允许的 Resource 结果映射为 `ContextContribution`；
- 把允许的 Tool 映射为符合现有 `ToolDeclaration` 的定义和 Handler；
- 名称归一化到 `^[a-z][a-z0-9_]{0,63}$`，冲突时启动失败而不是运行期覆盖；
- 对输入/输出再次执行 JSON-safe、大小、Schema、敏感字段和 privacy policy 校验；
- 限制 stdio 子进程环境、工作目录、可执行文件和继承凭据；
- 限制 HTTP Origin/Host、重定向、凭据域和响应体大小。

MCP Server 返回的描述、Resource 文本和 Tool 结果全部是不可信数据，不得被当作本地配置或系统指令执行。MCP 生命周期对象和私有错误不能越过 Adapter Port。

### 8.2 Memory Tool 映射

至少覆盖四类语义：

| 语义        | 默认 Tool 语义           | 权限/确认                  | 幂等与缓存                               |
| ----------- | ------------------------ | -------------------------- | ---------------------------------------- |
| search/read | `pure` + `parallel_read` | `memory.read`              | 可短 TTL，键含 provider/revision/privacy |
| remember    | `idempotent` + `keyed`   | `memory.write`，按策略确认 | 必须有业务幂等键，不缓存结果             |
| correct     | `idempotent` + `keyed`   | `memory.write`，按策略确认 | 目标 identity/key 串行，递增 revision    |
| forget      | `idempotent` + `keyed`   | `memory.forget`，默认确认  | tombstone 幂等，绝不缓存旧结果           |

- 模型选择工具不等于获得权限；每次调用继续由 Tool Runtime 检查；
- Provider 声称 pure 不能跳过本地声明校验；
- 不支持幂等或结果对账的外部写操作必须降为 `non_idempotent` 并 fail closed；
- Confirmation Port 未装配时需要确认的工具拒绝执行；
- Tool Result 只进入后续 Cycle，不修改正在生成的模型请求。

Iris A3 的具体映射：`memory_search` → `/v1/search`（`search`），`remember` → `/v1/claims:remember`（`rememberClaim`），`correct` → `/v1/claims/{claim_id}:correct`（`correctClaim`），`forget` → `/v1/memory:forget`（`forgetMemory`）。各方法的 capability、purpose、actor/subject、reason、expected revision、幂等与 Lease Proof 从公共契约校验后注入，模型不拥有 scope/凭据。写调用的实际参数和业务键随 Tool Run planned/started 持久保存，不能只有不可恢复的 key hash。

原始模型调用的事务保存与 Session 所有权基础见 [ADR 0014](../../adr/0014-phase4-original-tool-calls-and-session-ownership.md)；实际请求持久化/确认见 [ADR 0016](../../adr/0016-phase4-prepared-tool-requests.md)，四工具注册及必需的可信授权端口见 [ADR 0017](../../adr/0017-phase4-iris-tool-registration.md)，Forget 屏障与回执事务见 [ADR 0018](../../adr/0018-phase4-forget-coordination.md)。目标预览及确认后公开读取核验见 [ADR 0020](../../adr/0020-phase4-iris-tool-target-verification.md)；生产意图/证据授权、真实 Legal Hold/保护对象和完整公共恢复 Gate 尚未完成。

现有 SDK 的上述方法需补 Abort/稳定 ErrorEnvelope 映射后才开放。公共传输及宿主未知结果的实施与未完成 Gate 见 [ADR 0015](../../adr/0015-phase4-iris-tool-transport-outcomes.md)。若超时后远端可能已提交，按原键/公共结果对账；不能报告“取消所以肯定未写”，也不能生成新键再写。Forget 返回的 target/erased/protected/held 计数要如实呈现；Canonical 逻辑删除、物理清除与 Legal Hold 分开。发起 Forget/收紧隐私时先立宿主读屏障，成功后持久 tombstone；确定拒绝时按冻结策略解除或保留屏障，结果未知则持续封锁至对账完成。

### 8.3 本地协议契约测试

本地 MCP Harness 至少验证：

- stdio/HTTP 握手、Resource Context、Tool read/write/forget 正常路径；
- 取消能终止挂起请求，stdio 子进程退出且无残留句柄；
- 重复 Tool 名、非法 Schema、超大正文、未知字段和断流 fail closed；
- 401/403/429/5xx、重定向、超时和连接重置映射为稳定错误；
- secret、Authorization、Cookie、私有 Block 与 Server stderr 不进入日志；
- Provider 恢复后只影响后续 Cycle，不改写历史 Manifest。
