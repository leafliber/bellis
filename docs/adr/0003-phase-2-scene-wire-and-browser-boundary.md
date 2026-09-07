# ADR 0003：Phase 2 演出 Wire 扩展与浏览器边界

> 2026-09-06 架构审查修订：任务所有权、工具恢复事实、调用列表范围、场景终态、Seq 分段预留及 Provider 接缝以 [ADR 0007](./0007-task-ownership-and-runtime-scope.md) 为准。 本文保留历史决策/实施过程；与新决策冲突的描述不再作为当前实现要求。

> 状态：Accepted
>
> 日期：2026-08-24
>
> 决策范围：Control WebSocket v1 的 Scene 执行消息族、Runtime → Stage
> 媒体流方向、版本化 Snapshot 联合、`@bellis/transport` 浏览器入口与
> PCM 格式基线
>
> 关联文档：[Phase 2 开发指南](../archive/phase-2/development-guide.md) ·
> [ADR 0001](./0001-canonical-core-and-wire-contracts.md) ·
> [Scene Execution 协议](../protocols/scene-execution.md)

## 背景

Phase 2 打通 Fake Signal → Fake Model → Action Compiler → Scene Director →
Stage（AudioWorklet / 字幕 / Live2D Adapter）的演出纵向链路。P0 契约
评审确认了六项缺口（开发指南 §5.1）：

1. 没有跨 Runtime/Stage、可整体校验和持久化的编译结果聚合；
2. Control 类型只有事实通知（scene.prepared/committed/cancelled），
   没有真实 Stage 的 Prepare/Ready/Commit/Cancel 命令与回执；
3. `media.stream.open` 只覆盖 client → server；Phase 2 音频主要是
   Runtime → Stage；
4. `Phase1SessionSnapshotSchema.activeScene` 恒为 null，无法承载对账；
5. `@bellis/transport` 以服务端核心为主，且包含 Node 专用实现；
6. `commitScene` 只持久化 `Scene`，没有完整 Cue Plan 与执行状态。

这些决策影响后续 P1–P5 的所有并行工作包，必须在实现前冻结。

## 决策

### 1. Scene 执行消息族（10 个新 Control 类型，v1 内兼容新增）

新增 `stage.capabilities` / `scene.prepare` / `scene.ready` /
`scene.commit` / `scene.started` / `scene.finished` / `scene.cancel` /
`scene.cancel.ack` / `media.stream.announce` / `media.stream.ready`。

- 方向固定：命令（prepare/commit/cancel/announce）为 server → client，
  回执与报告（capabilities/ready/started/finished/cancel.ack/ready）
  为 client → server；方向白名单在 Contracts 与 Transport 两层强制。
- Phase 1 事实通知类型保留原语义，不赋予命令含义；两族类型名不同，
  不存在复用冲突。
- `scene.commit` 与 `scene.cancel` 进入发送优先级 1（永不淘汰）；
  `scene.prepare` / `media.stream.announce` 为优先级 2。
- late_commit 不设独立消息：Stage 以 `scene.finished`
  （outcome=failed, reason=late_commit）回报，Runtime 决策。

### 2. ScenePlan 聚合与公开执行状态

- `ScenePlanSchema = { schemaVersion: 1, scene: Scene, cues: Cue[1..64] }`：
  组合已冻结的 Scene/Cue，不改变任一语义；进入双 dialect 生成与
  语义等价 Fixture。
- `SceneExecutionStateSchema` 只含 8 个公开状态（preparing/ready/
  scheduled/running/completed/cancelled/failed/uncertain）；Director
  内部过渡态（created/committing/cancelling）不进入 Wire。
- 持久化策略：state.db Migration 0002 为 `scenes` 增加可空列
  `plan_json`（写入前经 ScenePlanSchema 校验）；`payload_json` 的
  Phase 1 语义不变；生命周期写入 append-only 的 `session_records`。
  P4 实施，P0 只冻结策略。

### 3. Runtime → Stage 媒体流：announce/ready，不改 BELL v1 帧布局

- 流声明走 Control（announce → ready），帧仍走 Media WebSocket 的
  BELL v1 布局；`mediaKind` 在 announce 中限定 `audio|viseme`，
  `binary-test` 保持 client → server 测试专用。
- Stage 复用 `MediaStreamRegistry` 做入站校验（同一实现，不复制
  顺序/去重算法）；发送端队列按帧数/字节/未来时长三重限制。
- 重连不恢复 Stream（与 Phase 1 一致）：重新 announce。

### 4. PCM 基线冻结

Phase 2 唯一音频格式：`audio/pcm-s16le-48000-mono`（48 kHz、mono、
S16LE、20 ms 帧 = 1920 字节）。常量由 `@bellis/contracts` 导出
（`PHASE_2_PCM_*`），两侧实现不得复制魔法字符串。压缩编码或真实
Provider 专用格式另立 ADR。

### 5. 版本化 Snapshot 联合

- `session.snapshot` 的 `snapshot` 字段放宽为
  `z.union([Phase1, Phase2])`，以 `schemaVersion`（1|2）判别；
  Phase 1 形态与语义原样保留。
- Phase 2 视图增加 `activeScene`（executionState/outcomeCertain/
  requiresReprepare）；`openMediaStreams` 在两个版本中恒为空。
- Runtime 在未启用 Phase 2 演出链路的会话中继续发送 v1 快照；
  Phase 1 客户端与 `pnpm demo:phase1` 行为不变。
- 未知 schemaVersion 必须整体拒绝（明确兼容错误），不静默当作已知语义。

### 6. `@bellis/transport` 浏览器入口

- 新增子路径导出 `./browser`：Control 编解码/方向白名单、连接状态、
  去重/Replay/有界队列、`ClockOffsetEstimator`、`BrowserMonotonicClock`
  （`performance.now()` 转微秒）、媒体帧编解码/解析/Stream Registry。
- 为此把媒体编解码从 `Buffer` 移植到 `Uint8Array`/`DataView`、把
  `Buffer.byteLength` 换成可移植 UTF-8 字节数计算；语义不变
  （Node 侧全部测试原样通过）。
- 时钟等待/关闭算法提取为 `BaseMonotonicClock`，Node（hrtime）与
  浏览器（performance.now）只实现 `nowUs()`；不在浏览器侧复制算法。
- Node-only 模块（`SystemMonotonicClock`、`ControlSession`）只从包根
  `.` 暴露。`browser-entry.test.ts` 静态扫描浏览器可达文件图：外部
  依赖只允许 `@bellis/contracts`，源内不得出现 `node:`、`Buffer`、
  `process`、`require(`；该约束进 CI，不依赖打包器配置。
  `@bellis/observability` 包根经 barrel 传递 `node:crypto`/pino，
  因此不允许进入浏览器可达图（后续如需，必须先增加浏览器安全子路径）。

## 兼容性论证

- 全部变更是 v1 内**兼容新增**：新消息类型、新联合成员、新导出子路径；
  既有类型、方向、顺序与恢复判定不变。
- 双 dialect 生成物、语义等价 Fixture（Zod / Ajv2020 / AjvDraft7 三方
  一致）与协议文档示例同步更新，`pnpm contracts:check` 防漂移。
- 验证：Phase 1 全部测试与 `pnpm demo:phase1` 在变更后原样通过。

## 影响

- 正向：P1（scene-runtime）获得可校验的编译产物契约；P2（Stage）
  获得浏览器安全的传输/时钟入口；P3/P4 获得冻结的媒体方向与时间语义。
- 代价：媒体编解码改用 Uint8Array（Node 侧零拷贝路径略慢于
  allocUnsafe，属可测量但非关键路径）；Snapshot 消费端必须处理联合
  判别（Phase 1 客户端遇到 v2 快照会按未知版本拒绝，符合版本策略）。

## 验收

P0 已证明：

- 10 个新消息类型的方向/成功/失败 Fixture 在 Zod 与双 Ajv dialect
  三方一致；
- scene-execution.md 与 binary-media-websocket.md 的全部示例由
  `protocol-docs.test.ts` 自动验证；
- 浏览器可达文件图静态扫描通过，且 browser 入口在运行期冒烟可用；
- `pnpm contracts:check`、`pnpm --filter @bellis/contracts typecheck/test`、
  `pnpm --filter @bellis/transport test`、`pnpm check`、
  `pnpm build`、`pnpm demo:phase1` 全部通过。
