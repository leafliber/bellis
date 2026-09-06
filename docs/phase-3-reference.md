# Bellis Phase 3 完成态参考：Decision Loop

> 文档状态：已交付核心参考（原 Gate 2 子任务 P99 验收仍开放）
> 实施指南：[Phase 3 开发指南](./phase-3-development-guide.md)（含工作包分解与验收标准）  
> 上游基线：[Phase 2 完成态参考](./phase-2-reference.md)  
> 协议：[Persistence & Recovery](./protocols/persistence-and-recovery.md) · [Scene Execution](./protocols/scene-execution.md)  
> 决策：[ADR 0001](./adr/0001-canonical-core-and-wire-contracts.md) · [ADR 0002](./adr/0002-node-26-baseline.md) · [ADR 0003](./adr/0003-phase-2-scene-wire-and-browser-boundary.md) · [ADR 0004](./adr/0004-phase-3-decision-boundaries.md)

## 1. 阶段结论

Phase 3 在 Phase 2 演出链路前加入真实决策循环（架构设计 Milestone 1
决策侧 + Milestone 2 工具循环）：

```text
Simulated Audience Signals
  → Signal Ingress（Schema 校验/确定性优先级/单调序号/去重/容量拒绝）
  → Adaptive Audience Batcher（200–500ms 自适应窗口;count/token/byte 封窗;
                              urgent 立即旁路;闭区间连续）
  → Decision Trigger（idle/next_cycle/next_turn/interrupt;Mailbox 合并不拒绝）
  → Cycle snapshot + 有界请求组装（确定性 Prompt;不可信数据块标明来源）
  → ModelProvider 流（事件契约:一请求一 final;重复/缺失/未知工具拒绝）
  → exactly one validated DecisionPacket（或唯一确定性安全包）
  → durable Cycle adoption（原子:cycle 行+水位+tool_runs planned+Record）
  ├─→ Phase 2 Performance Port（submitDecision 稳定边界）→ Scene Director → Stage
  └─→ Tool Runtime（DAG 编译/并行/锁/权限/缓存/取消）→ Tool Results
        → 下一 Cycle（固定新水位,不改历史快照）
  → Session Records / Trace / Metrics / 恢复投影
```

单一 Loop 所有权、一请求一行动、采用前不生效、Action 与 Tool 并行、
水位单调、非幂等不自动重放等功能不变量由下列测试覆盖；这不等于原计划的性能 P99 已获证明。当前验证入口与剩余项见 [构建与验收状态](./build-and-validation.md)。

## 2. 交付形态

| 位置 | 交付 |
| --- | --- |
| `packages/contracts` | IngestedSignal/SignalPriorityClass、CycleSnapshot/RecentUtterance、ToolExecutionMode/ToolSemantic/ToolRunState/ToolOutcome/ToolCacheSource/ToolResult、8 个 `phase3_*` 审计 Payload（双 JSON Schema 生成物 + Zod/Ajv2020/AjvDraft7 三方 Fixture 等价） |
| `packages/decision-loop` | SignalIngress（串行入库）、InMemorySignalStore、AudienceBatcher（自适应窗口/五种封窗触发/urgent 旁路/区间连续）、确定性聚类（归一化分组/权重/审计保留）、DecisionTrigger（四路分类;interrupt 回收未采用 Batch 合并区间并集;requeueFront;Mailbox 溢出合并）、SignalPipeline（恢复/单调时钟循环/关闭传播）、ModelProvider Port + 事件契约、ScriptedModelProvider、StreamAssembler（事件规则强制/工具参数 JSON+Schema/终包复核）、确定性降级、有界请求组装、SHA-256 包摘要、DecisionLoop（Turn/Cycle 状态机/预算/Deadline/空转/超时真 Abort/adoption 失败不推进/Scene∥Tool 分派/取消树/未采用回插） |
| `packages/tool-runtime` | ToolDeclaration 注册期校验（声明矛盾/无界 Timeout/同名冲突）、DAG 编译（dependsOn/环/背景依赖/超 8 节点/深度 4/keyed 锁键/参数 Schema）、StandardToolRuntime（parallel_read 并行/exclusive/keyed 串行/总并发+每 Tool 上限/Deadline+真 Abort/取消传播/依赖失败显式化）、权限门（Capability 逐次/confirm fail closed/非幂等必须幂等键）、L0 single-flight + L1 LRU + L2 Port、结果 JSON-safe/结构化截断/敏感脱敏、background 不阻塞 |
| `packages/persistence` | Migration 0004（决策表）+ 0005（来源去重/无损序号索引）、7 个 RPC 操作（append/restore/adopt_cycle/tool_run_event/read_decision_state/cache_get/cache_set;双侧 Schema 编解码）、adoptCycle 原子事务（重放幂等）、恢复时 running→uncertain |
| `apps/runtime` | PerformancePort 稳定边界（Phase2PerformanceService.submitDecision;Phase 2 submit 兼容包装）、PerformancePortAdapter、Phase3DecisionHost（总装+证据采集+恢复投影）、Demo 工具集（并行只读/缓存/keyed 脱敏/非幂等独占/后台/确认 fail-closed 六种执行模式）、Durable 适配器族、OpenAI-compatible 适配器（原生 fetch+SSE;不引入 SDK）、DemoScriptedProvider（IPC 脚本注入+节奏）、dev 信号路由（Session Cookie 鉴权;默认关闭）、phase3 配置组 |
| `packages/observability` | §13 指标目录全部注册（signal/batch/turns/cycles/model_ttft/duration/tool_runs/tool_duration/interrupt/mailbox_merged） |
| `scripts` | `phase-3-demo.mjs`/`phase-3-demo-child.mjs`（真实子进程+协议 Stage 客户端;8 场景+稳定证据行） |

## 3. 复验命令与已记录证据

```bash
pnpm install --frozen-lockfile
pnpm --filter @bellis/stage exec playwright install chromium
pnpm check             # 先构建，再执行 typecheck/lint/format/单测/集成
pnpm build
pnpm contracts:check   # 双 dialect 生成物无漂移；数量以运行输出为准
pnpm test:browser
pnpm demo:phase1
pnpm demo:phase2
pnpm demo:phase2:crash
pnpm demo:phase3
```

`pnpm demo:phase3` 稳定证据行（§10.2 契约格式,两次独立运行）：

```text
phase3-demo: ok
batchLatencyMs=200/201                       # ≤ 500
cyclePackets=requested=3 adopted=3 duplicateFinal=0
toolDag=ok(parallel=2,cacheHit=l1,permissionDenied=1)
actionToolOverlapMs=124/125                  # > 0(虚拟/真实时钟区间相交)
turnSettleLatencyMs=104/110                  # 历史端到端样本，非子任务 P99
watermark=ok(deduplicated=1,monotonic=true)
recovery=ok(nonIdempotentReplay=0)
```

关键测试矩阵覆盖：

- **契约**：新 Schema 三方等价（209 用例）;Migration 0004/0005 升级、来源去重和数值位数边界断言;
- **单元/性质**：Ingress 去重/容量/序号;Batcher 窗口/封窗/区间连续
  （fast-check 30 轮随机到达）;Trigger 分类/合并/回收;Assembler 18 例
  非法流矩阵;Loop 两 Cycle/降级/adoption 失败/中断/预算/关闭;DAG 8 例;
  Runtime 21 例（重叠/串行/取消/缓存/截断/脱敏/后台）;
- **集成**：真实 DB Worker 下 phase3 决策纵向 4 例;OpenAI-compatible
  适配器本地 SSE 契约 3 例（speech/tool_calls/HTTP 拒绝;请求映射与密钥头）;
- **恢复**：adoptCycle 原子+幂等重放;running→uncertain（无自动重试）;
  未消费 Signal 水位重建;Demo 重启 send_gift 行数不变。

## 4. 资源与失败语义（不变量落点）

| 不变量 | 证明位置 |
| --- | --- |
| 单一 Loop 所有权 | DecisionLoop 串行链 + Trigger 一 Turn 一启动 |
| 一请求一行动 | StreamAssembler 终包复核 + demo `duplicateFinal=0` |
| 先规范化再进入核心 | ModelProvider 事件契约 + Adapter 契约测试 |
| 采用前不生效 | adoption 失败测试（无水位/无 Tool/无 Scene） |
| Action 与 Tool 并行 | demo `actionToolOverlapMs>0` + Runtime 重叠测试 |
| 工具结果只进后续 Cycle | Cycle 2 prompt 含上一轮结果断言 |
| 水位单调可审计 | Batch 区间连续性质测试 + adoptCycle 单调拒绝 |
| 无 Scene 也可提交 | noOp/仅 Tool Cycle 水位推进测试 |
| 非幂等不自动重放 | uncertain 恢复测试 + demo 重启零重放 |
| 高优先级不静默丢失 | urgent 保留容量独立 + 立即旁路测试 |
| 取消结构化传播 | 中断测试（模型流 Abort/未启动节点 cancelled/Scene 经 Director） |
| 测试与生产同路径 | Scripted/Fake 只替换外部能力;Demo 走真实 Runtime/DB/WS |

## 5. 已知边界（后续阶段）

- 决策侧崩溃窗口的 SIGKILL 专项 Harness 未单独建脚本：adoption 原子性
  与 uncertain 恢复由持久化集成测试与 Demo 重启证明;场景级崩溃窗口
  沿用 Phase 2 Harness;
- `phase3-e2e.test.ts` 使用启用 Phase 3 的真实 Runtime 与 Chromium，覆盖两 Cycle、工具结果进入下一轮、工具/Scene 并行和 urgent 取消；它是功能验收，不替代统计性能基准；
- 真实 Provider Smoke 需 `phase3.model.provider=openai-compatible` +
  `BELLIS_MODEL_API_KEY` 显式启用;缺少凭据时 Demo 使用 demo-scripted,
  不作为合并前置;
- L2 缓存键当前不含完整 World/Context revision（Phase 3 World 快照为
  最小集）;Memory Provider 引入后需扩展键组成;
- `turnSettleLatencyMs` 测量从 urgent 输入到 Turn 空闲，2100ms 仅是 Harness 收尾超时。原定模型/Tool/Scene 停止 P99 ≤100ms 尚未完成统计验收；功能取消测试不能替代该指标。
