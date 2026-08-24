# Scene Execution 协议（Phase 2：Runtime ↔ Stage 演出链路）

> 状态：Phase 2 完成态 v1（冻结于 P0；已由实现与验收覆盖：协议级 Demo
> `pnpm demo:phase2`、四个 Crash Window `pnpm demo:phase2:crash`、
> 真实 Chromium E2E `pnpm test:browser`。Contracts：`@bellis/contracts`；
> 编解码：`@bellis/transport`）
> 上位规范：[Phase 2 开发指南](../phase-2-development-guide.md) · [ADR 0003](../adr/0003-phase-2-scene-wire-and-browser-boundary.md)
> 姊妹文档：[Control WebSocket](./control-websocket.md) · [Binary Media WebSocket](./binary-media-websocket.md)
>
> 本文档中的全部 `json control-envelope` 代码块由
> `packages/transport/test/unit/protocol-docs.test.ts` 自动验证，
> 与实现保持一致，不是未经测试的副本。

## 1. 范围与定位

Phase 2 在 Control WebSocket v1 之上新增 Runtime（服务端）与 Stage（客户端）
之间的 Scene 执行命令与回执：

```text
stage.capabilities（握手后上报能力）
  → scene.prepare（Runtime 传递 ScenePlan + Prepare Deadline）
  → scene.ready（Stage 逐 Lane 报告就绪/不可用）
  → [media.stream.announce → media.stream.ready]（Runtime → Stage 音频流）
  → scene.commit（Runtime 传递未来生效时刻）
  → scene.started → scene.finished（Stage 报告实际起始与结果）
  任意 preparing/scheduled/running 阶段：
  scene.cancel → scene.cancel.ack（停止并释放）
```

Phase 1 的 `scene.prepared/committed/cancelled` 保留为对普通订阅客户端
发布的**事实通知**，不承担命令语义；本协议的消息是**命令与回执**，
两者类型名不同、方向不同，不可互换。

不变量（Phase 2 开发指南 §3）：

- **Prepare 不生效**：`scene.prepare` 之后、`scene.commit` 生效时刻到达
  之前，Stage 不得播放音频、显示字幕或触发 Avatar。
- **Runtime 拥有决策权**：Stage 报告能力、Ready 与执行结果，不改写
  Scene、不补造 Cue、不自行降级硬同步组。
- **硬同步整组处理**：Hard Lane 未 Ready 时整组等待或由 Runtime 明确
  降级/取消；Stage 不得静默缺一个 Lane 仍声称同步成功。
- **有界与可取消**：Prepare 资源、媒体缓冲、回执等待全部有上限、有
  Deadline、有 Abort 与释放路径。

## 2. 连接代际

- Stage 复用 Phase 1 的 Control/Media 双连接与本地 Session；`client.hello`
  的 `clientType: "stage"`。
- **连接代际 = 物理连接生命周期**。重连即新代际：旧 Offset 估计清空、
  未 Commit 的准备缓存丢弃、连接级 Stream 全部失效；旧代际的
  `commitAtRuntimeUs` 不得沿用（旧连接已死，不存在跨代投递）。
- Stage 在每次连接的握手完成后、接受任何 `scene.prepare` 之前发送
  `stage.capabilities`；Runtime 以**当前连接**上报的能力快照作为编译输入。
- 已收到 Commit 但执行结果不确定的 Scene：重连对账（session.snapshot
  v2）后只上报 `uncertain` 事实，Stage 不自动重播。

## 3. 消息总表

| 类型 | 方向 | Payload 要点 |
| --- | --- | --- |
| `stage.capabilities` | stage → runtime | `capabilities`：audio contentTypes/maxBufferedUs、subtitle.supported、avatar adapter/motions/expressions |
| `scene.prepare` | runtime → stage | `plan`（ScenePlan：scene + cues ≤64）、`prepareDeadlineUs` |
| `scene.ready` | stage → runtime | `lanes[]`（lane/status/reason/cueIds）、`preparedAtStageUs` |
| `scene.commit` | runtime → stage | `sceneId`、`cycleId`、`commitAtRuntimeUs` |
| `scene.started` | stage → runtime | `lanes[]`（每 Lane：`startedAtStageUs` + `startedAtRuntimeUs`） |
| `scene.finished` | stage → runtime | `lanes[]`（outcome completed/failed、reason、`finishedAtStageUs`） |
| `scene.cancel` | runtime → stage | `sceneId`、`cycleId`、`reason` |
| `scene.cancel.ack` | stage → runtime | `lanes[]`（stopped/reason）、`stoppedAtStageUs` |
| `media.stream.announce` | runtime → stage | `streamId`、`mediaKind`(audio/viseme)、`contentType`、可选 `sceneId/cueId` |
| `media.stream.ready` | stage → runtime | `streamId` |

全部 Payload 为可扩展对象（未知键必须是 JSON 值）；微秒时间在 Wire 上
为非负十进制字符串。方向由 `@bellis/contracts` 的方向白名单强制，
违反方向的编码在 Transport 层即被拒绝。

## 4. Envelope 示例

### 4.1 scene.prepare（runtime → stage）

```json control-envelope-valid
{
  "version": 1,
  "direction": "server",
  "type": "scene.prepare",
  "messageId": "77777777-7777-4777-8777-777777777771",
  "sessionId": "11111111-1111-4111-8111-111111111111",
  "trace": { "traceId": "0123456789abcdef0123456789abcdef" },
  "sentAtUs": "1755648000000100",
  "seq": "44",
  "payload": {
    "plan": {
      "schemaVersion": 1,
      "scene": {
        "schemaVersion": 1,
        "sceneId": "44444444-4444-4444-8444-444444444444",
        "cycleId": "33333333-3333-4333-8333-333333333333",
        "groups": [
          {
            "schemaVersion": 1,
            "groupId": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            "lanes": ["audio", "subtitle", "avatar"],
            "level": "hard"
          }
        ],
        "deadlineMs": 500,
        "interruptPolicy": "fade"
      },
      "cues": [
        {
          "schemaVersion": 1,
          "cueId": "55555555-5555-4555-8555-555555555555",
          "lane": "audio",
          "anchor": "scene_start",
          "offsetMs": 0,
          "intent": { "speechRef": "primary", "tts": "fake-deterministic" }
        },
        {
          "schemaVersion": 1,
          "cueId": "55555555-5555-4555-8555-555555555556",
          "lane": "subtitle",
          "anchor": "scene_start",
          "offsetMs": 0,
          "intent": { "speechRef": "primary", "segment": 0 }
        },
        {
          "schemaVersion": 1,
          "cueId": "55555555-5555-4555-8555-555555555557",
          "lane": "avatar",
          "anchor": "speech_start",
          "offsetMs": 0,
          "intent": { "motion": "nod_agree", "speechRef": "primary" }
        }
      ]
    },
    "prepareDeadlineUs": "1755648000500000"
  }
}
```

同一 `SpeechIntent` 驱动 audio/subtitle/avatar（`speechRef: "primary"` 是
引用语义的最小表达）；单一发言来源，Cue 不复制全文。

### 4.2 scene.ready（stage → runtime）

```json control-envelope-valid
{
  "version": 1,
  "direction": "client",
  "type": "scene.ready",
  "messageId": "88888888-8888-4888-8888-888888888881",
  "sessionId": "11111111-1111-4111-8111-111111111111",
  "trace": { "traceId": "0123456789abcdef0123456789abcdef" },
  "sentAtUs": "1755648000018000",
  "ack": "43",
  "payload": {
    "sceneId": "44444444-4444-4444-8444-444444444444",
    "cycleId": "33333333-3333-4333-8333-333333333333",
    "lanes": [
      { "lane": "audio", "status": "ready", "cueIds": ["55555555-5555-4555-8555-555555555555"] },
      { "lane": "subtitle", "status": "ready", "cueIds": ["55555555-5555-4555-8555-555555555556"] },
      {
        "lane": "avatar",
        "status": "unavailable",
        "reason": "motion_not_found",
        "cueIds": []
      }
    ],
    "preparedAtStageUs": "1755648000017500"
  }
}
```

Hard 组（本例整组 hard）中任一 Lane `unavailable` 时，是否降级由
Runtime 决定；Stage 只如实报告。

### 4.3 scene.commit（runtime → stage）

```json control-envelope-valid
{
  "version": 1,
  "direction": "server",
  "type": "scene.commit",
  "messageId": "77777777-7777-4777-8777-777777777772",
  "sessionId": "11111111-1111-4111-8111-111111111111",
  "trace": { "traceId": "0123456789abcdef0123456789abcdef" },
  "sentAtUs": "1755648000020000",
  "seq": "45",
  "payload": {
    "sceneId": "44444444-4444-4444-8444-444444444444",
    "cycleId": "33333333-3333-4333-8333-333333333333",
    "commitAtRuntimeUs": "1755648000100000"
  }
}
```

`scene.commit` 只在数据库原子提交（`commitScene`）成功之后发送；
数据库失败时 Stage 只会收到取消/释放，绝不会收到 Commit。

### 4.4 方向违例（回执不得伪造为服务端方向）

```json control-envelope-invalid
{
  "version": 1,
  "direction": "server",
  "type": "scene.ready",
  "messageId": "77777777-7777-4777-8777-777777777773",
  "sessionId": "11111111-1111-4111-8111-111111111111",
  "trace": { "traceId": "0123456789abcdef0123456789abcdef" },
  "sentAtUs": "1755648000025000",
  "seq": "46",
  "payload": {
    "sceneId": "44444444-4444-4444-8444-444444444444",
    "cycleId": "33333333-3333-4333-8333-333333333333",
    "lanes": [{ "lane": "audio", "status": "ready", "cueIds": [] }],
    "preparedAtStageUs": "1"
  }
}
```

## 5. 时间语义

- Wire 上一切微秒时刻为非负十进制字符串；核心/Stage 调度层转为
  `bigint`（ADR 0001）。
- `scene.prepare.prepareDeadlineUs`：Prepare 截止（Runtime 单调域）。
  到期未 Ready 的 Lane 由 Stage 标记 `unavailable` 并回报，
  Runtime 决定降级或取消。
- `scene.commit.commitAtRuntimeUs`：Runtime 当前进程单调时钟域的**未来**
  生效时刻。Stage 通过当前连接的 Offset Estimate（≥3 个合格
  `clock.ping` 样本）映射为本地目标时刻；映射是 Stage 本地行为，
  不回写协议字段。
- `scene.started` 每个 Lane 回传两个域的时刻：`startedAtStageUs`
  （Stage 本地单调）与 `startedAtRuntimeUs`（用同一 Offset Estimate
  反算），供 Runtime 计算 hardLaneSkewMs 指标。
- `commitAtRuntimeUs` 不得持久化为重启后可执行时间；重连后旧值失效。

## 6. late_commit 与降级决策

Commit 到达时映射后的目标时刻已过（或落入不容忍窗口）：

1. Stage **不得**按过期时刻启动 Hard Lane；
2. Stage 以 `scene.finished`（相关 Lane `outcome: "failed"`、
   `reason: "late_commit"`）回报，不伪造 completed；
3. Runtime 决定取消整组、降级或重新调度；Stage 不自行猜测。

Lane reason 码为闭合小写机器码，Phase 2 冻结集合：

```text
audio_not_armed          浏览器自动播放限制，AudioContext 未 resume
clock_not_ready          合格时钟样本不足
unsupported_content_type contentType 不在本 Stage 能力列表
motion_not_found         语义动作名未在 capabilities 声明
expression_not_found     语义表情名未在 capabilities 声明
prepare_failed           Lane 内部准备失败（细节进日志/Trace，不进 Wire）
late_commit              Commit 时刻已过或落入不容忍窗口
buffer_underrun          播放中缓冲下越限（failed 时上报）
lane_error               Lane 执行期错误（通用兜底）
cancelled                因取消而终止（配合 cancel.ack 使用）
```

新增 reason 码属于兼容变更，但必须先更新本文档。

## 7. Runtime → Stage 媒体流

Phase 2 的音频主要是 Runtime → Stage 方向（Fake TTS PCM）：

1. `media.stream.announce`（Control）声明 `streamId/mediaKind/contentType`
   及可选 `sceneId/cueId`；`mediaKind` 限定 `audio|viseme`
   （`binary-test` 是 client → server 测试专用）。
2. Stage 校验能力（contentType ∈ `stage.capabilities.audio.contentTypes`、
   缓冲预算 ≤ `maxBufferedUs`）并建立**有界**缓冲后，以
   `media.stream.ready`（Control）确认；确认前 Runtime 不发送帧。
3. 帧走 Media WebSocket，BELL v1 二进制布局**不变**；每帧 Header 携带
   连续 `sequence`、`targetTimeUs`、`durationUs`、`sceneId`、`cueId`。
4. Stage 侧复用 `MediaStreamRegistry`（`@bellis/transport/browser` 入口）
   做入站 Stream 校验：session 一致、contentType/kind 一致、sequence
   严格连续、frameId 唯一、单 Stream 帧数上限。
5. 发送端（Runtime Media Sender）队列按**帧数、字节数、最大未来音频
   时长**三重限制，全部 ≤ Stage 声明的 `maxBufferedUs` 预算。
6. Control 取消优先于 Media 发送：`scene.cancel` 进入 P1 发送优先级；
   取消后不再为该 Scene 产生新帧，Stage 在预算内清空目标 Scene 样本。
7. Media Stream 不重放：重连后必须重新 announce；旧 Stream 关闭不可复活。

### 7.1 PCM 格式基线（P0 冻结）

```text
contentType  audio/pcm-s16le-48000-mono
采样率        48 000 Hz，mono，signed 16-bit little-endian
帧长          20 ms = 960 样本 = 1920 字节
```

常量由 `@bellis/contracts` 导出（`PHASE_2_PCM_*`），两侧实现不得复制
魔法字符串。压缩编码、重采样矩阵或真实 Provider 专用格式另立 ADR。

音频帧示例见 [Binary Media WebSocket §10](./binary-media-websocket.md)。

## 8. Phase 2 Snapshot 与对账

- `session.snapshot` 的 `snapshot` 字段是**版本化联合**：
  `schemaVersion: 1`（Phase 1，`activeScene` 恒 null）或
  `schemaVersion: 2`（Phase 2，携带 `activeScene` 对账视图）。
- Phase 2 视图：`executionState`（8 个公开执行状态，不含 Director 内部
  过渡态）、`outcomeCertain`（false = uncertain 语义）、
  `requiresReprepare`（true = Stage 准备资源已随连接丢失，必须重新
  Prepare 才能接受新 Commit）。
- 恢复事实与重新执行分离：Snapshot 可以说明"已提交/结果不确定"，
  不导致自动重播；只有新的显式 `scene.prepare → commit` 才产生新副作用。
- `openMediaStreams` 在两个版本中恒为空（连接级资源，重连重新声明）。
- Runtime 在未启用 Phase 2 演出链路的会话中继续发送 v1 快照，
  Phase 1 客户端行为不变。

## 9. ScenePlan 持久化策略（P0 决策，P4 实施）

- `commitScene` 事务保存完整可审计计划：state.db 新增**只增列**
  `scenes.plan_json`（Migration 0002，可为 NULL；Phase 1 行保持 NULL），
  写入前经 `ScenePlanSchema` 校验，读取后按 `schemaVersion` 判别。
- `scenes.payload_json` 继续承载 Phase 1 冻结的 `Scene` 形态，语义不变；
  读取侧未知 plan schemaVersion 返回明确兼容错误，不静默丢弃。
- Scene 生命周期（prepare 结果、started/finished 回执、取消原因、
  uncertain 判定）以版本化 Payload 写入 `session_records`（append-only，
  结果可追加、不改写历史）；幂等摘要沿用 `idempotency_keys` 表。
- 单调 Commit 时间（commitAtRuntimeUs）不持久化（§5）。

## 10. 资源上限与关闭

| 项 | 约束 |
| --- | --- |
| ScenePlan cues | ≤ 64（Schema 强制） |
| ready/started/finished/cancel.ack lanes | 1..8（Schema 强制） |
| Prepare 资源（Stage 侧） | 每 Lane 有界缓冲，连接关闭全部释放 |
| 回执等待（Runtime 侧） | `scene.deadlineMs` + Abort，迟到回执不复活终态 |
| 媒体发送队列 | 帧数/字节/未来时长三重限制（§7.5） |
| 入站 Stream（Stage 侧） | MediaStreamRegistry 默认上限（并发 8 / 总 1024 / 帧 65536） |

## 11. 冻结范围与变更策略

- 本协议消息、方向、时间字段与 reason 码集合在 Phase 2 内冻结；
  变更遵循 control-websocket.md §13（先改 Contracts/双 dialect 生成物/
  Fixture 与本文档，再改消费者）。
- 新增可选 Payload 字段属于兼容变更；删除字段、改变语义、缩窄枚举
  或改变时间单位属于破坏性变更，需要 ADR。
- 浏览器边界（`@bellis/transport` 的 `./browser` 子路径入口、
  Uint8Array 媒体编解码、BrowserMonotonicClock）见
  [ADR 0003](../adr/0003-phase-2-scene-wire-and-browser-boundary.md)；
  `browser-entry.test.ts` 静态扫描强制浏览器可达文件不含
  `node:*`、`Buffer`、`process` 或 `require(`。
