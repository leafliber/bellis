# Phase 4：契约与 Context

> 原构建计划的主题分册，保留原章节编号；章节目标不等于已交付能力。当前事实见 [实施状态](../../phase-4-implementation-status.md)，恢复 Gate 以 [ADR 0047](../../adr/0047-phase4a-recovery-scope-freeze.md) 为准。
> [返回构建指南](../../phase-4-development-guide.md)。跨分册的 § 引用按构建指南目录定位。

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

Phase 3 子任务 P99 验收缺口见 [构建与验收状态](../../build-and-validation.md)，必须单独记录，不能将命令通过等同原计划所有 Gate 完成。任何失败必须先区分环境、既有缺陷和 Phase 4 回归。不得在红色基线上新增 Memory 或 Presence 路径。

另外按 [Provider README](../../../providers/memory-iris/README.md) 重建 contracts/testkit 声明并运行独立包的 typecheck/test/build/lint/format。A0 记录 Core/SDK/Provider 版本、安装物摘要、锁文件、DB Schema、运行 capability 响应与 endpoint 白名单；本轮调研通过的 23/18/92 项测试只作为研究证据，不提前勾选 Gate。

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
[ADR 0005](../../adr/0005-memory-provider-seam-and-persona-ownership.md) 裁决，
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
  [ADR 0005](../../adr/0005-memory-provider-seam-and-persona-ownership.md) 冻结；
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
