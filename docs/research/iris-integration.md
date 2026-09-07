# Phase 4：Iris 接入调研

> 日期：2026-09-06；用途：Phase 4 重规划依据，不是接入完成报告。
> 调研基线：Bellis `dc3915e`、Iris Memory Core `692de12`，**均包含正在收尾的未提交修改**。以下按本轮读取的工作树记录；实施前重新冻结两端 Commit、安装物摘要及契约。
> 执行计划：[Phase 4 指南](../plans/phase-4/README.md)；边界修订：[ADR 0008](../adr/0008-iris-phase4-integration.md)。

## 1. 结论与归属

Iris 已有真实 HTTP API、持久 Observation、Recall、Usage、Persona、遗忘和后台 Worker，适合作为 Bellis 首个外部记忆系统。Bellis 应复用现有独立 Provider，通过公共 TypeScript SDK 调用独立 Core 服务；无需先实现另一套长期记忆数据库或把 Iris 包装成 MCP。

目前尚不能宣称接入可用：宿主缺少 Context/Persona 装配、Usage/Observe 事务投影、实际输出确认以及真实双进程验收。现有适配器的离线测试也未覆盖下面几项真实契约差异。

Iris 的 [Phase 11](../../../iris_memory_core/docs/development/phase-11-bellis-adapter.md) 已标记 Deferred，其 [Phase 14](../../../iris_memory_core/docs/development/phase-14-hardening-release.md) 只负责 Core 发布。根据本次接入要求，**Bellis Phase 4 承接 Bellis 宿主与适配器工作**；Core 继续负责通用 API、SDK 和安装物问题，不恢复 AstrBot、不把宿主验收重新加入 Core pip 发布门槛。本次只修订 Bellis 计划与设计说明。

## 2. 当前可复用能力

| 位置 | 已有能力 | 对 Phase 4 的意义 |
| --- | --- | --- |
| [Memory 契约](../../packages/contracts/src/memory/index.ts) | `MemoryProvider`、独立 `PersonaSource`、Query/Block/Observe/Usage；路由等为可选扩展 | 复用窄 Port；工具能力、Manifest、效果确认仍需冻结 |
| [Iris Provider](../../providers/memory-iris/src/index.ts)、[映射](../../providers/memory-iris/src/mapping.ts) | SDK 调用、八类 resource type 映射、Persona 缓存、SSE 轮询、Surface Lease、新请求等待远端 ACK | 以原型为起点修正，不能只实例化便认定完成 |
| [Conformance Harness](../../packages/testkit/src/memory-provider-conformance.ts) | Schema、Provider/Request ID、Token 估算总量和可选 Observe/Usage 调用 | 是最小形态检查，尚不能证明真实 hash、隐私、取消、持久 ACK、重启 |
| [请求组装](../../packages/decision-loop/src/loop/request-assembly.ts)、[Loop](../../packages/decision-loop/src/loop/decision-loop.ts) | 同步 `buildModelRequest`、Cycle 快照与采用边界 | 需注入可取消的宿主 Context 构建 Port，保留单一 Loop/Prompt 所有者 |
| [采用事务](../../packages/persistence/src/repositories/phase3.ts)、[Dispatcher](../../packages/persistence/src/outbox/dispatcher.ts) | 水位/Tool planned/Record 原子提交；持久 Outbox Claim/重试/完成 | 扩展现有 DB Worker 事务；当前采用事务未写 Memory 投影，Claim 也不保证分区连续交付 |
| [Runtime 发布器](../../apps/runtime/src/application/outbox-publisher.ts)、[生命周期](../../apps/runtime/src/bootstrap/lifecycle.ts) | `scene.committed` 白名单的录制发布器、Phase 3 Host | 新 topic 不能继续交给录制发布器，否则会进入 unknown_topic/dead |
| [Core API](../../../iris_memory_core/src/iris_memory_core/api/app.py)、[SDK](../../../iris_memory_core/sdk/typescript/src/index.ts) | Bearer 鉴权、scope 收窄、`/v1` 公共操作与有限 SSE 拉取 | Bellis 是独立 HTTP 客户端，无权操作 Core SQLite/FAISS/内部队列 |

## 3. 必须关闭的接入差异

### R1：版本清单与运行协商不一致

[Core version manifest](../../../iris_memory_core/schemas/version-manifest.json) 为 Core 0.12.0 / Schema 14 / Contract 1.9.0；[公共 capability 真源](../../../iris_memory_core/contracts/source/contracts.json) 仍为 package 0.11.0 / Schema 11，`ApiRuntime.capabilities()` 从该真源返回 Schema。Provider [兼容矩阵](../../providers/memory-iris/compatibility-matrix.json) 和默认上下限也都只支持 Schema 11，SDK 为 0.11.1。

因此实际协商可能仍返回 11，不能简单写成“当前 Core 一定被拒绝”，更不能用协商成功证明 Schema 14 兼容。A0 必须比较已安装 Core 的 Migration 版本、发布清单、运行协商和 SDK 消费结果；上游先消除版本语义歧义或明确分别命名，再冻结支持窗口。只调大 `maximumCoreSchemaVersion`、复制三份相同 Fixture 均不构成兼容证明。

### R2：来源 hash 不是统一的文本 hash

Core [Recall 路由](../../../iris_memory_core/src/iris_memory_core/application/recall.py) 对 recent/state/focus 等内容使用 `content_hash({content: text})[:16]`，claim/relation 等透传领域 revision 的结构化 hash；[hash 实现](../../../iris_memory_core/src/iris_memory_core/domain/hashing.py) 包含 canonical JSON version 和包装对象。当前 Provider 透传这些值，旧指南却要求统一对 `text` 的原始 UTF-8 字节复核。

本轮最小探针：文本 `你好` 的 SHA-256 为 `670d9743…`，Core recent hash 为 `6daf1113889d23f8`，两者不是同一算法输入。若照旧指南实现，合法记忆会被错误丢弃。

修订为：`contentHash` 保留上游来源凭据，按 Provider 声明的方案验证；另存 `textHash`（收到的原文）和 `normalizedHash`（去重）。没有完整结构化输入时标为来源摘要透传，不能声称已重算验证，也不能拿自己计算的 textHash 替代上游 hash。Persona 返回了完整 core/traits/narrative，仍必须重算验证；补 Python/TypeScript 数值、Unicode、嵌套对象的 canonical 等价 Fixture。

### R3：离线 Observe Fixture 不满足真实领域约束

[Core ObservationDraft](../../../iris_memory_core/src/iris_memory_core/domain/observation.py) 要求 `partial` 携带非空 `effect_proof.confirmed_range`，`committed` 则不能携带 `effect_proof`。当前 Provider 测试的 partial Fixture 没有 proof，FakeIrisClient 仍接受。探针已复现：partial 无 proof 拒绝；带 confirmed_range 接受；committed 带 proof 拒绝。

Phase 4 须从真实 Stage 已生效的 segment 生成证明，冻结范围单位与完整/部分映射。`scene.started` 只能证明开始，Scene commit/ended/估计播放时长不能证明整段已生效。完整输出的确认依据留在宿主 effect record 与允许的结构化字段中；部分输出映射到 Core 的 confirmed_range。工具只有明确 `effectApplied=true` 才能形成效果观察。

### R4：身份、Scope 与隐私不能只透传宿主 ID

Core [ObservationService](../../../iris_memory_core/src/iris_memory_core/application/observation.py) 校验 Agent、Space、Session 的实际存在、授权及层级，Session ID 不能随便用 Bellis Session UUID 代替。Recall 至少需要一个 actor；用户观察还支持 `actor_external_identity_id`，但当前 MemoryObserveEvent 没有一等 actor 字段，Provider 映射也未投递它。只传正文不能证明观众归属闭环。

Core 的 [privacy 标签](../../../iris_memory_core/src/iris_memory_core/domain/privacy.py) 使用 `space:<id>`、`entity:<id>:private` 等语法；Provider Fixture 中的裸 `private` 不属于合法 Core 标签。Core 授权可读也不等于可以在公开直播中说出。A0 冻结凭据 → tenant/appInstance/agent/space 映射，可信 actor 解析与公开输出策略，禁止昵称合并或模型指定内部 entity ID。没有可信 actor 时显式省略该次 Recall；没有 Core Session 映射时拒绝 session scope 配置，不静默扩大为 space scope。

### R5：Usage 必须保留真实 Recall 的血缘

[RecallUsageService.report](../../../iris_memory_core/src/iris_memory_core/application/recall.py) 要求 returned 集合与该 request 的原始返回集合完全相等，`modelVisible ⊆ hostSelected ⊆ returned`，且 persona_revision 等于该 Recall 保存的版本。

宿主必须保存 Iris `returnedBlockIds`，包括被映射/预算/隐私过滤掉的候选 ID；不可只回传最终 blocks。Persona 刷新产生的当前 revision 不能覆盖 Recall 的 revision。Manifest 分别记录请求中的 Persona Slot 版本与每次 Recall 的关联版本。重复候选跨路由合并后仍保留各 request 的候选血缘；缓存不得伪造新 requestId。本阶段可先禁用 Recall 结果缓存，减少错误 Usage 和外部删除失效风险。

### R6：四种水位与 ACK 必须分开

Bellis Signal/Control Seq、Observation `source_cursor`、Core agent watermark（Recall `minimum_watermark` 的域）、SSE event cursor 相互独立。Observation 响应的 `source_watermark` 是 source cursor 汇总，不是 agent watermark。

Core `source_cursor` 请求为十进制字符串，但 SourceCursor/Observation ACK 的部分水位在当前 SDK 中为 JSON number；必须检查安全整数边界，不能 `BigInt(number)` 后假装恢复精度。宿主分配独立、持久、连续的 Observation cursor，不使用会有预留缺口的 Control Seq。

当前 Adapter `reconcile()` 仅记录 remote_behind，未补投、未处理远端领先/null；成功后本地 cursor 按数组遍历覆盖，也没有完整 ACK 对账。Core source cursor 的最大值不一定证明所有更小项已交付（存在 accept/mark gap policy）。恢复须依赖宿主不可变事实和逐项 ACK；不能根据远端游标一次性删除 pending。

### R7：Persona 刷新、撤销与生命周期未闭合

Provider `start/current/#loadInitialPersona` 存在宽泛 catch 后兜底；revoked/hash mismatch 不能归为普通不可达。SSE 轮询先更新 cursor，再失效/刷新；刷新失败可能丢失尚未完成的更新任务。Recall mismatch 启动的后台刷新、start/stop/Lease 请求也缺少统一生命周期取消和有界等待。

需要持久 pending invalidation，或先完成失效效果再确认事件 cursor；断线/事件历史不足时全量重验。周期更新不依赖 Recall 恰好发生。撤销锁存后禁止旧缓存/静态同身份兜底继续运行；换入已验证的新发布版本才解除。一个 Iris 对象同时实现两个 Port，Runtime 只能拥有一次 start/stop。

### R8：映射、错误与工具边界

`categoryMap` 当前先于 resource type 检查，可让未知类型通过，且可配置生成 viewer；必须先验类型再做受限覆盖。保留 resource_ref、原始 scope、subject_entity_id、scores/final_score 的有界审计，不能把相关性当 confidence。

SDK 多数方法对响应直接做成功 DTO 校验，`#request` 不统一解析非 2xx ErrorEnvelope；Observe 等失败会失去稳定的重试/拒绝分类。search/rememberClaim/correctClaim/forgetMemory 的当前方法也未统一接收 AbortSignal。A0/A3 需使用修复后的独立 SDK 安装物或文档化公共 HTTP Adapter，不能调用 SDK 私有方法或仅 Promise.race 超时。冻结权限、业务幂等键、取消、未知结果、Forget 计数/Legal Hold 和缓存屏障后再开放 Memory Tools。

Surface `off/advisory/required` 的配置和服务端策略要一致。当前 Core Phase 14 仍列有 Recall/Focus 的 Required Lease 门禁缺口，Adapter 的本地检查不能证明全局互斥或阻止 Bellis 自己演出；Required 支持必须另行通过服务端缺失/过期/旧 Epoch/非 Holder 的真实矩阵。

## 4. 安装与运行边界

Provider 当前不在根 workspace；`@bellis/*` 使用 link，SDK 使用本地 Verdaccio，不能以根 `pnpm check` 通过替代独立包验收。公开 npm 是否可用本轮未联网查询，也不把公开发布当接入前置。A0 选择可重现的版本化安装渠道；隔离消费 SDK 安装物，记录版本、integrity 和锁文件，不 alias 到相邻仓库源码。

Core 仍在收尾，安装资源/受控初始化/生产 Provider 的实际可用性应以届时安装物验收为准。本轮工作树已出现 `iris-memory-core init` 运维入口，但未验证该入口、wheel 或真实部署；不能继续按旧文档断言初始化完全不存在，也不能提前宣称发布门槛通过。

宿主只配置 Core base URL、业务凭据引用和明确 scope。可信测试操作者可用受控 CLI 初始化隔离库与凭据；Bellis 测试客户端只能用公共 API，不能靠 import Core Repository 或写数据库完成业务种子/效果验证。API 和 Worker 由独立服务部署负责，Bellis 不拥有其存储生命周期。

## 5. 本轮验证与限制

| 位置 | 实际执行 | 结果 |
| --- | --- | --- |
| Bellis | `pnpm --dir providers/memory-iris test` | 2 files / 23 passed，Fake Provider 与最小 Conformance |
| Bellis | `pnpm --dir providers/memory-iris typecheck` | 通过，消费当前已安装依赖；未重做干净安装 |
| Iris | `npm test --prefix sdk/typescript` | 构建通过，18 passed |
| Iris | `.venv/bin/python -m pytest tests/integration/test_observations.py tests/integration/test_phase6_usage.py tests/contract/test_phase10_asgi.py -q --no-cov` | 92 passed，2 条依赖弃用警告；Core 自身领域/ASGI 检查 |
| Iris | 临时只读 Python 探针：hash、ObservationDraft proof | 复现 R2/R3；未写业务数据 |

以上不等于 Bellis + Core E2E。没有运行真实双进程/Stage 记忆闭环、安装发布门槛、Core 全量 CI 或 Phase 4 Demo。本轮不修改业务源码、公共 Schema、SDK 版本或兼容矩阵；差异分别纳入 Phase 4 A0–A4，待实现和重新验证后才能标记完成。
