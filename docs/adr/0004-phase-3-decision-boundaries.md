# ADR 0004：Phase 3 决策边界——Signal 水位、Cycle Adoption 与恢复语义

> 2026-09-06 架构审查修订：任务所有权、工具恢复事实、调用列表范围、场景终态、Seq 分段预留及 Provider 接缝以 [ADR 0007](./0007-task-ownership-and-runtime-scope.md) 为准。 本文保留历史决策/实施过程；与新决策冲突的描述不再作为当前实现要求。

> 状态：Accepted
>
> 日期：2026-08-28
>
> 决策范围：Signal 入库序号与消费水位、Audience Batch 区间、
> Turn/Cycle 身份与收件箱语义、Cycle adoption 原子操作、
> ModelProvider Port 事件边界、Tool Run 状态与恢复判定
>
> 关联文档：[Phase 3 开发指南](../archive/phase-3/development-guide.md) ·
> [ADR 0001](./0001-canonical-core-and-wire-contracts.md) ·
> [Persistence & Recovery 协议](../protocols/persistence-and-recovery.md)

## 背景

Phase 3 在 Phase 2 演出链路前加入真实决策循环：Signal Pipeline、
Decision Trigger、Decision Loop、ModelProvider 与 Tool Runtime。
开发指南 §5.2 列出 P0 必须冻结的十项语义；它们决定三个并行工作包
（P1/P2/P3）的接口与 P4 持久化事务，必须在实现前无歧义。

本 ADR 不改变 ADR 0001 的规范形态（DecisionPacket/ActionFrame/
ToolCall 原样复用），只冻结新增边界。

## 决策

### 1. Signal 序号、去重与消费水位

- **入库序号（sequence）**：Signal 通过 `SignalSchema` 与来源策略校验
  后，在入库事务内分配 Session 内单调序号（1 起、无缺口）；持久化
  投影为 `IngestedSignalSchema`（sequence 为十进制字符串）。
- **去重键**：`Signal.id`（Session + 来源域内唯一）。重复事件返回
  `deduplicated` 结果并回显原 sequence，不分配第二个序号。
- **消费水位**：`AudienceBatch.watermarkFrom/watermarkTo` 是**闭区间**
  `[from, to]`（入库序号域）。Batch 只覆盖未消费区间；Cycle adoption
  成功后消费水位前进到 `watermarkTo`。失败请求不推进水位（不变量 7）。
- **空批次不产生**：Batcher 只对非空输入封窗；`noOp`/仅 Tool 的
  Cycle 照常以所采用 Batch 的水位推进（不变量 8）。
- Phase 2 的 `signal_watermarks`（per-source 传输重放水位）语义不变；
  Phase 3 消费水位是独立的新状态（per-session decision watermark），
  不复用同一列。

### 2. 有界队列策略

- 普通队列：FIFO，容量显式配置；满时新普通 Signal 记录
  `rejected(queue_full)` 审计事实并丢弃（可聚合的输入允许显式拒绝）。
- 紧急保留容量：urgent 分类保留独立配额（普通洪峰不得挤占）；
  urgent 满载产生可观测的过载失败，绝不静默丢弃（不变量 10）。
- 优先级分类由确定性策略完成（priority 阈值 + kind 目录），不调用
  主模型。

### 3. Turn/Cycle 身份与收件箱语义

- **Turn**：一次完整决策会话（`queued → running → finishing →
  completed | cancelling → cancelled | failed | degraded`），由
  `turnId`（UUID）标识；一 Session 同时最多一个拥有提交权的 Turn
  （不变量 1）。
- **Cycle**：Turn 内一次模型请求-采用-分派（`snapshot → requesting →
  validating → adopting → dispatching → awaiting_next → completed`），
  由 `cycleId`（UUID）标识。默认 `maxCyclesPerTurn=8`、
  `maxParallelTools=8`。
- **三类忙碌输入**：
  - `interrupt`（紧急）：取消活跃 Turn 的子任务（模型流/Prepare/Tool/
    可中断 Scene）后排入 urgent Turn，不等待当前 Cycle 终态；
  - `next_cycle`（普通，当前 Turn 继续）：并入下一 Cycle 快照（不产生
    新 Turn）；
  - `next_turn`（普通，当前 Turn 已结束路径）：有界 FIFO，可合并。
- 分类由 Trigger 的确定性策略完成；interrupt 不得绕过 Scene Director
  直接终止 Lane。

### 4. Cycle adoption 原子操作

adoption 是独立于 Scene Commit 的原子事务（P4 由 Persistence 实现
`CycleAdoptionPort`），单事务写入：

1. `phase3_cycle_adopted` Record（cycleId、turnId、cycleIndex、
   packetDigest、batch/水位、next、degraded、toolRunIds）；
2. 消费水位推进至 `watermarkTo`；
3. 将要执行的 Tool Run `planned` 行（含幂等键摘要）；
4. Turn/Cycle 状态与 Trace 身份；
5. 必要 Outbox/审计记录。

采用前只允许：模型流解析、TTS/动作资源可取消 Prepare、纯内存 DAG
编译。adoption 失败 → 取消全部 Prepare、不推进水位、不执行可变 Tool、
不提交 Scene。adoption 成功后 Scene Commit 与 Tool 执行并行（不变量 5）。

Scene 编译拒绝/无 Scene 路径（noOp、仅 Avatar、仅 Tool）不回滚
adoption：水位已随 adoption 前进，Scene 结果独立记录（不变量 8/9）。

### 5. ModelProvider Port 事件边界

Port 形态见 `@bellis/decision-loop` `src/model/provider.ts`：

- 事件只含：started / speech 增量 / speech_meta（≤1 次）/ avatar 完整
  intent / tool_call_start / tool_args 增量 / tool_call_end / usage /
  next / error / final（唯一终止事件）；
- Provider 私有 reasoning、cache metadata、raw body 不进入 Port 事件，
  只进入有界/脱敏遥测；
- `final` 恰好一次且必须是最后一个事件；final 后 delta、重复 final、
  缺失 next、cycleId 不匹配 → Provider 结果失败 → 确定性降级
  （本地安全包，`next=finish`，不发起格式修复请求）；
- OpenAI-compatible Adapter 使用 Node 26 原生 fetch + AbortController
  （SSE 流式读取），**不引入第三方 LLM SDK**——SDK 事件类型不得
  导出为核心契约（禁止捷径 §15）。

### 6. Tool Run 状态与恢复判定

- Tool Run 持久化状态：`planned | running | succeeded | failed |
  timeout | cancelled | denied | dependency_failed | uncertain`；
- `uncertain` 只出现在恢复投影：非幂等 Tool 崩溃时无法证明结果，
  绝不自动重试，只能显式对账或新调用（不变量 9）；
- pure/idempotent Tool 仅在策略与稳定幂等键允许时显式恢复；
- 可变 Tool 只在 adoption 成功后启动（Phase 3 初始实现含只读 Tool
  统一在 adoption 后启动）。

### 7. 恢复矩阵与取消树

恢复矩阵按开发指南 §14 执行，取消树：

```text
Turn abort domain
  ├─ Cycle abort domain
  │    ├─ Model stream Abort
  │    ├─ Prepare Abort（采用前）
  │    └─ Tool DAG Abort（采用后）
  └─ Scene 取消（经 PerformancePort → Scene Director，不绕过）
```

未 adoption 的 Cycle 重启后不推进水位、丢弃全部未提交 Prepare；
已 adoption 的 Cycle 不重新请求模型、不自动重播 Scene。

## 后果

- `@bellis/contracts` 新增：IngestedSignal、CycleSnapshot、
  RecentUtterance、ToolResult/ToolRunState 等共享形态与 8 个
  phase3_* 审计 Payload（双 dialect 生成物 + 三方等价 Fixture）；
- `packages/decision-loop`、`packages/tool-runtime` 作为新包落地，
  依赖方向 decision-loop → tool-runtime → contracts/observability；
- Persistence 新增 Migration（phase3_signals、decision_cycles、
  tool_runs、tool_cache L2）在 P4 评审后合入，兼容说明见
  Phase 3 完成态参考；
- 未知 `payloadVersion` 的 Phase 3 Record 读取端 fail closed。
