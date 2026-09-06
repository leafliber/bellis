# Bellis Phase 1 完成态参考

> 2026-09-06 架构审查修订：任务所有权、工具恢复事实、调用列表范围、场景终态、Seq 分段预留及 Provider 接缝以 [ADR 0007](./adr/0007-task-ownership-and-runtime-scope.md) 为准。

> 状态：已完成并关闭  
> 阶段：基础协议  
> 关闭日期：2026-08-23  
> 最终实现 Commit：`8c69bd2`  
> 关闭记录 Commit：`296985c`  
> 后续实施：[Phase 2 开发指南](./phase-2-development-guide.md)

## 1. 参考用途

本文是 Phase 1 的唯一阶段参考，回答以下问题：

- Phase 1 实际交付了什么；
- 后续代码可以依赖哪些包根公开入口；
- 哪些协议、持久化和恢复语义已经冻结；
- 如何重新验证 Phase 1 基线；
- 哪些能力明确留给 Phase 2 及以后。

原 P0–P4 构建任务书、建议分支、文件所有权和 Agent 提示已在阶段关闭后删除。实现细节以代码、测试、稳定协议和 ADR 为准，而不是以历史任务步骤为准。

## 2. 已交付范围

Phase 1 建立了不依赖真实 LLM、TTS、Live2D 或游戏平台的本地 Runtime 基础：

- pnpm Monorepo、Node.js 26.5+、TypeScript 7、ESM、Oxlint/Oxfmt 和 Windows/macOS CI 基线；
- 以 Zod 为唯一来源的领域/Wire Contracts，以及 JSON Schema 2020-12 和 Draft 7 双目标生成物；
- 单调时钟、Control WebSocket、Binary Media WebSocket、背压、Seq/ACK/Replay 和时钟偏移估计；
- SQLite DB Worker、Migration checksum、Session Records、Scene 原子提交、Watermark、幂等和 Outbox 恢复；
- W3C Trace、Pino 安全日志、字段与内容脱敏、内存 Metrics；
- VirtualClock、确定性 ID/随机数、协议 Fixture 和临时数据目录等测试设施；
- Fastify loopback Runtime、一次性启动 Token、本地 Session、Control/Media 适配器、OpenAPI、优雅关闭和跨进程恢复演示。

Phase 1 Demo 中的 Scene 和媒体只验证协议、持久化和恢复；它不代表真实演出链路。

## 3. 包与稳定入口

所有消费者只依赖包根导出，不读取其他包的 `src/**` 私有路径。

### 3.1 `@bellis/contracts`

稳定能力：

- 通用：十进制字符串、UUID、Trace ID、JSON Value、`MonotonicClock`；
- 输入与决策：`SignalSchema`、`AudienceBatchSchema`、`ActionFrameSchema`、`DecisionPacketSchema`；
- 意图：Speech、Avatar、Game、Overlay、SyncPolicy；
- 场景：`SceneSchema`、`CueSchema`、`SyncGroupSchema`；
- 会话：`SessionRecordSchema`、`OutboxMessageSchema`、`Phase1SessionSnapshotSchema`；
- 传输：Control Envelope/Payload、Media Frame Header；
- `CONTRACT_SCHEMA_ENTRIES` 与双 dialect Schema 生成入口。

冻结规则：

- TypeScript 类型由 Zod 推导，禁止复制协议类型；
- Wire 上的微秒、Seq、ACK 和 Watermark 使用非负十进制字符串，核心内部使用 `bigint`；
- 同一主版本只做兼容新增；破坏性变化提升版本并记录 ADR；
- 每次协议变化同时更新 Zod、双 dialect 生成物、成功/失败 Fixture 和协议文档。

### 3.2 `@bellis/transport`

稳定入口包括：

- `SystemMonotonicClock`、`ClockOffsetEstimator`；
- `decodeControlMessage`、`encodeControlMessage`；
- `ControlSession`、`ControlEffect`、逻辑状态导出/恢复；
- `ReplayWindow`、`MessageDeduplicator`、`BoundedSendQueue`；
- `encodeMediaFrame`、`MediaFrameParser`、`MediaStreamRegistry`；
- 稳定 Transport/Media 错误类型与默认资源限制。

冻结语义：服务端方向使用 Seq/累计 ACK/有界 Replay，客户端方向使用单连接顺序、`messageId` 去重和持久化 `idempotencyKey`。Control 与 Media 队列分离；资源均有上限；连接和后台等待均可关闭或取消。

### 3.3 `@bellis/persistence`

稳定入口包括：

- `createPersistenceClient`；
- `migrate`、`ensureSession`、`appendRecord`、`commitScene`；
- `advanceServerSeq`、`readRecoveryState`、`listRecords`；
- `claimOutbox`、`completeOutbox`、`retryOutbox`、`readOutboxStats`；
- `createOutboxDispatcher`；
- `PersistenceError` 与稳定错误码；
- 仅测试装配使用的 `PersistenceCheckpointObserver`。

冻结语义：

- `node:sqlite` 只在 DB Worker 中导入，主线程只走闭合的类型化 RPC；
- Scene、Session Record、Watermark、幂等结果和 Outbox 在定义的事务边界内提交；
- `scene.committed` 不得早于数据库 Commit；
- Outbox 至少一次投递，使用有界 Lease、退避和 Dead Letter；
- 单调 Watermark/Seq 不允许回退；未知 Schema 版本返回明确兼容错误；
- 数据库只能位于调用方明确传入的绝对数据目录。

### 3.4 `@bellis/observability`

稳定入口包括：

- `createTraceContext`、`childTraceContext`、W3C `traceparent` 解析/格式化；
- `createTraceContextManager`；
- `createPinoLogger`、`createNoopLogger` 和统一 Logger Port；
- 字段级与自由文本 Redaction；
- `createInMemoryMetrics`、`createNoopMetrics` 和 Phase 1 Metrics 定义。

日志不得包含 Token、Cookie、凭证、SQL、原始敏感 Payload 或堆栈泄露。Metrics Label 必须低基数，禁止 Session/Scene/Trace ID 进入 Label。

### 3.5 `@bellis/testkit`

稳定入口包括 `VirtualClock`、确定性 ID/随机数、协议 Fixture 和安全临时目录。它只能作为开发或测试依赖，生产依赖链不得引用。

### 3.6 `@bellis/runtime`

稳定装配入口包括：

- `startRuntime`、`RuntimeHandle`、`parseRuntimeConfig`；
- `FakeSceneCommitService`（仅作为 Phase 1 集成夹具，Phase 2 不扩展其职责）；
- `buildSessionSnapshot`；
- Outbox 测试发布者和集中错误映射。

Runtime Route/WS Handler 只承担鉴权、边界校验、应用服务调用和序列化。Phase 2 的 Action Compiler 与 Scene Director 应作为新的应用/领域组件接入，不能继续堆入 `FakeSceneCommitService` 或 Route Handler。

## 4. 冻结协议

- [Control WebSocket](./protocols/control-websocket.md)：握手、方向白名单、Seq/ACK/Replay、心跳、时钟同步、Deadline 和背压。
- [Binary Media WebSocket](./protocols/binary-media-websocket.md)：`BELL` v1 帧、Header、资源限制、Stream 注册、连续序号和重连不恢复。
- [Persistence & Recovery](./protocols/persistence-and-recovery.md)：Worker RPC、Migration、事务、Outbox 和 Crash Window。
- [ADR 0001](./adr/0001-canonical-core-and-wire-contracts.md)：单一发言来源、JSON-safe Wire、不对称可靠性和双 Schema dialect。
- [ADR 0002](./adr/0002-node-26-baseline.md)：Node.js 26 开发与 CI 基线。

Phase 2 可以兼容扩展这些协议，但不能悄悄改变 v1 的既有判定、顺序或恢复结果。

## 5. 关键不变量

后续阶段必须持续满足：

1. `DecisionPacket.action.speech` 是唯一发言来源；TTS、字幕和口型不维护第二份文本。
2. LLM 或 Fake Model 只产出高层意图，不进入音频、Avatar 或游戏的帧级循环。
3. 外部副作用在持久化 Commit 前不得生效；重试使用相同幂等键。
4. 所有队列、Replay、媒体帧、Stream、Outbox 批次和去重集合都有明确上限。
5. 所有等待接受 Abort/Deadline；Worker、Dispatcher、Socket 和计时器都有关闭路径。
6. Runtime 只绑定 loopback，浏览器入口经过 Host、Origin 和本地 Session 校验。
7. Trace 跨 Runtime、Worker、WS 和 Outbox 传播，日志与错误只暴露安全字段。
8. 测试中的业务时间使用虚拟时钟推进；真实等待只用于必要的网络/进程边界 Smoke。
9. 生产包不依赖 `@bellis/testkit`，Contracts 不反向依赖业务包。

## 6. 关闭验收记录

Phase 1 在最终实现 Commit `8c69bd2` 上关闭，关闭记录写入 `296985c`。当时的 Gate 3 结果：

- 全仓库 705 项测试通过：单元/性质测试 544 项，集成测试 161 项；
- `pnpm check` 通过，包括双 dialect Contracts 漂移检查；
- `pnpm build` 通过；
- `pnpm demo:phase1` 连续运行并干净退出，九项证据全部通过；
- 工作树无数据库、日志、密钥或生成漂移残留。

最终 Demo 输出：

```text
protocolVersion=1
controlHandshake=ok
clockSync=ok
mediaFrame=accepted
sceneCommit=durable
watermark=restored
outboxRecovery=ok
idempotency=ok
traceContinuity=ok
```

当前分支重新验证时，从仓库根目录运行：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm demo:phase1
```

历史计数只表示关闭时证据；当前测试数量可以增加，但上述行为和命令不得回退。

## 7. 已知边界

Phase 1 有意不实现：

- 真实 Signal Hub、Audience Batcher、Model Provider 或 Decision Loop；
- ActionFrame 到 Scene/Cue 的真实编译；
- Scene Prepare/Ready/Commit Barrier 和 Cue Timeline；
- 可播放的 TTS PCM、AudioWorklet、字幕渲染、Live2D SDK；
- 正式 Stage/Overlay/Studio 应用；
- 工具、外部记忆、游戏平台插件和 Rust Sidecar。

`Phase1SessionSnapshotSchema` 的 `activeScene` 恒为 `null`，`openMediaStreams` 恒为空。Media Stream 属于连接级资源，重连后必须重新注册。Phase 2 若需要恢复活动 Scene，必须新增版本化 Snapshot，而不是改变 Phase 1 Schema 的既有语义。

另外，`SceneSchema` 与 `CueSchema` 已分别冻结，但 Phase 1 没有定义跨 Runtime/Stage 使用的“完整编译结果”聚合契约；这项缺口必须在 Phase 2 Contracts Gate 中先解决。

## 8. Phase 2 移交重点

Phase 2 直接复用 Phase 1 的 Contracts、Clock、Control/Media、Persistence、Observability 和 Runtime 生命周期，并新增：

- Fake Signal/Fake Model 驱动的确定性 ActionFrame；
- Action Compiler、Scene Director 和 Prepare/Ready/Commit 状态机；
- 浏览器 Stage、客户端时钟同步和 Cue Timeline；
- 确定性 PCM、AudioWorklet、字幕和 Live2D Adapter；
- 同步偏差、取消、断线和恢复的端到端验证。

具体范围、接口缺口、工作包和 Gate 见 [Phase 2 开发指南](./phase-2-development-guide.md)。

## 2026-09-06 兼容性修订

Control 预先持久化分段预留序号，缺省 1024 个。区间内发送和心跳无需逐条写库；latest_server_seq 是预留上界，不是实际发送数或业务完成水位。同进程保留实际 nextSeq/Replay，跨重启跳过未使用区间并通过 Snapshot 对账。详情见 [Control 协议](./protocols/control-websocket.md)。
