# ADR 0005：Memory Provider 插件缝与 Persona 归属——由外部记忆系统接管人格记忆

> 2026-09-06 架构审查修订：任务所有权、工具恢复事实、调用列表范围、场景终态、Seq 分段预留及 Provider 接缝以 [ADR 0007](./0007-task-ownership-and-runtime-scope.md) 为准。 本文保留历史决策/实施过程；与新决策冲突的描述不再作为当前实现要求。

> 状态：Accepted（历史决策保留）；决策 4 的提交时机，以及 ACK、容量、分类和 Persona 更新解释由 [ADR 0006](./0006-documentation-and-delivery-boundaries.md) 修正。以下保留原始决策供追溯。
>
> 日期：2026-09-05（初版）/ 2026-09-05（决策 6 修订）
>
> 决策范围：`MemoryProvider` Port 的插件化边界、`ContextBlock` 冻结形态、
> Persona 事实源归属与渲染边界、Stable Prefix 顺序、`promptEpoch` 触发条件、
> Observe 片段粒度、Provider 降级与就绪门禁
>
> 关联文档：[Phase 4 构建指南](../phase-4-development-guide.md) ·
> [系统架构设计 §13/§14](../architecture-plan.md) ·
> [ADR 0001](./0001-canonical-core-and-wire-contracts.md) ·
> [ADR 0004](./0004-phase-3-decision-boundaries.md)
>
> 外部对端：Iris Memory Core `0.11.0`（Schema 11、Contract 1.9.0、
> OpenAPI 85 路径、48 capability）

## 背景

Phase 4 构建指南 §5.3 把 `ContextBlock`、`MemoryQuery`、
`MemoryProviderCapabilities`、`MemoryObserveEnvelope` 列为"需要评审但尚未冻结"
的形态。同时，第一个真实外部 Provider（Iris Memory Core）已经完成其
Phase 0–10，具备可被宿主真实调用的 HTTP 传输层、完整召回协议、
使用回传协议与完整 Persona 生命周期。

这带来两个必须现在裁决、之后改就是破坏性变更的问题：

1. **Provider 边界是否足以承载第一方之外的实现**。当前 §7.1 的 Port 草案
   缺少生命周期与使用回传，`ContextBlock` 的字段集对外部 Provider 有损。
2. **人格（Persona）由谁拥有**。架构设计 §14.1 把"角色设定"放在 Stable Prefix
   首位，由 Runtime 配置提供；但 Bellis 仓库至今没有任何 Persona 实现——
   它只在 6 行文档中出现，`packages/` 与 `apps/` 中零代码。与此同时，
   外部记忆系统已经实现了完整的人格记忆：不可变发布版本、可衰减的瞬时状态、
   策略治理、证据驱动的演化提案、人工评审、回滚与历史。

本 ADR 不改变 ADR 0001 的规范形态，不改变 Phase 3 的 Cycle adoption 与水位语义，
也不改变 Phase 4 的任何宏观能力边界。它冻结新增边界，并把人格的**事实源**
移出 Bellis。

## 决策

### 1. Provider 插件缝

`MemoryProvider` 是**可被仓库外实现**的插件 Port。为此：

- **1.1** `@bellis/contracts` 增加 `memory` 子路径导出，作为插件唯一依赖面：
  `MemoryProvider` / `PersonaSource` Port、`ContextBlock` /
  `ContextContribution`、`MemoryQuery` / `MemoryProviderCapabilities`、
  `MemoryObserveEvent` / `MemoryUsageReport`。外部插件**只允许**依赖这一个
  子路径，不得依赖 `runtime` / `persistence` / `transport` / `scene-runtime`。
- **1.2** Port 增加可选生命周期 `start(ctx)` / `stop()`。Provider 需要持有连接、
  后台刷新、租约心跳与有界本地队列；本仓库自己的 MCP stdio Adapter（§8.1
  要求建立与优雅关闭）同样需要它。
- **1.3** Port 增加可选 `reportUsage(report, signal)`，见决策 5。
- **1.4** 新增 `MemoryProviderRegistry`：配置驱动注册，不修改核心即可挂载
  Provider。**这不是完整 Plugin SDK**——不含热更新、沙箱隔离、Marketplace
  与第三方 UI，构建指南 §2.2 的排除项全部保持排除。
- **1.5** `@bellis/testkit` 增加 Provider Conformance Harness。第一方本地
  Provider 与任何外部 Provider 跑同一套边界测试（不变量 15）。

Gateway 仍然拥有 Deadline、bulkhead、预算、隐私域与健康短路。
Provider 仍然只能贡献候选内容。

### 2. `ContextBlock` 冻结形态

在 §13.2 草案基础上增加四个字段、放宽一个字段：

```ts
interface ContextBlock {
  id: string;
  revision: string;             // 十进制字符串，复用 common/decimal-string
  contentHash: string;          // 来源存证，见 2.1
  text: string;
  category: "viewer" | "relationship" | "fact" | "episode" | "task";
  providerCategory?: string;    // 新增：Provider 原始分类，保留来源语义
  placement: "working" | "memory";  // 新增：预算池归属
  priority: number;
  confidence?: number;          // 放宽为可选，见 2.2
  tokenEstimate: number;
  expiresAt?: number;
  privacyScope: string;         // 宿主可信 identity/privacy domain
  privacyLabels?: readonly string[];  // 新增：Provider 声明的标签
  conflictHint?: "conflicts" | "redundant";  // 新增：冲突分组输入
  sourceRefs: readonly string[];
}
```

- **2.1 `contentHash` 是来源存证，不是规范化摘要。** 构建指南 §6.3 步骤 3
  要求"文本规范化后复核 `contentHash`"。对外部 Provider 这必然失败——
  Provider 的 hash 算在它自己的 canonical 正文上。裁决：`contentHash` 只对
  Provider 返回的原始字节校验；Builder 若需要去重，另行计算并存储
  `normalizedHash`，两者不混用。
- **2.2 `confidence` 改为可选。** 相关性得分与置信度是不同语义，Provider 只有
  相关性排序时不得伪造 confidence。缺失时 §6.3 步骤 6 退到稳定 tie-breaker
  （`sourceId + blockId + revision`），不猜测。
- **2.3 `category` 保持闭枚举，未知值 fail closed。** Provider 分类落在枚举外时
  丢弃该 Block 并写审计，绝不从文本猜测类别。原值保留在 `providerCategory`。
- **2.4 `privacyScope` 仍由宿主拥有**（§7.3：identity scope 只能由已鉴权映射
  或本地 Profile 产生）。Provider 的标签进入 `privacyLabels`，不得压成单值，
  也不得反向决定 `privacyScope`。
- **2.5 `sourceRefs` 使用可逆 URN**，形如 `<provider>:<type>:<id>@<revision>`，
  保证裁剪后仍可完整还原来源（不变量 3）。

### 3. Persona 归属：事实源移出 Bellis

**Bellis 不再拥有人格事实。** 人格的长期记忆、瞬时状态、演化治理与历史
由外部记忆系统拥有；Bellis 拥有人格的**表达**与**安全边界**。

| 层 | 归属 | 理由 |
| --- | --- | --- |
| 安全与直播规则、输出协议、稳定 Tool Schema | **Bellis Runtime**，不可被外部覆盖 | 宿主安全边界 |
| 人格身份、性格、叙事（core / traits / narrative） | **外部记忆系统** | 长期人格记忆，跨宿主共享 |
| 人格瞬时状态（心情/能量，随时间衰减回 baseline） | **外部记忆系统** | 对端已实现 decay + baseline 归位 |
| 人格演化策略（locked / manual / bounded_auto、可改字段集） | **外部记忆系统** | 治理归事实源 |
| 演化提案、人工评审、发布、回滚、历史 | **外部记忆系统** | 见决策 3.6 |
| 人格**渲染**为 Stable Prefix 文本 | **Bellis** | Prompt 单一所有权（不变量 1）不可外包 |
| 取不到人格时能否开播 | **Bellis** | 宿主决定就绪性 |

#### 3.1 结构化数据，不是 Prompt 文本

`PersonaSource` 返回**结构化 JSON 数据**，不是一段 system prompt。Bellis 用
自己的确定性模板渲染。这同时满足三件事：外部系统无法注入指令；Bellis 保持
Prompt 单一所有权；渲染模板与人格版本是两个独立演进维度。

```ts
interface PersonaSource {
  readonly id: string;
  start?(ctx: PersonaSourceContext): Promise<void>;
  stop?(): Promise<void>;
  current(agentId: string, signal: AbortSignal): Promise<PersonaSnapshot>;
  subscribe?(onInvalidated: (e: PersonaInvalidation) => void): Disposable;
}

interface PersonaSnapshot {
  agentId: string;
  revision: string;            // 十进制字符串
  contentHash: string;
  policyMode: "locked" | "manual" | "bounded_auto";
  core: PersonaFields;         // JSON-safe，有界深度与大小
  traits: PersonaFields;
  narrative: PersonaFields;
  state: {                     // 瞬时层，可为 null
    fields: PersonaFields;
    baseline: PersonaFields;
    expiresAt: number;
  } | null;
  effectiveFrom: number;
  fetchedAt: number;
  origin: "live" | "verified-cache" | "static-fallback";
}
```

`PersonaFields = Record<string, JsonValue>`，复用 `common/json-value`。
深度、键数与总字节有显式上限；超限即拒绝该快照，不截断后使用。

`PersonaSource` 由 **Runtime 配置**拥有，**不由 Memory Gateway 调度**——
它不共享记忆的前台 Deadline，也不受"不可信数据只进 Dynamic Tail"的约束，
因为它是被显式授信的宿主配置来源，而非模型可见的召回内容。

#### 3.2 Stable Prefix 重排

架构设计 §14.1 的顺序改为：

```text
Stable Prefix
  - 安全与直播规则      ← 提到首位，Runtime 拥有，Persona 永不覆盖
  - Persona Slot        ← 由 PersonaSource 渲染
  - 稳定工具 Schema
  - 输出协议
```

人格一旦成为外部可变数据，就不能排在安全规则之前。这是 §2.2
"基于记忆的隐式权限提升"排除项的直接推论。Persona 不能声明工具权限、
不能改写输出协议、不能放宽安全规则；渲染器对这三类内容的键一律丢弃并告警。

#### 3.3 两条独立时间轴

人格有两个变更节奏，混用会击穿模型 Provider 的前缀缓存：

- **发布版本（revision）**：慢，人工或评审后发布 → 进入 **Stable Prefix**，
  变更时产生新 `promptEpoch`。
- **瞬时状态（state）**：快，且会衰减 → 进入 **Dynamic Tail** 的一个
  `trusted: true` / `placement: "working"` 块，**不影响 `promptEpoch`**。

架构设计 §14 要求"动态记忆放在尾部，不每次改写 System Prompt，以保留前缀
缓存命中"——本裁决是该要求在人格上的直接落实。

参与 `promptEpoch` 计算的人格输入是三元组
`(agentId, revision, contentHash)` 加上渲染器的 `rendererVersion`。

#### 3.4 预取，不进 Cycle 关键路径

架构设计 §8.3 规定"Persona、规则和工具 Schema 在插件变化时编译，不在每次
请求时重建"。因此：

- `start()` 时拉取并渲染，缓存已编译结果；
- `subscribe()` 接收对端失效通知（外部系统已推送 `persona.revised.v1` 与
  `revision.invalidated.v1` 两类事件，带游标可断线续传）→ 后台重新拉取 →
  **原子换入** → 产生新 `promptEpoch`；
- Cycle 内只读已编译结果，**零网络等待**；
- 换入发生在 Cycle 边界之外。进行中的 Cycle 继续使用其快照人格
  （不变量 2：快照不可变）。

#### 3.5 降级与就绪门禁

| 情况 | 行为 |
| --- | --- |
| 启动时对端不可达，有已验证磁盘缓存且 hash 校验通过 | `origin: "verified-cache"`，标记 degraded，允许开播 |
| 启动时对端不可达，无缓存，配置了 `staticPersona` | `origin: "static-fallback"`，标记 degraded，允许开播 |
| 启动时对端不可达，无缓存，无静态配置 | **not ready，拒绝开播**——不使用过期或未知人格 |
| 运行中对端不可达 | 继续使用已验证的已编译人格，不降级、不重拉；恢复后按 subscribe 追平 |
| 召回响应携带的人格版本/哈希与已编译不一致 | 立即作废缓存并后台重拉；**当前 Cycle 继续用旧值**（不变量 2） |
| 发布版本状态为 `revoked` | **立即 fail closed**：降级到 static-fallback，无则 not ready |

Runtime 配置中的 `staticPersona` 从"事实源"降级为"离线兜底"。这是本决策的
实质：Bellis 配置不再定义角色是谁。

#### 3.6 演化提案不进 Phase 4

外部系统的人格演化由其后台反思流水线从已提交观察中生成提案，经策略评估与
人工评审后发布。Bellis Phase 4：

- **只消费**已发布人格，**不注册任何人格写工具**；
- 不实现提案生成、评审 UI 或自动发布；
- 通过 `subscribe()` 感知发布结果。

构建指南 §2.2 的"自动人格改写"保持排除。人格演化的**治理**在事实源一侧，
Bellis 侧仍然是只读消费者。

### 4. Observe 片段粒度

只有已提交且**实际生效**的输出可以形成外部系统的 assistant 观察：

| Bellis Scene 事实 | 外部 Observe |
| --- | --- |
| `completed` | 提交，正文 = 已确认生效的片段 |
| 部分输出（流式/语音中断） | 只提交已确认 segment 范围 |
| `cancelled` / `failed` / 未播放 | **不提交** |
| 已结算 Tool Result | 按映射提交 |

为此 Scene commit 记录必须携带**已确认输出片段范围**（§9.1 目前只要求提交
高层事实）。这是新增的持久化字段，进入 Phase 4 Migration。

### 5. 使用回传

在 Cycle adoption 记录 Manifest 的同一事务内，新增 Outbox 投影
`memory.usage.v1`，fan-out 给声明了 `usageReport` capability 的 Provider：

```text
returned     = Provider 本次返回的全部 blockId
hostSelected = Manifest.included
modelVisible = 组装后复核，实际渲染进模型请求的集合
```

走 Outbox 因此天然不阻塞当前回复（不变量 8），失败按既有重试/死信语义处理。

### 6. 修订（2026-09-05）：第一方 Iris Provider 落在 `providers/memory-iris/`

初版假定外部 Provider 都在仓库外实现。落地核查后，第一个真实 Provider
（Iris Memory Core 的适配器）改为**落在本仓库内**，位置 `providers/memory-iris/`。

理由：`@bellis/testkit`（含决策 1.5 的 Conformance Harness）与 `@bellis/contracts`
全部 `private: true`，仓库外实现必须先整体翻转本仓库 10 个包的发布姿态；且 Phase 4 P0
期间 `ContextBlock` 与 `MemoryProvider` 仍在迭代，同仓库内契约与消费方可在一个 commit
内共同演进。对端记录见 Iris `docs/adr/0020-bellis-adapter-plugin-seam.md` §11.1。

**插件缝的语义不变**：`providers/memory-iris/` 与仓库外实现受完全相同的约束——
只依赖 `@bellis/contracts` 的 `memory` 子路径，不依赖 runtime、persistence、transport
或 scene-runtime；经 `MemoryProviderRegistry` 配置驱动注册；必须通过同一套 Conformance
Harness。它是"住在仓内的插件"，不是核心包，因此放在 `providers/` 而不是 `packages/`。

**过渡期**：`providers/*` 暂不列入 `pnpm-workspace.yaml`。该 Provider 依赖
`@iris-memory/sdk`，当前只在本机私有 registry 上，CI 无法解析。过渡期内它经
`link:../../packages/contracts` 取得契约包（与 `workspace:*` 同为符号链接，
契约共演化照常成立），本仓库 CI 保持离线可跑与全绿。`@iris-memory/sdk` 转公开
发布后，`providers/*` 并入 workspace、`link:` 换 `workspace:*`、门禁纳入 `pnpm check`。

**代价**：过渡期内该 Provider 不在本仓库 CI 覆盖内。这是有时间盒的，
关闭条件写在 Iris 阶段 11 的退出门禁里。

## 后果

### 正面

- 外部记忆系统可以作为进程内插件接入，不修改 Bellis 核心。
- 人格获得版本、证据、审计、回滚与跨宿主共享能力，这些 Bellis 自己不打算实现。
- 安全规则上移到 Stable Prefix 首位，收紧了不变量 4。
- 人格状态走 Dynamic Tail，前缀缓存命中率不因情绪变化而下降。
- 第一方本地 Provider 与外部 Provider 走同一 Conformance Harness。

### 负面与代价

- P0 冻结面变大：新增 `PersonaSource`、`PersonaSnapshot`、
  `MemoryUsageReport` 三组契约与一个渲染器。
- Bellis 就绪性新增一个外部依赖方向：无缓存且无静态兜底时拒绝开播。
  通过 `staticPersona` 配置可完全规避。
- Scene commit 记录新增片段范围字段，进入 Phase 4 Migration。
- 人格渲染器成为新的确定性要求点：同一快照必须字节稳定，否则
  `promptEpoch` 会无谓翻转。Conformance Harness 必须覆盖。

### 不受影响

Phase 4 的 15 条不变量逐条不受影响：单一 Context 所有权（决策 2 只增加候选
元数据）、快照不可变（决策 3.4 明确在 Cycle 边界外换入）、共享前台 Deadline
（人格不在关键路径）、Observe 不阻塞演出（决策 4/5 走 Outbox）、副作用受控
（不注册人格写工具）、Presence 不拥有决策（无关）。Phase 1/2/3 的协议、
Cycle adoption 与恢复语义全部原样保留。

## 备选方案与否决理由

1. **人格作为一个普通 Memory Block 进入 Dynamic Tail。**
   否决：违反人格需要进入稳定前缀的性质，每 Cycle 重复计费，且把授信内容与
   不可信召回内容混在同一通道，削弱不变量 4。
2. **Provider 直接返回渲染好的 system prompt 文本。**
   否决：外部系统即可注入指令，破坏 Prompt 单一所有权。
3. **Bellis 自建人格系统，外部系统只做召回。**
   否决：需要在 Bellis 内重建版本、证据、策略、评审与回滚，与
   "不实现第二套记忆"的方向矛盾，且两套人格必然漂移。
4. **等 Phase 4 完成后再对齐契约。**
   否决：`ContextBlock` 一旦冻结，本 ADR 的六处字段裁决全部变成破坏性变更；
   而当前它们尚在 §5.3 的未冻结清单中，现在裁决边际成本接近零。

## 明确不做

- 不实现完整 Plugin SDK：无热更新、无沙箱隔离、无 Marketplace、无第三方 UI。
- 不把外部记忆 SDK 的类型导出为 Bellis 核心契约。
- 不在 Bellis 内实现人格提案生成、评审界面或自动发布。
- 不允许 Persona 声明工具权限、改写输出协议或放宽安全规则。
- 不让 Bellis CI 依赖运行中的外部记忆服务；第一方本地 Provider 仍是 CI 基线。
