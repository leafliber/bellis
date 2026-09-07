# Bellis Phase 4 构建指南：Iris 外部记忆接入与主动表现

> 2026-09-06 架构审查修订：任务所有权、工具恢复事实、调用列表范围、场景终态、Seq 分段预留及 Provider 接缝以 [ADR 0007](./adr/0007-task-ownership-and-runtime-scope.md) 为准。

> 2026-09-06 Iris 接入修订：以 [调研记录](./phase-4-iris-integration-research.md) 和 [ADR 0008](./adr/0008-iris-phase4-integration.md) 为依据，Phase 4 承接现有 Iris Provider 的兼容修复与宿主闭环；来源 hash、真实回写及验收分层以下文为准。

> 文档状态：Phase 4 构建基线（实施中）
> 阶段状态：Phase 4A 恢复范围已按用户决定冻结，见 [ADR 0047](./adr/0047-phase4a-recovery-scope-freeze.md)。本次收尾只复验、提交并停止；已运行证据见 [实施记录](./phase-4-implementation-status.md)。
> 历史起始基线：`e3fc7b4`（Phase 3 已合并）
> 本次调研基线：Bellis `dc3915e` / Iris `692de12` 的当前工作树，均有未提交收尾修改；A0 重新冻结实施与安装物基线，不将 HEAD 当成全部已验证内容。
> 上游基线：[Phase 3 完成态参考](./phase-3-reference.md)
> 上位设计：[系统架构设计](./architecture-plan.md) · [技术选型基线](./technology-selection.md)
> 既有约束：[ADR 0001](./adr/0001-canonical-core-and-wire-contracts.md) · [ADR 0002](./adr/0002-node-26-baseline.md) · [ADR 0003](./adr/0003-phase-2-scene-wire-and-browser-boundary.md) · [ADR 0004](./adr/0004-phase-3-decision-boundaries.md)

## 0. 如何使用本文

本文把技术路线中的“阶段四：记忆和主动表现”拆成可开发、可验收的纵向工作包。实施顺序为：

1. A0 复验 Bellis 基线，并对齐真实 Core/SDK/Provider 安装物、运行协商、身份与跨边界契约。
2. A1 在 Runtime 功能模块内复用 Iris 的 PersonaSource/MemoryProvider，完成有界 Context、身份/隐私校验、来源审计、Usage 与取消。
3. A2 接入实际输出确认和持久 Observe Outbox，完成输入观察、片段回写、远端 ACK、游标对账与重启恢复。
4. A3 补齐人格撤销、外部删除失效和 Iris Memory Tools；A4 通过真实 Core + Bellis + Stage 验收，形成“Phase 4A Iris 接入完成”证据。
5. 再推进 Phase 4B 的多 Provider、MCP、Presence/Avatar；全部阶段 Gate 通过才生成 Phase 4 完成态参考。P0–P6 保留为职责与验收目录，拆包不是前置。

本文中的目录、接口名、Migration、指标和命令是阶段交付目标，不是已经存在的稳定接口。仓库已有 memory 契约及 Iris 独立 Provider 原型，但宿主 Context/Memory/Persona/Avatar 纵向链路尚未交付；原型不构成 P0 或阶段 Gate 已通过的证据。本文受 [ADR 0006](./adr/0006-documentation-and-delivery-boundaries.md) 的输出确认、ACK、容量与更新语义约束。任何改变既有 `DecisionPacket`、Cycle adoption、Scene Commit、Control WebSocket 或恢复语义的决定，必须先经过 P0 Gate，并记录 ADR 或兼容说明。

### 0.1 本轮接入范围与外部依赖

首个生产记忆目标明确为 `iris_memory_core`，接入路径为 `providers/memory-iris` → 已安装的 `@iris-memory/sdk` → 独立 Core `/v1` 服务。Bellis 不打开 Core 的 SQLite、FAISS、队列或私有组件。Iris 的 Phase 11 当前 Deferred；本计划承担 Bellis 侧工作，不等待其恢复，也不改变 Core pip 发布范围。

| 归属                    | 本计划要求                                                                         | 不以何种状态代替完成                            |
| ----------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------- |
| Bellis Phase 4A         | Provider 兼容与映射、宿主 Context/Persona、Observe/Usage、Iris Tools、真实服务集成 | 现有原型/最小 Conformance 测试通过              |
| Iris Core/通用 SDK 收尾 | 可安装 API/Worker、受控初始化、版本协商一致、公共方法/错误/Abort/数字范围契约      | 只修改 SDK 类型、放宽 Schema 上限或使用私有组件 |
| Bellis Phase 4B         | 多 Provider 隔离、MCP、Presence/Avatar 与原完整阶段 Gate                           | 4A 通过不代表 4B 或整个阶段通过                 |

A0 可使用固定版本的本地 registry/候选安装物，不要求公开 npm/PyPI 或完整 Console 先完成。当前 SDK 0.11.2 使用仓库内不可变候选压缩包与冻结锁文件，正式 Provider 已发送协商后的事件检查点，安装与兼容证据见 [ADR 0044](./adr/0044-phase4-installed-checkpoint-sdk.md)。服务端所需公共能力或凭据初始化确实缺失时，登记具体上游契约问题，继续可独立完成的宿主工作；相应真实服务 Gate 保持未通过。现有工作树已有 `init` 运维入口，其安装可用性仍需验证。

### 0.2 Phase 4A 执行工作包

以下按顺序集成，每包结束即运行相应纵向检查，不等多个包建完才首次联调。A0 只冻结该链必需语义；MCP/Avatar 的 P0 在 Phase 4B 开工前补齐。

| 工作包                      | 实施内容与主要位置                                                                                                                                                                                                                 | 完成证据                                                                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A0 兼容与最小契约           | `providers/memory-iris`、`contracts/memory`、Testkit；固定 Core/SDK 安装物，核对运行协商与 Migration、错误/Abort、hash、Scope/actor、效果证明、Usage 血缘和四种水位；确定 Effect/Manifest/Outbox 增量 Migration                    | 当前真实 Core 公共 API 的适配探针；不兼容/非法 hash/partial proof/权限等负例；支持矩阵只列实测组合；Phase 1–3 基线复验                                                         |
| A1 Recall + Persona + Usage | `apps/runtime/src/application/phase-4/`；启动期人格就绪与单一生命周期；给 Decision Loop 注入可取消的 Context 构建 Port；扩展 `DurableCycleAdoption` 和 DB Worker 事务保存 Manifest 与 Usage Outbox；替换 Memory topic 的录制发布器 | 同一请求的 Recall 候选、实际模型输入、Persona Slot、三集合与 Core Usage 一一对应；Recall 超时 ≤250ms；adoption 回滚无 Usage；零 actor/跨域/低预算有明确结果                    |
| A2 输入/效果 Observe 与恢复 | Stage Lane/Control 确认、Runtime effect service、persistence 事务与现有 Outbox；可信输入受理投影、增量已确认片段、每 stream 连续 cursor、ACK 分类和持久对账                                                                        | 重复输入/确认不重复；未播放=0，取消保留已确认前缀；Core ACK 前后崩溃可重投；Worker 停机时仍可持久接收；恢复不重播 Scene                                                        |
| A3 更新与受控工具           | Iris Persona/SSE 生命周期、宿主 invalidation/tombstone；经现有 Tool Runtime 注册 search/remember/correct/forget；SDK 缺少的错误/取消能力由公共边界补齐                                                                             | Persona 刷新失败可追平、revoked 不走旧缓存兜底；Forget/隐私收紧拒绝热缓存及迟到结果；四工具真实调用、幂等/修订冲突/Legal Hold/unknown outcome；只开放通过 Gate 的 Surface 模式 |
| A4 真实服务验收与运行交付   | Runtime bootstrap/config、可重现 SDK/Provider 安装、独立 CI Job、真实 Core API/Worker + Bellis Runtime/DB Worker + Stage、恢复 Harness、接入说明                                                                                   | 连续 ≥100 Cycle；定义的双进程崩溃窗口各 ≥20 次；真实 Chromium partial/cancel/reconnect；安装/启动/停止/失效/凭据隔离/回退记录；完成清单逐项有证据                              |

首个可演示切片为 A0 + A1 + A2 的单次真实往返；A3/A4 未通过时只能标记部分完成。长期记忆事实源为 Iris，确定性本地 Provider/FakeIrisClient 只作对照与故障注入。

## 1. 阶段定义

Phase 4 对应 [技术选型基线 §20](./technology-selection.md) 的“阶段四：记忆和主动表现”，覆盖 [系统架构设计 §20](./architecture-plan.md) 中 Milestone 3 的主动角色核心和 Milestone 4 的外部记忆：

- 在每个 Cycle 的快照屏障内并行构建 Base、World、Audience、Tool Result 与 Memory Context；
- 由单一 Context Builder 执行来源标记、隐私过滤、冲突保留、排序、去重和 Token 预算；
- 通过稳定 `MemoryProvider` Port 先接入 Iris HTTP Provider，后续扩展确定性测试 Provider 和 MCP Adapter；
- 将记忆工具注册到既有 Tool Runtime，继续服从权限、调用列表并发、Deadline、取消和幂等约束；
- 在已提交事实之后通过 Outbox 异步 Observe，不把记忆写入放进直播响应关键路径；
- 通过 Avatar Mixer、Presence Engine 和资源仲裁，让角色在没有模型请求时仍自然表现；
- 让 Directed Scene 动作可靠抢占低优先级主动动作，并在结束或取消后自然恢复。

Phase 4 不替换 Decision Loop、Tool Runtime 或 Scene Director。Context 和 Memory 是能力供应者；Presence 是低优先级本地控制器；模型请求仍只有一个最终 `DecisionPacket`，所有 Directed Avatar 行为仍通过既有 Scene 路径生效。

### 1.1 阶段目标

Phase 4A 必须先完成 Iris 的真实纵向链路；下图列出 Phase 4A + 4B 的完整阶段目标：

```text
Simulated Audience / World / previous Tool Results
  → Cycle snapshot barrier
  ├─→ Base + Conversation + Audience + World contributions
  ├─→ Iris Memory Provider → 公共 SDK → Core HTTP API
  └─→ Deterministic Provider / MCP Adapter（Phase 4B）
  → Context Builder（privacy / provenance / conflict / dedupe / budget）
  → adopted Context Manifest + promptEpoch
  → ModelProvider → DecisionPacket
  → Tool Runtime（memory_search / remember / correct / forget）
  → Scene Director → Directed Avatar Cue

Committed Session Facts
  → Memory Observe Outbox
  → idempotent Provider observe
  → revision / tombstone / cache invalidation

Idle / reactive World State
  → Presence Engine（deterministic seed / cooldown / bounded scheduler）
  → Avatar Mixer / Resource Arbiter
  ← Directed Scene / LipSync / Safety priorities
  → Stage Avatar Adapter
```

验收场景必须同时证明：多个 Memory Provider 在共享 Deadline 内真实并行；一个超时 Provider 不拖住模型请求；模型可见的每个 Memory Block 可追溯到来源和 revision；显式遗忘产生 tombstone 并立即阻止旧缓存回注；Idle Presence 不发起模型请求；Directed Scene 抢占冲突通道后，Presence 在 Scene 完成或取消时恢复，且不出现动作跳变、定时器泄漏或过期行为补播。

### 1.2 完成指标

| 指标                              | Phase 4 验收目标 | 说明                                                                 |
| --------------------------------- | ---------------: | -------------------------------------------------------------------- |
| Context 构建本地路径 P95          |          ≤ 50 ms | 不含外部 Provider；固定 Fixture 与虚拟时钟验证                       |
| Memory 前台共享 Deadline          |           250 ms | 默认 200 ms，可配置 150–250 ms；不是每 Provider 依次等待             |
| 单 Memory Provider 超时的额外阻塞 |  ≤ 共享 Deadline | 其他贡献和模型请求继续，不串行叠加                                   |
| 模型可见 Memory Block 可追溯率    |             100% | `providerId`、`blockId`、revision、hash、privacy scope 均有审计      |
| 超预算模型输入                    |                0 | 预算前估算、组装后复核；确定性裁剪并记录原因                         |
| 显式遗忘后旧值重新注入            |                0 | tombstone/revision 优先于 L1/L2/Provider 旧结果                      |
| Observe 重试产生重复写入          |                0 | 至少一次 Outbox + Provider 业务幂等键                                |
| Idle Presence 模型请求数          |                0 | 主动眨眼、呼吸、注视和随机动作不唤醒 LLM                             |
| Directed 抢占冲突通道             |             100% | Safety/LipSync/Directed 优先级不可被 Presence 覆盖                   |
| Avatar 仲裁取消与释放 P99         |         ≤ 100 ms | 从 Scene/Session 取消到通道租约释放                                  |
| 有界资源                          |   全部显式且可测 | Block、Provider、Prompt、Observe、行为、通道、Timer 与状态流均有上限 |
| Phase 1/2/3 回归                  |         0 个失败 | 既有 Demo、浏览器、协议和恢复语义保持兼容                            |

公网时延只记录，不作为离线 CI 硬 Gate。Phase 4A 使用本机隔离部署的真实 Core API/Worker 验收，并单独记录 Core 接收、投影可见和宿主总延迟；离线 Fixture 与脚本化慢/错 Provider 不能替代该 Gate。Phase 4B 补本地 MCP 测试进程和并发测试。

## 2. 明确范围

### 2.1 本阶段实现

- `ContextContribution` / `ContextBlock` / `ContextManifest`、`promptEpoch` 和 Memory Query/Observe 的版本化契约；
- 有界 Context Contribution Pipeline、确定性排序/去重/冲突保留、隐私域检查和 Token 预算；
- Stable Prefix、Append-only Conversation 与 Dynamic Tail 的稳定组装边界；
- Memory Gateway、Iris Provider 的兼容修复与运行时接入、确定性测试 Provider、独立 Deadline/Abort/健康状态；多 Provider bulkhead 在 Phase 4B 扩展；
- Context Manifest 持久化与 tombstone 防回注；Memory 结果 L1/L2 缓存在失效可靠后启用，不是首个真实往返的前置；
- MCP v2 Adapter 的 stdio 与 Streamable HTTP 边界，至少完成一个本地协议纵向测试；
- Memory Tool 到既有 Tool Runtime 的注册适配，包括 search、remember、correct、forget 的权限和幂等策略；
- Scene/Cycle 已提交事实到 Memory Observe Outbox 的版本化投影、重试、死信与对账；
- `packages/avatar-runtime` 中的纯确定性 Avatar Mixer、Presence Engine、行为目录、通道租约和资源仲裁；
- Stage 侧主动表现状态流、Directed Cue 抢占/恢复、Recording/DOM Adapter 测试路径；
- Provider 插件缝：`@bellis/contracts` 的 `memory` 子路径导出、配置驱动的
  `MemoryProviderRegistry`、`@bellis/testkit` 的 Provider Conformance Harness；
- `PersonaSource` Port、人格确定性渲染器、Persona Slot 与启动期人格就绪门禁；
- Cycle adoption 事务内的 `memory.usage.v1` Outbox 投影与 Provider fan-out；
- `pnpm demo:phase4`、浏览器专项用例、恢复/隐私 Harness 和新增指标。

### 2.2 本阶段不实现

- 正式 Bilibili 或其他直播平台插件；Phase 4 继续使用已鉴权的模拟 Signal；
- Core 的内部认知引擎、存储/索引重构、Console 和发行工程；所需公共契约缺口按 A0 登记到 Core 收尾，不由 Bellis 访问私有组件绕过；
- 完整 Plugin SDK、Marketplace、第三方 UI、插件热更新或不可信插件通用隔离；
- 云端托管记忆产品、embedding 服务选型、向量数据库或跨设备同步；本地 Provider 可以使用确定性文本索引验证边界；
- 允许 Memory Provider 直接编辑 system prompt、旧对话、World State、DecisionPacket 或共享可变状态；
- 多模型路由、模型竞速、自动人格改写或基于记忆的隐式权限提升；本阶段**只消费**
  外部记忆系统已发布的人格，不注册任何人格写工具，不实现提案生成、评审 UI
  或自动发布（[ADR 0005](./adr/0005-memory-provider-seam-and-persona-ownership.md) 决策 3.6）；
- 正式 Cubism SDK/模型资产打包；CI 继续使用 Recording/DOM Adapter，授权资源只做显式手工 Smoke；
- TTS viseme 产品化、逐帧 Cubism 参数协议或通过 Runtime 发送每帧 Avatar 参数；
- 游戏输入、Rust Sidecar、OBS 产品化 Overlay 或 Studio 完整记忆管理 UI；
- 跨 Provider 自动合并身份；未经可信映射的相同用户名必须保持隔离；
- 在未确认 Provider 支持前承诺物理删除；不支持时必须返回明确状态并保留本地 tombstone。

## 3. 不可破坏的不变量

1. **单一 Context 所有权**：只有 Context Builder 决定模型最终看到哪些 Block；Provider 只能贡献候选内容。
2. **快照不可变**：一个模型请求采用的 Context Manifest 在该 Cycle 内不可修改；晚到结果只进入缓存或后续 Cycle。
3. **来源不可丢失**：所有外部内容必须携带 Provider、revision、hash、privacy scope 和 source refs；裁剪后仍可审计。
4. **不可信边界**：Memory、Audience 和 Tool Result 永远作为带来源的数据块进入 Dynamic Tail，不能成为 system 指令。人格是被显式授信的独立通道，但排在安全与直播规则之后，且不得声明工具权限、改写输出协议或放宽安全规则。
5. **共享前台 Deadline**：Provider fan-out 并行且共用总预算；慢 Provider 不能串行放大关键路径。
6. **身份与隐私隔离**：缓存、查询、记录与遗忘都包含可信 identity scope 和 privacy domain；禁止跨 Session/Profile/Viewer 泄漏。
7. **遗忘优先**：纠正、遗忘和隐私收紧的 revision/tombstone 优先于任何旧缓存、迟到响应和重试消息。
8. **Observe 不阻塞演出**：只有已提交事实进入 Observe Outbox；Provider 写入失败不得回滚 Cycle 或 Scene。
9. **副作用继续受控**：Memory Tool 继续经过 Tool Runtime 的权限、确认、幂等、资源锁、结果预算和审计。
10. **Presence 不拥有决策**：Presence 不调用模型、不生成 Speech、不提交 Directed Scene，也不能修改 Signal 水位。
11. **语义意图而非帧参数**：模型、Memory 和 Runtime 只传递语义 `AvatarIntent`/状态；帧级混合只在 Stage Adapter 内完成。
12. **确定性仲裁**：相同 Clock、World Snapshot、行为目录、Seed 和输入事件必须产生相同高层选择与抢占结果。
13. **高优先级绝不被覆盖**：Safety > LipSync > Directed > Reactive > Proactive > Base；低层不得写入未持有的通道。
14. **取消即释放**：Scene/Session 取消必须停止过期行为、释放租约和 Timer；恢复后不得补播已过期动作。
15. **测试与生产同路径**：Fake Provider/Clock/Adapter 只替换外部边界，不绕过 Builder、Gateway、Outbox、Mixer 或 Scene/Stage 协议。

## 4. 目标架构与依赖方向

```mermaid
flowchart LR
    SNAP["Cycle Snapshot"] --> CTX["Context Builder"]
    MEM["Memory Gateway"] --> CTX
    IRIS["Iris Provider / SDK / Core HTTP"] --> MEM
    LOCAL["Local Memory"] --> MEM
    MCP["MCP Adapter"] --> MEM
    CTX --> REQ["Model Request"]
    REQ --> LOOP["Decision Loop"]
    LOOP --> TOOL["Tool Runtime"]
    MEM --> TOOL
    LOOP --> PERF["Performance Port"]
    PERF --> DIR["Scene Director"]
    DIR --> MIX["Avatar Mixer"]
    WORLD["World / Avatar State"] --> PRES["Presence Engine"]
    PRES --> MIX
    MIX --> STAGE["Stage Avatar Adapter"]
    PERF --> EFFECT["Stage effect confirmation / durable record"]
    EFFECT --> OUT["Observe Outbox"]
    OUT --> MEM
```

后续独立使用需求得到验证后的拆包候选（不作为首条链路前置）：

```text
packages/
  context-builder/
    src/budget/
    src/assembly/
    src/privacy/
    src/cache/
    test/
  memory-runtime/
    src/gateway/
    src/registry/
    src/providers/local/
    src/adapters/mcp/
    src/observe/
    src/usage/
    test/
  persona-runtime/
    src/source/
    src/renderer/
    src/readiness/
    test/
  avatar-runtime/
    src/mixer/
    src/presence/
    src/behaviors/
    src/resources/
    test/
providers/                 # 独立插件过渡目录，不属于根 workspace
  memory-iris/              # Phase 4A 接入目标；当前独立安装，迁入 CI 后再调整 workspace
apps/
  runtime/src/application/phase-4/
  stage/src/avatar/
scripts/
  phase-4-demo.mjs
  phase-4-demo-child.mjs
```

依赖方向：

```text
contracts ← context-builder
contracts ← memory-runtime → tool-runtime
contracts ← avatar-runtime
       ↑           ↑
decision-loop ─────┘
       ↑
runtime application → persistence / observability
       ↓
performance port → scene-runtime / transport → stage → avatar-runtime
```

约束：

- `context-builder` 不依赖 Model SDK、Fastify、SQLite、MCP SDK、Stage 或具体 Provider；
- `memory-runtime` 不拥有 Turn/Cycle，不提交 Scene，不直接写 Prompt；
- `avatar-runtime` 的仲裁核心不依赖 React、DOM、Cubism SDK、WebSocket 或 Node Runtime；
- MCP Adapter 只做协议映射和能力收窄，不成为 Tool Runtime 或 Context Builder 的替代；
- Runtime Route 只做鉴权、边界校验和应用服务调用，不直接查询 Provider 或修改记忆；
- Directed Avatar Cue 继续走 Phase 2 Scene/Stage 协议；Presence 只通过受限低优先级入口进入 Mixer；
- `@bellis/testkit` 继续只出现在 devDependencies。
- `providers/*` 下的 Provider 与仓库外实现受同一约束：只依赖 `@bellis/contracts` 的
  `memory` 子路径，经 `MemoryProviderRegistry` 配置注册，必须通过 Conformance Harness；
  过渡期不入 workspace，本仓库 CI 保持离线可跑（[ADR 0005](./adr/0005-memory-provider-seam-and-persona-ownership.md) 决策 6）。

## 5. Gate 0：基线与语义冻结

### 5.1 开工前复验

从 A0 冻结的当前工作树/Commit 执行并保存结果，不回到历史起点覆盖收尾修改：

```bash
pnpm install --frozen-lockfile
pnpm --filter @bellis/stage exec playwright install chromium  # 首次运行/浏览器版本更新时
pnpm runtime:check
pnpm contracts:check
pnpm check
pnpm build
pnpm demo:phase1
pnpm demo:phase2
pnpm demo:phase2:crash
pnpm demo:phase3
pnpm test:browser
```

Phase 3 子任务 P99 验收缺口见 [构建与验收状态](./build-and-validation.md)，必须单独记录，不能将命令通过等同原计划所有 Gate 完成。任何失败必须先区分环境、既有缺陷和 Phase 4 回归。不得在红色基线上新增 Memory 或 Presence 路径。

另外按 [Provider README](../providers/memory-iris/README.md) 重建 contracts/testkit 声明并运行独立包的 typecheck/test/build/lint/format。A0 记录 Core/SDK/Provider 版本、安装物摘要、锁文件、DB Schema、运行 capability 响应与 endpoint 白名单；本轮调研通过的 23/18/92 项测试只作为研究证据，不提前勾选 Gate。

### 5.2 P0 必须冻结的语义

1. Context Contribution、Block、Manifest、来源引用和裁剪原因的版本化形态；
2. Stable Prefix、Conversation、Dynamic Tail 的所有权与 `promptEpoch` 变更条件；
3. 字符/Token 估算误差的安全余量、各类别预算、确定性排序和最终超限处理；
4. Provider identity、viewer identity、privacy domain 和 Session/Profile scope 的可信来源；
5. Provider fan-out 的总 Deadline、独立 bulkhead、取消、迟到结果和降级语义；
6. Block hash/revision、冲突、重复、过期、纠正、tombstone 与缓存失效顺序；
7. Memory Tool 名称映射、权限、确认、幂等键、缓存和结果大小规则；
8. MCP Resource/Tool 到 Memory Context/Tool 的允许映射以及 Prompt/路径/网络边界；
9. 哪些 Session Record 算“已提交事实”，何时原子地产生 Observe Outbox；
10. Observe 至少一次交付、Provider 业务幂等、部分失败、死信、对账与关闭顺序；
11. Avatar 通道、优先级、租约、互斥、淡入淡出、抢占和自然恢复语义；
12. Presence 的 Clock、Seed、行为选择、冷却、状态流、过载合并和 Session 恢复规则；
13. Directed Scene Cue 与低优先级 Presence 的 Stage 组合边界；
14. Cycle/Scene/Session 取消如何传播到 Memory fan-out、Observe 和 Avatar 资源；
15. `PersonaSnapshot` 形态、人格渲染器的确定性与 `rendererVersion` 语义；
16. 人格发布版本与瞬时状态分别进入 Stable Prefix / Dynamic Tail 的边界，以及
    人格侧 `promptEpoch` 四元组；
17. 启动期人格就绪门禁、四态降级与 `revoked` 的 fail closed 行为。

### 5.3 现有契约的复用与缺口

必须复用且不复制：

- `CycleSnapshotSchema`、`DecisionPacketSchema`、`AvatarIntentSchema` 和 `ToolResultSchema`；
- `ToolDeclaration`、工具调用列表、权限、缓存、锁和取消语义；
- ScenePlan、Cue、StageCapabilities 与 Control WebSocket 的身份/顺序/取消字段；
- Session Record、Outbox Message、Trace/UUID、十进制水位和 JSON-safe 值；
- Phase 3 Cycle adoption 与水位推进边界。

`ContextBlock`、`MemoryProvider` Port、Persona 归属、Stable Prefix 顺序、
`promptEpoch` 触发条件、Observe 片段粒度与使用回传已由
[ADR 0005](./adr/0005-memory-provider-seam-and-persona-ownership.md) 裁决，
P0 保留 ADR 0005 的人格归属和 ContextBlock 语义，并落实 ADR 0006 的修正；当前 Memory 专属 ContextContribution 不等于宿主通用贡献，Memory Tool Port 仍需冻结。已存在的原型类型不代表整个 P0 完成。

P0 需要评审但不预设一定放入 `@bellis/contracts` 的新增形态：

- `ContextContribution` / `ContextManifest`（`ContextBlock` 已由 ADR 0005 冻结）；
- `PromptEpoch` / Context Budget Report / Context Cache Key；
- `MemoryQuery` / `MemoryProviderCapabilities` / `MemoryObserveEnvelope`；
- `PersonaSnapshot` / `PersonaInvalidation` / `MemoryUsageReport`（形态见 ADR 0005）；
- `MemoryRevision` / Tombstone / Provider Health；
- Presence State、Behavior Definition、Avatar Layer/Channel Lease 和 Mixer Snapshot；
- Phase 4 Audit Payload 与恢复投影。

只有跨包、持久化、插件或 Wire 需要共享的对象进入 `@bellis/contracts`。Token 估算器内部状态、Provider 私有响应、MCP SDK 对象、Cubism 参数和逐帧 Mixer 数据不得冻成公共协议。

### 5.4 Context Manifest 与 Cycle adoption

Phase 3 的模型请求目前由 `CycleSnapshot` 直接组装 Prompt。Phase 4 必须把“模型当时看到了什么”变成显式、不可变、可审计的 Manifest：

- Context Builder 在模型请求前产生 Manifest 与确定性摘要；
- Provider 原始正文不写普通日志，Block 正文按隐私策略保存或只保存 hash/引用；
- Cycle adoption 原子记录最终 `DecisionPacket`、消费水位和被采用的 Manifest 摘要；
- 未 adoption 的 Cycle 不产生“已采用 Usage”；即使已经发起模型请求，也只记录请求遥测，不伪称模型从未见过输入；
- Memory 迟到结果不回写进行中的请求，只能缓存或参与后续 Cycle；
- 同一 Cycle 的审计回放必须使用已记录 Manifest，不能重新召回后伪装成原始上下文；恢复仍不重新请求模型或派发已采用 Scene。

Manifest 至少绑定 Cycle/modelRequest、固定身份/隐私版本、Persona Slot 四元组、每 Provider 的 Recall requestId/原始 returned/hostSelected/modelVisible、Recall persona revision、resource refs、来源 hash 方案及验证状态、原文/裁剪文本摘要、预算与排除原因。若正文仅留 hash，明确该记录只能核对来源/摘要，不能宣称可还原完整 Prompt；可回放正文使用有界、按隐私授权保存的不可变载荷。不要把 Core 数字水位、Token 估算或 confidence 缺失强转为 0。

若将完整 Manifest 纳入 adoption 会让单事务过大，P0 应冻结“预写不可变 Manifest + adoption 引用摘要”的两阶段方案，并证明孤儿 Manifest 可安全清理且不会被恢复路径误采用。

### 5.5 P0 交付

- Schema、类型、双 dialect 生成物和三方 Fixture 等价测试；
- Context Builder / MemoryProvider / PersonaSource / Observe / Avatar Mixer 公开 Port 草案；
- Context Manifest、Observe Outbox 与 Migration 兼容说明；
- 隐私/遗忘威胁模型、恢复矩阵和取消树；
- Phase 4B 开工前完成 MCP Adapter 本地协议 Spike，确认协议、Abort、子进程关闭及 HTTP 错误映射；不阻塞 A0 的 Iris HTTP 接入；
- 插件缝、`ContextBlock` 与人格归属已由
  [ADR 0005](./adr/0005-memory-provider-seam-and-persona-ownership.md) 冻结；
  若在 ADR 0005/0006 之外改变冻结边界，新增后续 ADR。

P0 Gate：

```bash
pnpm contracts:check
pnpm --filter @bellis/contracts typecheck
pnpm --filter @bellis/contracts test
pnpm check
```

## 6. P1：Context Contribution Pipeline

### 6.1 Contribution Port

Context Builder 接收声明式候选贡献，不允许贡献者写 Prompt：

```ts
// Phase 4 P0 待实现的宿主 Port；不是当前 contracts/memory 的 ContextContribution。
interface ContextContributionSource {
  readonly sourceId: string;
  contribute(
    input: ContextQuery,
    budget: ContributionBudget,
    signal: AbortSignal,
  ): Promise<AssemblyContribution>;
}
```

`AssemblyContribution` 是宿主通用 envelope，P0 冻结其 sourceId、section（conversation/audience/world/tool/memory/persona-state）、有界 blocks、来源审计和预算估计。每个 section 的信任等级由宿主注册策略赋予，不接受外部自报 trusted 或 role。

Base/Conversation/Audience/World/Tool Result 的本地贡献不需要 memory 的 mappingVersion、personaRevision 或召回路由字段。当前 `contracts/memory.ContextContribution` 只要求身份、版本与有界 blocks，mappingVersion、personaRevision 和召回路由等均为可选元数据；它仍是 Memory 响应，Gateway 先验证其 Schema、来源 hash 方案/完整性状态、identity/privacy，再通过明确适配进入 AssemblyContribution，原始 Memory metadata 进入独立审计字段。Memory 永远只能进入不可信 memory section，不能伪装成 Persona/Stable Prefix。

P0 Fixture 必须包含一个无记忆/人格元数据的 Audience 贡献，以及一个试图伪装 trusted Persona 的外部 Memory 贡献（拒绝）。Stable Prefix 仍由 Runtime 的已验证规则、Persona 渲染器和 Tool 目录共同构造，来源和所有权不得混淆。

### 6.2 快照屏障与并行构建

- 一个 Cycle 开始时固定 Signal watermark、World version、Conversation revision、Tool result set 和 identity scope；
- Base/Conversation/Audience/World 的本地构建与 Memory fan-out 并行；
- 所有前台贡献共用 Cycle Context Deadline，贡献者有更短的子 Deadline；
- Abort 后必须真正停止 Provider 请求、索引查询和等待者，不只丢弃 Promise 结果；
- Deadline 到达后 Builder 立即关闭候选集合，晚到结果不能进入本次 Manifest；
- 后续 Cycle 可以使用新 revision，但不得修改已采用 Manifest。

### 6.3 规范化、冲突与排序

每个候选 Block 至少经过：

1. Schema、字符数、Token 估算、source refs 和时间字段校验；
2. identity/privacy policy 过滤；
3. 按已验证的 Provider hash 方案处理 `contentHash`，保存验证状态；Iris 结构化来源摘要不等于 SHA-256(text)。独立计算原文 `textHash`，随后规范化并另存 `normalizedHash`，不得覆盖来源 hash（ADR 0008）；
4. 精确重复消除；
5. 同一事实的冲突分组，保留来源与 revision，不静默选“真相”；
6. 按必须项、当前相关性、显式优先级、置信度、新鲜度和稳定 tie-breaker 排序；
7. 按类别预算裁剪，产生 `included` / `excluded` 和确定性 reason；
8. 组装后再次检查总字符/Token 安全上限。

排序不得读取墙钟的瞬时值制造不可重放顺序。新鲜度基于已固定的 snapshot time 和 Provider 事实时间；相同权重使用 `sourceId + blockId + revision` 排序。

### 6.4 Prompt Epoch 与请求组装

模型输入保持三段结构：

```text
Stable Prefix（promptEpoch 内字节稳定）
  → Append-only Conversation
  → Dynamic Tail（Audience / World / Tool Results / Memory / interrupt）
```

- 角色设定、安全规则、输出协议或稳定 Tool Schema 改变时进入新 `promptEpoch`；
- 同 Epoch 的 System 内容和 Tool 顺序必须字节稳定；
- Memory Block 只进入 Dynamic Tail，显式标为外部不可信数据；
- Builder 输出结构化 Manifest；Model Adapter 只负责把 Manifest 渲染成 Provider 请求；
- Provider-specific prefix cache metadata 不进入核心契约，只记录有界遥测；
- Phase 3 的 `buildModelRequest` 应通过兼容包装迁移，不保留第二套 Prompt 所有者。

Conversation/最近发言投影也要区分“已计划说出”与“已确认生效”，不能把提交后的完整 speech 自动视为历史发言再经 Context/Observe 写回 Iris。A2 复用 effect record 投影实际输出；计划/未确认内容如需保留，只能作为明确标注的宿主执行状态。

### 6.5 缓存

Context Assembly Key 至少包含：

```text
session/profile identity scope
+ signal watermark
+ world/conversation/tool-result revisions
+ provider memory revisions or etags
+ promptEpoch
+ budget policy revision
+ privacy policy revision
```

- L1 为有界 Runtime LRU；L2 只保存允许持久化的 Manifest/Block 摘要；
- Phase 4A 首个切片不复用 Iris Recall 结果缓存；人格已验证缓存与 Manifest 存证仍按各自策略工作。启用 Recall 缓存前必须通过外部删除/SSE 断线/重启失效测试；摘要记录本身不能恢复 Block 正文；
- 缓存命中仍执行 tombstone 和当前 privacy policy 复核；
- Iris 缓存保留原 Recall requestId、完整 returned 集合和关联 Persona revision，Usage 不伪造新 request。若 Core 不再接受原请求的 Usage，重新 Recall 或显式不用该缓存；`cacheUntil`、`nextWakeAt` 只约束刷新，不触发模型/Scene；
- Provider 无 revision 时只能短 TTL，不能假装永久稳定；
- Context cache 不缓存最终模型决策；
- 所有缓存记录 hit/miss/stale/invalidated 及节省的毫秒/Token。

## 7. P2：Memory Gateway、Iris Provider 与 Persona

### 7.1 MemoryProvider Port

当前原型 Port 以 [`@bellis/contracts/memory`](../packages/contracts/src/memory/index.ts) 为唯一代码定义，本指南不复制另一份接口。它包含 `id/capabilities/provideContext` 以及可选 `observe/reportUsage/start/stop`。

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

宿主侧持久 generation、资源 tombstone、采用/输入/输出事务复核与旧消息抑制见 [ADR 0013](./adr/0013-phase4-memory-policy-transactions.md)。注册 Forget 与收到的外部删除事件已接通，后者见 [ADR 0022](./adr/0022-phase4-resource-invalidations.md)。生产四工具完整授权、事件历史缺口重验与普通纠正通知仍待交付。

### 7.4 确定性测试 Provider

本地 Provider 是与 Iris 共用宿主路径的离线测试实现，不建立第二套生产长期记忆系统：

- 使用有界内存 Fixture；恢复测试复用宿主 SQLite Worker/受控 Repository Port，不直接打开 Core 数据库；
- 提供确定性文本/标签索引，不以 embedding 或外部模型作为正确性前提；
- 支持 viewer、relationship、fact、episode、task 类 Block；
- search/read 为 pure 或 idempotent；remember/correct/forget 使用稳定业务幂等键；
- 每次纠正/遗忘递增 revision，遗忘写 tombstone；
- 读取始终先应用最新 tombstone/privacy revision；
- 大正文按 Block 预算截断，原始敏感数据不进入模型审计或普通日志。

待消费 Signal/Tool Result 的策略版本核验已接通，见 [ADR 0021](./adr/0021-phase4-local-input-privacy.md)。接纳版本与来源 Manifest 决定本地输入是否可见，完整当前批次的聚合信息继续保留；这不替代可信入口和证据授权。

本节 remember/correct/forget/tombstone 用于验证宿主行为；真实语义必须由 Iris 公共接口另验，不能因 Fixture 支持就宣称 Core 能力已接通。

### 7.5 PersonaSource 与 Persona Slot

Persona Source 管理、确定性 Renderer 和就绪门禁先在宿主功能模块中实现；若独立使用需求成立，再按 P2 的职责候选迁入 persona-runtime。
`subscribe` 可选仅适用于不可变 Source，或宿主已配置有界后台轮询的 Source。可变 Source 无订阅也无轮询时拒绝配置。
断线后按游标追平；没有游标的 Source 后台全量重验，不在 Cycle 前台请求。远端不可达时继续已验证发布版，但瞬时 state 仍按固定快照时间过期回 baseline。
发布内容 hash 仅覆盖稳定 core/traits/narrative，不含 state/fetchedAt/origin；进行中 Cycle 保持旧快照，revoked 则取消尚未采用的工作并阻止旧人格继续提交。

人格事实源在外部记忆系统，Bellis 只做消费与渲染
（[ADR 0005](./adr/0005-memory-provider-seam-and-persona-ownership.md) 决策 3）。
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

已实现的人格持久状态端口、版本冲突与后台请求边界见 [ADR 0012](./adr/0012-phase4-provider-state-and-persona-barriers.md)。该切片不替代资源 tombstone、隐私 adoption 屏障与完整恢复 Gate。

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

可信配置文件与固定启动入口已接入，见 [ADR 0041](./adr/0041-phase4-iris-launch-configuration.md)、[运行说明](./iris-runtime-operations.md) 和 [配置样例](./examples/iris-runtime.json)。该入口只接受凭据引用，默认支持范围与 Surface off 保持；输入身份授权、写工具装配和凭据轮换仍待完成。

- tenant、业务 appInstanceId 与能力由 Core 凭据派生；不能由模型、浏览器或弹幕提供。scope 只能收窄；日志/Prompt/Stage 不携带 token。
- Bellis Session ID 与 Core Session ID 显式映射并落盘；无映射的 session scope 配置拒绝启动，不能把随机 UUID 当作已有 Core Session。只使用 space scope 必须显式配置并接受其跨 Session 语义。 当前宿主只接受 `scope: { kind: "space", acknowledgeCrossSession: true }`，启动前落盘核对本地 Session 归属；Core Session 映射尚未支持，见 [ADR 0023](./adr/0023-phase4-explicit-memory-scope.md)。
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

Runtime readiness 已接入实际 Persona/隐私准入状态；明确鉴权拒绝锁定当前 Iris 实例，停止后台网络重试并持久封锁 Persona 回退。真实 Core 公开凭据撤销验证及范围见 [ADR 0042](./adr/0042-phase4-memory-readiness.md)。零重叠凭据轮换、私有引用替换及保留原事实的显式重启也已通过真实公开接口验证，见 [ADR 0043](./adr/0043-phase4-credential-rotation.md)。

SDK/HTTP Adapter 必须解析状态码和 ErrorEnvelope，不能把所有 4xx/5xx 都压成 ContractValidationError 后重试。Required Surface 只有服务端 Proof 检查与宿主行为都通过真实矩阵才可声明支持；首个单宿主集成可使用明确配置的 off 模式，不能暗中降低服务端 required。

SSE 历史缺口不能用过滤后游标是否连续判断。Core 新增的可协商事件身份校验及 SDK 可选参数见 [ADR 0029](./adr/0029-phase4-event-checkpoint-identity.md)；公开契约和 Bellis 成对身份持久化已实现。宿主持久缺口屏障见 [ADR 0030](./adr/0030-phase4-history-gap-barrier.md)：暂停采用及投递，保留已确认事实和原 Outbox，真实隐私撤销继续独立生效。Provider 已接入事件 410 与旧状态缺少身份的持久报告，重启继续保持屏障；正式成对校验请求、公开全量重验与解除仍待接入。重验范围的持久清单、分批读取、快照变化检测见 [ADR 0031](./adr/0031-phase4-history-revalidation-inventory.md)；遍历完成不代表远端重验通过。

公开 Claim Correct 及其撤回引起的 Claim/Relation 级联现已在 Canonical 事务中产生旧修订失效事件，见 [ADR 0032](./adr/0032-phase4-claim-correction-events.md)。真实 Worker 停止期间通知仍能取消 Bellis 旧 Context，有限截止值允许后续有效修订进入新 Context；其他资源修改通知及完整公共重验仍待完成。

Recall 的首次响应发布与原请求重放现已在各自事务中重验候选和 Persona，失效返回冲突并保持原 Usage 血缘，见 [ADR 0033](./adr/0033-phase4-recall-replay-revalidation.md)。此处单响应核验不能替代缺口清单的跨请求一致性与安全解除。

已新增只读公开批量核验 `POST /v1/recall:revalidate`，以完整原请求指纹检查存档集合，在单个读取快照中返回逐项结论，见 [ADR 0034](./adr/0034-phase4-recall-batch-revalidation.md)。宿主已在实际发送前持久保存完整准备请求，重启后的清单正文与真实 HTTP 请求一致并通过公开核验，见 [ADR 0035](./adr/0035-phase4-original-recall-requests.md)。准备记录不证明远端收到。核验批次和逐项结论已持久绑定清单与原请求摘要，见 [ADR 0036](./adr/0036-phase4-history-verification-records.md)；清单变化使旧结论和迟到响应失效。独立维护核验通道与清单分批调度已接通，见 [ADR 0037](./adr/0037-phase4-recall-revalidation-coordinator.md)；发送前复核真实隐私屏障，旧策略请求仍待明确授权。持久恢复发现和宿主取消归属见 [ADR 0038](./adr/0038-phase4-history-recovery-discovery.md)：复用有效 runId，隐私变化或关闭先取消旧维护任务。受控后台轮询、暂时失败重试和在途容量约束已接入，见 [ADR 0039](./adr/0039-phase4-background-history-recovery.md)。可信恢复配置已接入 Runtime 启动与运行期缺口状态，维护期间关闭决策入口并保持 readiness 503，见 [ADR 0040](./adr/0040-phase4-runtime-history-recovery.md)。全部事实覆盖、跨批次一致性和安全解除继续实施。

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

原始模型调用的事务保存与 Session 所有权基础见 [ADR 0014](./adr/0014-phase4-original-tool-calls-and-session-ownership.md)；实际请求持久化/确认见 [ADR 0016](./adr/0016-phase4-prepared-tool-requests.md)，四工具注册及必需的可信授权端口见 [ADR 0017](./adr/0017-phase4-iris-tool-registration.md)，Forget 屏障与回执事务见 [ADR 0018](./adr/0018-phase4-forget-coordination.md)。目标预览及确认后公开读取核验见 [ADR 0020](./adr/0020-phase4-iris-tool-target-verification.md)；生产意图/证据授权、真实 Legal Hold/保护对象和完整公共恢复 Gate 尚未完成。

现有 SDK 的上述方法需补 Abort/稳定 ErrorEnvelope 映射后才开放。公共传输及宿主未知结果的实施与未完成 Gate 见 [ADR 0015](./adr/0015-phase4-iris-tool-transport-outcomes.md)。若超时后远端可能已提交，按原键/公共结果对账；不能报告“取消所以肯定未写”，也不能生成新键再写。Forget 返回的 target/erased/protected/held 计数要如实呈现；Canonical 逻辑删除、物理清除与 Legal Hold 分开。发起 Forget/收紧隐私时先立宿主读屏障，成功后持久 tombstone；确定拒绝时按冻结策略解除或保留屏障，结果未知则持续封锁至对账完成。

### 8.3 本地协议契约测试

本地 MCP Harness 至少验证：

- stdio/HTTP 握手、Resource Context、Tool read/write/forget 正常路径；
- 取消能终止挂起请求，stdio 子进程退出且无残留句柄；
- 重复 Tool 名、非法 Schema、超大正文、未知字段和断流 fail closed；
- 401/403/429/5xx、重定向、超时和连接重置映射为稳定错误；
- secret、Authorization、Cookie、私有 Block 与 Server stderr 不进入日志；
- Provider 恢复后只影响后续 Cycle，不改写历史 Manifest。

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

当前已实现实际 DB/WAL 占用驱动的新工作准入与 ready 状态，见 [ADR 0024](./adr/0024-phase4-disk-admission.md)；数据库页分配另受 [ADR 0025](./adr/0025-phase4-database-page-limits.md) 的连接级硬限制。检查点受旧快照阻塞时的后续写入拦截见 [ADR 0026](./adr/0026-phase4-wal-write-fence.md)。单次提交缓存检查与当前 Worker 写入的 WAL 边界见 [ADR 0027](./adr/0027-phase4-transaction-capacity.md)；活动 Scene 的独立持久收尾额度、最大形状测试与确认事务崩溃窗口见 [ADR 0028](./adr/0028-phase4-completion-reservations.md)；整个目录上限、操作系统实际耗尽与完整恢复矩阵仍未证明，不替代上述完整容量 Gate。

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

## 10. P5：Avatar Mixer、Presence 与 Stage 装配

### 10.1 Avatar Mixer

Mixer 接收六层语义输入：

| 层        | 默认优先级 | 来源                                |
| --------- | ---------: | ----------------------------------- |
| Safety    |        100 | reset、断线、异常恢复               |
| LipSync   |         90 | 音频/viseme 或包络                  |
| Directed  |         80 | DecisionPacket → Scene Director Cue |
| Reactive  |         60 | 礼物、胜负、加载等确定性反应        |
| Proactive |         20 | Presence 注视、空闲和受约束随机行为 |
| Base      |         10 | 呼吸、眨眼、基础物理                |

- 每个 Intent 声明 channels、priority、duration、fade、interruptible、exclusive 和 mutex tags；
- Mixer 以通道租约仲裁，不允许低层直接写其他层持有的参数；
- 相同优先级使用稳定来源顺序和 intent identity 决胜；
- 抢占生成显式 `suspended/preempted` 状态，结束后按策略恢复或重新选择，不从过期时间点继续；
- 不支持的 motion/expression 由 Adapter 做语义替代或安全忽略，并记录有界原因；
- 帧级权重、Cubism 参数和插值留在浏览器 Adapter，不进入 Control WS。

### 10.2 Presence Engine

Presence 长期运行但必须有界：

- 基础眨眼、呼吸、轻微姿态和注视不调用模型；
- 行为目录声明 weight、cooldown、required/forbidden tags、channels、mutex 和 max duration；
- 使用注入的单调时钟和可记录 Seed；生产随机源只在 Session/epoch 边界播种；
- World/Avatar State 通过最新值可合并流输入，不排队消费过期状态；
- 行为选择考虑说话、工具等待、当前情绪、最近动作和通道占用；
- 连续重复、单位时间行为数、Timer 数和待执行行为数均有限制；
- 需要语言或长期规划的主动话题只发出受控 Signal 候选，由 Decision Trigger 决定是否唤醒 LLM。

### 10.3 抢占与自然恢复

```text
Presence owns eyes/body
  → Directed Scene requests body/expression
  → Mixer fades/suspends conflicting Presence channels
  → Directed Cue starts at Scene T0
  → Scene finishes or is cancelled
  → leases released
  → Mixer returns through neutral blend
  → Presence re-evaluates current World State and selects fresh behavior
```

- Directed Scene 不能等待低优先级行为自然结束；
- 不冲突通道可以并行，例如 LipSync mouth 与 Presence eyes；
- Safety reset 立即抢占所有相关通道；
- 取消必须撤销目标 Scene 的租约，不清空其他 Scene/基础层仍有效状态；
- 恢复使用当前状态重新评估，不补播抢占期间错过的随机行为。

### 10.4 Stage 与协议

- 现有 Recording/DOM Avatar Lane 是兼容基线，不能删除来让新路径通过；
- Directed Cue 继续使用现有 `sceneId/cueId/sequence/targetTime`；
- 新增状态流时必须有 schemaVersion、session/stage identity、sequence、容量和重连快照；
- 浏览器真实时钟仍由 `AudioContext`/Stage 单调时钟映射，不读取墙钟调度 Cue；
- React 只负责页面和调试视图，Mixer/Cubism 帧循环不进入 React State；
- Stage 重连先进入 Safety/Base，再应用权威快照，不重放过期 Presence delta；
- 未配置授权 Cubism 资源时，Demo 和 CI 必须由 Recording/DOM Adapter 完整通过。

## 11. P6：Runtime 纵向装配、测试与 Demo

### 11.1 Phase 4 Host

Runtime 装配：

```text
authenticated simulated signal
  → Phase3 Signal Pipeline / Trigger
  → Phase4 snapshot barrier
  → ContextBuilder + MemoryGateway + 已预取 PersonaSnapshot
  → DecisionLoop
  ├─→ ToolRuntime + Memory Tools
  └─→ PerformancePort → SceneDirector → Stage Avatar Mixer
Committed facts → Observe Outbox → Memory Providers
World/Avatar state → Presence Engine → Mixer
```

- 一 Session 一 Context/Loop 所有权，Provider 和 Presence 都不推进 Loop；
- Credential 只由 Credential Port 注入 Provider/MCP Adapter，不进入 Prompt、浏览器或 Session 正文；
- 配置更新通过 revision/promptEpoch 生效，不在进行中的 Cycle 或 Scene 中途改写；
- bootstrap 增加显式 Iris 配置与单一实例所有权；禁用配置时保持 Phase 3 路径，无隐藏网络请求。启动失败清理已打开的 Provider/订阅/Lease；业务 appInstanceId 不使用随机进程 instanceId 代替；
- 使用现有 `Phase3DecisionHost`/`DecisionLoop` 的扩展 Port 连接 Context；`request-assembly.ts` 保留兼容入口。持久采用逻辑通过 `DurableCycleAdoption` → `PersistenceClient` → DB Worker 同事务扩展，不在采用成功后补写关键投影；
- 关闭顺序为停止 Ingress → 取消 Context fan-out/Turn → 结算 Scene → 停止 Presence → 停止 Observe Claim → 关闭 Provider/Stage/DB；
- 生产默认不开放模拟输入或任意 MCP Server；只有显式配置和权限目录可装配。

### 11.2 测试矩阵

- **Schema/契约**：Context、Memory、Observe、Avatar State/Lease 的双 dialect 和未知版本；
- **单元**：预算、排序、去重、冲突、隐私、revision、tombstone、行为选择、通道仲裁和恢复；
- **性质**：总 Token 不超限、同输入同 Manifest、隐私不跨域、遗忘不回注、低优先级不覆盖高优先级、取消后无租约；
- **集成**：真实 DB Worker、Context adoption、Tool Runtime、Outbox、MCP stdio/HTTP、Control WS；
- **Iris 公共消费**：独立 SDK 安装物 → 真实 Core API/Worker，验证当前版本、Scope/actor、hash、partial proof、Usage 集合/版本、更新撤销、工具与 Cursor/ACK；Fixture/mock_server 不替代该项；
- **浏览器**：真实 Chromium 中 Idle Presence、Directed 抢占、LipSync 并行、取消和恢复；
- **恢复**：Manifest 预写/adoption 前后、Observe publish 前后、tombstone/cache 竞态、Stage 重连；
- **压力**：Provider 慢/挂/大结果、Observe 积压、World State 洪峰、行为目录大、频繁 Scene 抢占；
- **安全**：记忆 Prompt 注入、跨身份读取、越权写/忘记、MCP 恶意 Schema/路径、Secret Redaction Canary；
- **长时**：缓存、Provider 子进程、Timer、通道租约、WebSocket 和 Worker 无持续增长。

确定性逻辑使用 `VirtualClock`、固定 Seed 和固定 Provider Fixture。MCP 契约测试只连接本地测试进程，不依赖公网、真实账号或商业配额。

### 11.3 Phase 4 Demo

`pnpm demo:phase4` 必须自动启动真实 Runtime 子进程、DB Worker、Control/Media WebSocket、协议 Stage 客户端和本地 Memory/MCP 测试 Provider，执行：

1. 两个 Provider 并行召回，一个按时返回关系记忆，一个超过共享 Deadline；
2. Context Builder 采用按时 Block，记录来源/revision/hash，超时 Provider 明确降级；
3. 模型基于已采用记忆回答，Directed Avatar Scene 抢占正在运行的 Presence；
4. Scene 完成后 Presence 通过中性过渡恢复，Idle 期间模型请求数保持不变；
5. `remember` 经 Tool Runtime/权限/幂等键写入，下一 Cycle/Turn 可召回；
6. 重复 Observe 投递不产生重复记忆；
7. `forget` 生成 tombstone，清除热缓存并拒绝迟到旧 revision 回注；
8. 紧急 Signal 取消慢 Context/Tool/Scene，释放 Avatar 通道；
9. Runtime 重启后 Manifest 仍可审计、Observe 可恢复、过期 Presence 不补播；
10. 关闭后无 Worker、子进程、Socket、Timer、租约、等待者或临时文件残留；
11. Persona 发布版切换翻转 Epoch，瞬时 state 更新不翻转；revoked 立即封锁原人格，不走同身份静态兜底；仅普通断网可按未撤销验证缓存恢复；
12. 输出确认前崩溃不产生虚构 assistant 观察，远端 ACK 前崩溃会由宿主重投，磁盘高水位停止新准入且保留活动场景确认配额。

成功输出至少包含稳定证据行：

```text
phase4-demo: ok
context=ok(blocks=<n>,tokens=<n>,overBudget=0,traceable=true)
memoryFanout=ok(parallel=2,timedOut=1,deadlineMs=<number <= 250>)
memoryRevision=ok(remembered=1,observeDuplicate=0,forgottenReinjected=0)
presence=ok(idleModelRequests=0,behaviors=<n>,repeatViolation=0)
avatarArbitration=ok(preempted=1,recovered=1,leakedLeases=0)
interruptLatencyMs=<number <= 100 + harness tolerance>
recovery=ok(manifestStable=true,observeDuplicate=0,staleBehaviorReplay=0)
```

浏览器 E2E 另证明真实 Stage 的 Directed/Presence/LipSync 通道组合与取消路径；它不复测外部 Provider 网络质量。

### 11.4 阶段完成命令

以下命令在 Phase 4 完成时必须存在并通过：

```bash
pnpm install --frozen-lockfile
pnpm --filter @bellis/stage exec playwright install chromium  # 首次运行/浏览器版本更新时
pnpm check
pnpm build
pnpm contracts:check
pnpm test:browser
pnpm demo:phase1
pnpm demo:phase2
pnpm demo:phase2:crash
pnpm demo:phase3
pnpm demo:phase4
```

真实 Iris 本机集成是 Phase 4A 的**必需**独立 CI/验收 Job，环境未配置时报告未执行，不能将 skip 算作 A4 通过。公网 MCP、商业 Provider 或授权 Cubism 仍为独立可选 Smoke，不作为根离线 `pnpm check` 的依赖。

### 11.5 Phase 4A Iris 专项验收

以下命令从 Bellis 根目录执行。当前 `test:memory:iris` 和 `demo:phase4:iris` 已实现；前者覆盖公共边界与可信输入，后者增加真实 Chromium 输出/取消闭环。新增 `test:memory:iris:continuous` 已通过同一组真实进程的 100 Cycle 及逐轮 Manifest/Persona/Recall/Usage 审计，见 [连续验收](./phase-4-continuous-validation.md)。`test:memory:iris:recovery` 已接入 Manifest/adoption/Usage 三个窗口、Observation HTTP 三个窗口及 SSE 两个真实进程窗口，完整恢复矩阵仍未完成，当前入口报告 incomplete/退出 2；见 [恢复验收](./phase-4-recovery-validation.md)。短闭环不代表下表 A4 完成。接入需固定 Core 安装物和公开 API，所有临时服务绑定 loopback 并使用隔离数据目录。

```bash
pnpm test:memory:iris          # Provider 契约/真实 Core 公共消费，包含安装物身份检查
pnpm demo:phase4:iris         # 三轮 Recall/Persona/Usage/确认输出 Observe 闭环
pnpm test:memory:iris:continuous # 100 Cycle 真实连续纵向及逐轮持久记录审计
pnpm test:memory:iris:recovery # Phase 4A：冻结的 8 窗口 × 3 目标 × 20 次 = 480 例
```

| 验收层         | 运行路径                                                            | 通过条件                                                                                                                            |
| -------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 安装与版本     | 已安装 SDK/Provider → 隔离安装 Core API/Worker                      | 不 alias Core/SDK 源码；清单、迁移与协商解释一致；没有 Console/公网 registry 隐式前置；缺必需能力拒绝                               |
| 连续纵向       | 真实 Runtime/DB Worker + Core/Worker + Stage，固定模型/TTS 测试边界 | ≥100 Cycle，逐次比对 Persona Slot 与 Recall revision、Manifest/预算、Usage 三集合、合法 assistant Observation；调用真实 memory 路径 |
| 输入与输出事实 | 可信模拟观众 → 真实 Stage 确认 → Core 公共读取                      | 输入身份隔离；零输出确认时 assistant 观察=0；partial/cancel/fail 只记已确认增量；字幕/音频不重复，proof 被 Core 接受                |
| 浏览器         | Chromium 实际音频/字幕 Lane、重连与取消                             | receipt 来自实际应用/渲染；绑定代际、内容摘要及 segment；不以协议 Stage mock 代替真实 Lane；不宣称测得物理扬声器发声                |
| 更新与隐私     | Persona 发布/state/revoke、Forget、凭据收紧、SSE 断线               | 同快照稳定；state 不翻 Epoch；撤销失败关闭；旧 Block/缓存/迟到结果/历史重投回注=0                                                   |
| 工具与 Surface | 四类工具的真实 Core 调用                                            | 权限/确认/幂等/修订冲突/取消/未知结果/Legal Hold 正确；每种声称支持的 Surface 模式均有 Proof/Fencing 证据                           |
| Phase 4A 恢复 | 冻结的 8 窗口分别终止 Runtime、Core API、Core Worker，每组合 20 次 | 480/480；原有 Canonical/幂等/Manifest/隐私断言全部通过，聚合返回 covered-windows-passed，命令退出 0 |

根据用户明确决定及 [ADR 0047](./adr/0047-phase4a-recovery-scope-freeze.md)，Phase 4A 恢复范围在已通过 480/480 时显式冻结：

- Cycle/Usage 三窗口：Manifest 形成/adoption 前、adoption 后/Usage ACK 前、Usage ACK 后/宿主 delivered 前，共 180 例。
- Observe 三窗口：Observe 已持久化/HTTP 发布前、Core 已提交/ACK 未转发、SDK 已确认/宿主 delivered 前，共 180 例。
- SSE 两窗口：pending-persisted-before-host-ack、policy-committed-before-provider-cursor，共 120 例。

每个窗口均覆盖 Runtime、Core API、Core Worker，重复次数保持 20，现有断言和组合不变。顶层按实际用例数、预期用例数和 requiredRepetitions 计算状态；断言失败仍退出 1，缺 Core 安装仍退出 2 并报告 NOT RUN。对每个窗口保留“未发生 / 已持久化 / 结果未知”的不同期望。

原剩余项整体归入 [Phase 4B 待办](./phase-4b-backlog.md)：采用事务内部中断、Stage 效果耦合和新增组合、效果/Observe 投影事务前后、旧快照与 cursor 扩展、磁盘/WAL 配额与活动 Scene 预留及扩展恢复。既有 Stage 与快照专项证据继续保留；这些扩展不再是 Phase 4A 恢复通过条件，也不能通过自动添加待办扩大这 480 例的验收范围。本文其他章节提及的扩展恢复/容量目标按该归属解释；Phase 4B 未完成不使已通过的 Phase 4A 恢复 Gate 失败。

A4 交付接入配置样例（仅凭据引用）、兼容矩阵、运行/重启/对账/停用说明和原始验收摘要；配置关停 Iris 时停止新查询及投递，但保留 pending/删除账本供恢复。需要回退二进制时先验证 Manifest/Outbox Migration 读兼容，不回改历史 checksum，也不通过恢复旧缓存复活删除内容。

## 12. 后续职责候选与完整阶段验收

以下图表描述当前实施顺序。A0–A4 在宿主功能模块内串起 P0/P1/P2/P3（Iris Tools）/P4/P6；原 P? 编号是职责标签，目录仅为后续拆包候选。

```mermaid
flowchart TD
    A0["A0 基线 / Iris 安装兼容 / 最小契约"] --> A1["A1 Persona / Recall / Manifest / Usage"]
    A1 --> A2["A2 输入与效果 Observe / ACK / 恢复"]
    A2 --> A3["A3 更新撤销 / 隐私 / Iris Tools"]
    A3 --> A4["A4 真实服务验收：Phase 4A"]
    A4 --> B0["补齐 Phase 4B P0"]
    B0 --> B1["多 Provider / MCP / 缓存"]
    B0 --> B2["Presence / Avatar / Stage"]
    B1 --> G1["Gate 1 完整组件边界"]
    B2 --> G1
    G1 --> G2["Gate 2 完整阶段回归 / Demo"]
```

| 工作包 | 主要修改范围                                                                                                               | 禁止越界                                                                      |
| ------ | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| P0     | `packages/contracts/**`、必要 ADR、Migration/Port 设计                                                                     | 不实现 Route、Provider 业务或 Avatar 帧循环                                   |
| P1     | 首先宿主 phase-4 Context 模块与 Decision request assembly Port；后续 `packages/context-builder/**` 候选                    | 纯组装逻辑不连接 MCP/DB，不拥有 Cycle                                         |
| P2     | 首先 `apps/runtime/src/application/phase-4/**` 与 `providers/memory-iris/**`；后续 `memory-runtime`/`persona-runtime` 候选 | Gateway 不写 Prompt；Persona Renderer 只渲染已验证 Persona Slot，不拥有 Cycle |
| P3     | Iris 独立工具适配、宿主 Tool 注册；后续 `packages/memory-runtime/src/adapters/mcp/**` 与 `src/tools/**`                    | 不绕过 Tool Runtime 权限与结果预算                                            |
| P4     | 宿主 effect/Observe/Usage、`packages/persistence/**`；后续 memory-runtime 候选                                             | 不在前台等待远端 ACK；磁盘高水位按 §9 停止新准入                              |
| P5     | `packages/avatar-runtime/**`、`apps/stage/**`                                                                              | 仲裁核心不依赖 React/Cubism/WS，不调用模型                                    |
| P6     | `apps/runtime/**`、必要 Observability、`scripts/demos/phase-4-*`、E2E/恢复 Harness、CI/根脚本                                    | 只通过包根和公开 Runtime/Stage 入口集成                                       |

确有独立工作需要并行时，使用同一已通过的边界基线。跨职责变更先说明接口、兼容影响、最小变更和验证方式。

## 13. Gate 清单

### 13.1 Gate 0：Contracts、隐私与恢复语义

A0 先完成 Iris 必需子集；Avatar/MCP 项在 Phase 4B 开工前冻结，不让整个 P0 成为第一条真实链的前置。

- Phase 3 全量基线通过；
- Iris 当前安装物、SDK 消费、capability/DB Schema 一致性、hash 方案、partial proof、ErrorEnvelope、身份/数字边界已核实；
- Context Block/Manifest、promptEpoch、预算和裁剪顺序无歧义；
- identity/privacy scope 有可信来源，跨域读取默认拒绝；
- Provider Deadline、迟到结果、revision、冲突、纠正与遗忘语义明确；
- Memory Tool 继续服从 Tool Runtime 权限/幂等/确认；
- Observe 与已提交事实、Outbox 和恢复边界明确；
- Avatar 通道、优先级、抢占、淡入淡出、Seed 与取消语义明确；
- 新 Schema 已生成双 dialect 并通过等价 Fixture。

**Phase 4A 单独退出条件**：A0–A4 及 §11.5 全部通过；包括真实 Recall/Persona/Usage/Observe、工具、更新撤销/遗忘、实际 Stage 确认、安装物和恢复证据。不得以离线 Provider 测试通过替代，也不得因此勾选尚未实施的 Presence/MCP Gate。

### 13.2 Gate 1：核心组件公开边界

- Context Builder、Memory Gateway、Persona/Avatar 核心只经明确的模块/包公开 Port 交互；不以拆成四包作为通过条件；
- P2 的 Persona Renderer 同快照字节稳定；瞬时 state 更新不改变 promptEpoch，版本/rendererVersion 变更才翻转；
- Persona 启动就绪、verified-cache/static-fallback、revoked、可选订阅的后台追平策略通过 Harness；
- Context 输出确定性、有界、来源完整且隐私隔离；
- Provider fan-out 并行、独立隔离，取消后无等待者；
- tombstone 能压过缓存命中、迟到响应和重试写入；
- Presence 同输入同 Seed 可重放，不调用模型；
- Directed/Safety/LipSync 优先级和通道租约性质测试通过；
- Phase 3 request assembly、Tool、Performance Port 可通过兼容适配迁移。

### 13.3 Gate 2：Phase 4 完成

- Phase 4A Iris 真实接入 Gate 已通过，所有声明支持的 Core/SDK 组合有安装与运行证据；
- 两 Provider 并行 Context 纵向链路通过，慢 Provider 不拖住回答；
- Persona 启动、更新、撤销、断线和重启缓存通过 Runtime 纵向测试，Cycle 内零网络等待；
- Observe 远端 ACK 前崩溃可重投；片段确认乱序/重复/取消、队列满载与预留配额通过故障测试；
- Manifest 采用、重放和模型可见来源审计完整；
- remember/correct/forget 与 Observe 幂等、恢复、tombstone 不回注通过；
- MCP stdio/HTTP 本地契约、关闭与安全测试通过；
- Idle Presence、Directed 抢占、取消和自然恢复在 Chromium 中通过；
- Context/Scene/Avatar 取消满足时延指标，关闭无资源泄漏；
- Redaction Canary、低基数 Metrics 和 Trace Continuity 通过；
- Phase 1/2/3 Demo 与协议回归全部通过；
- 文档从规划更新为实现事实，并新增 Phase 4 完成态参考。

## 14. Metrics 与 Trace

保留 Phase 1/2/3 指标名称，新增候选目录：

- `bellis_context_build_duration_ms{result}`；
- `bellis_context_blocks_total{source,result}`；
- `bellis_context_tokens_total{section,result}`；
- `bellis_context_cache_total{layer,result}`；
- `bellis_memory_query_duration_ms{provider,result}`；
- `bellis_memory_blocks_total{provider,result}`；
- `bellis_memory_revision_events_total{kind}`；
- `bellis_memory_observe_total{provider,result}`；
- `bellis_memory_observe_backlog{provider}`；
- `bellis_memory_usage_total{provider,result}`；
- `bellis_memory_reconciliation_total{provider,result}`；
- `bellis_persona_readiness{source,state}`、`bellis_persona_refresh_total{source,result}`；
- `bellis_presence_behaviors_total{behavior,result}`；
- `bellis_avatar_preemptions_total{from_layer,to_layer}`；
- `bellis_avatar_channel_conflicts_total{channel,result}`；
- `bellis_avatar_release_latency_ms{reason}`。

标签必须来自启动期有界目录。Block ID、revision、identity、viewer/user ID、Session ID、行为实例 ID、MCP Server URL、错误正文和记忆文本只进入 Trace/结构化审计字段，不进入 Metric label。

Trace 关系：

```text
sessionId / traceId
  → audienceBatchId
  → turnId
  → cycleId / contextManifestId / modelRequestId
  │   ├─→ memoryQueryId / providerId / block refs
  │   ├─→ toolRunId / memory revision
  │   └─→ sceneId / cueId
  → observeOutboxId / provider delivery
  → presenceEpoch / behaviorInstanceId / avatar lease
```

所有跨异步边界必须显式传播 TraceContext。Provider 原始响应、Memory Block 正文、MCP stderr、Viewer 私有数据和逐帧 Avatar 参数默认不写普通日志。

## 15. 故障与恢复矩阵

| 故障点                          | Context/Cycle            | Memory/Observe                                         | Avatar/Scene                         | 恢复行为                               |
| ------------------------------- | ------------------------ | ------------------------------------------------------ | ------------------------------------ | -------------------------------------- |
| Provider 查询中超时             | 候选未采用，其他贡献继续 | 可使用合规短期缓存                                     | 无影响                               | 晚到结果不进当前 Cycle                 |
| Manifest 生成后、模型前崩溃     | 未采用                   | 无该 Cycle Usage/assistant Observe，已受理输入独立交付 | 无 Scene                             | 孤儿 Manifest 可清理，不视为模型已见   |
| 模型后、adoption 前崩溃         | Manifest 未采用          | 无该 Cycle Tool/Usage/assistant Observe                | Prepare 丢弃                         | 不推进水位；保留请求遥测，输入观察独立 |
| adoption 后、Scene 前崩溃       | Manifest 已引用          | Usage pending，无虚构 assistant Observe                | Scene 服从 Phase 2                   | 不重问模型；按记录对账                 |
| Observe publish 后、mark 前崩溃 | Cycle 不回滚             | 至少一次重投，业务幂等                                 | 无影响                               | 不产生重复记忆                         |
| remember 运行中崩溃             | Cycle 已采用             | idempotent 可对账；未知则 uncertain                    | Scene 独立                           | 非幂等绝不自动重试                     |
| forget 后旧查询迟到             | 新 revision 生效         | tombstone 拒绝旧 revision                              | 无影响                               | 缓存失效，不重新注入                   |
| MCP stdio 子进程崩溃            | 该 Provider 降级         | 在途失败/可重试分类                                    | 无影响                               | 后续 Cycle 可重连，当前 Manifest 不变  |
| Directed Scene 取消             | Context 无变化           | Observe 记录真实取消                                   | 释放 Directed 租约                   | 中性过渡后 Presence 重选               |
| Stage 断线                      | Cycle/Scene 按既有规则   | Observe 独立                                           | Safety/Base，丢弃过期 Presence delta | 重连应用权威快照，不补播旧行为         |
| Runtime 重启                    | 读取已采用 Manifest      | Lease 回收/tombstone 先加载                            | 新 Presence epoch/Seed               | 不恢复旧 Timer 或过期动作              |

恢复逻辑必须基于版本化持久化事实、revision/tombstone 和权威快照，不能根据日志顺序、进程内 Map、Provider 猜测或浏览器残留 DOM 推断。

## 16. 风险与禁止捷径

- 不把 MCP SDK、外部 Memory SDK 或 Cubism SDK 类型导出为核心契约；
- 不让 Memory Provider 返回完整 Prompt、system role 或可执行指令；
- 不以 `Promise.all` 串行 fallback 掩盖共享 Deadline 和真正取消；
- 不使用未验证用户名、昵称或模型推断自动合并身份；
- 不为了缓存命中跨 privacy domain 复用 Block；
- 不在 tombstone 之后接受旧 revision 的迟到响应或重试写入；
- 不把 Observe 放入模型请求、Cycle adoption 或 Scene Commit 的前台等待路径；
- 不让 Memory Tool 绕过 Tool Runtime 直接执行写入/遗忘；
- 不用模型判断 Context 冲突、裁剪或权限；这些必须确定性执行；
- 不把 Presence 变成第二个 Agent Loop，也不为眨眼、呼吸、注视调用模型；
- 不通过 Control WS 发送逐帧 Live2D 参数或让 React State 驱动帧循环；
- 不让 Presence/Reactive 输入绕过 Mixer 直接写 Adapter；
- 不以真实公网 MCP、商业记忆账号、私有 Live2D 模型或未授权 SDK 作为 CI 前置；
- 不删除或改写 Phase 1/2/3 Demo 来让新架构看似通过；
- 不在 Phase 4 顺带建设正式平台插件、游戏输入或完整 Plugin SDK。

## 17. 阶段交付格式

每个工作包交付时报告：

```text
任务：Phase 4A / A?（职责 P?）或 Phase 4B / P?
状态：完成 / 部分完成 / 阻塞

基线：
- 起始 Commit
- Gate 检查结果

改动：
- 文件/包
- 公开接口
- Migration/协议/兼容影响

不变量：
- 本包证明了什么
- 哪些由后续包证明

验证：
- 执行命令
- 关键证据

隐私与恢复：
- identity/privacy 影响
- revision/tombstone/Observe 行为

风险：
- 已知限制
- 后续交接
```

Phase 4 完成后删除临时分支、文件所有权和执行提示，只保留完成态参考、稳定协议、测试和必要 ADR。

## 交付顺序与解释优先级（ADR 0007/0008）

首个工作包按 §0 的 A0–A2 在 Runtime 功能模块内复用 Iris PersonaSource/MemoryProvider 与实际效果后的 Observe，随后以 A3/A4 关闭更新、工具和真实服务验收。ADR 0008 修订来源 hash、Iris 交付归属与验收范围；ADR 0007 的单一任务所有者与先纵向后拆包继续有效。

ContextContribution 的路由、映射、人格关联元数据为可选字段；本地简单检索器不需要这些字段。Gateway 仅在 Provider 声明并返回对应能力时解释扩展；缺失不伪造为 0 或默认人格。Persona 必须从独立 PersonaSource 获取，召回只能提示失效。Iris 独立包的契约变更必须与宿主同时验证。
