# Control WebSocket 协议（/ws/v1/control）

> 状态：Phase 1 冻结 v1 + Phase 2 兼容扩展（实现：`@bellis/transport`）
> 上位规范：[Phase 1 完成态参考](../phase-1-reference.md) · [ADR 0001](../adr/0001-canonical-core-and-wire-contracts.md)
> 姊妹文档：[Binary Media WebSocket](./binary-media-websocket.md) · [Scene Execution](./scene-execution.md)
>
> 本文档中的全部 `json control-envelope` 代码块由
> `packages/transport/test/unit/protocol-docs.test.ts` 自动验证，
> 与实现保持一致，不是未经测试的副本。

## 1. 概述

Control WebSocket 是 Runtime 与客户端（Studio / Stage / Overlay / 测试客户端）之间
唯一的有状态文本通道。消息是 UTF-8 JSON 文本，一条 WebSocket 消息恰好一条
Envelope。P1 交付框架无关核心（解码、状态机、Seq/ACK/Replay、去重、心跳、
背压）；Fastify 装配由 P4 完成。

不变量：

- 微秒时间、序号、ACK、水位在 Wire 上使用**非负十进制字符串**；Runtime 内部
  使用 `bigint`。Wire 上永远不出现裸 `bigint`（无法 JSON 序列化）。
- `direction` 是判别字段：只有服务端 Envelope 携带 `seq`；只有客户端 Envelope
  可以携带累计 `ack` 与业务 `idempotencyKey`。禁止用 `seq: "0"` 伪装方向——
  服务端 `seq` 从 1 开始严格递增，Schema 层以 `^[1-9][0-9]{0,29}$` 强制。
- `messageId` 用于客户端消息去重；`seq/ack` 用于服务端消息排序与累计确认。
  三者不可互换。
- 任何入站文本先经过：大小限制 → JSON 解析 → Envelope Schema →
  direction/type 白名单 → Payload Schema → 十进制字符串转换 → 会话状态与
  Deadline → messageId 去重。失败返回稳定机器码，不泄露原始 Payload、
  Token 或堆栈。

## 2. 握手状态机

```text
HTTP Upgrade + Session 校验（P4）
  → [server → client] server.hello
  → awaiting_client_hello
  → [client → server] client.hello（声明协议版本、客户端类型、可选 lastAck）
  → active
  → heartbeat / clock sync / typed messages
  → draining（优雅关闭或协议错误后排空）
  → closed
```

规则：

- 建连后服务端先发送 `server.hello`，然后只接受**一次**合法 `client.hello`；
  重复 Hello、Hello 前的业务消息稳定拒绝（`not_ready` / `invalid_message`）。
- **重连（resume）流程**：客户端已有会话上下文，直接发送 `client.hello`
  （携带 `lastAck`），无需等待 `server.hello`。服务端在处理 `client.hello`
  之前不发送任何新消息（否则新消息先分配更大 Seq，随后的重放会造成线上
  Seq 回退）；处理顺序为：先按原 Seq 重放窗口内容，再发送本连接的
  `server.hello`（其 Seq 在重放之后分配）。
- `client.hello` 声明的 `protocolVersion` 与服务端主版本不一致时返回
  `unsupported_version` 并以 4003 关闭连接，不做猜测性降级。
- Hello 超时（默认 10 秒，可配置）未收到合法 `client.hello` → 关闭码 4004。
- draining 状态只接受心跳、Clock 与 ACK 收尾；拒绝新的状态变更。
- closed 后一切入站消息稳定拒绝。

## 3. 消息类型与方向

| 类型 | 方向 | Payload 要点 |
| --- | --- | --- |
| `server.hello` | server → client | `protocolVersion=1`、`runtimeVersion`、`heartbeatIntervalMs`、`replayWindowSize` |
| `client.hello` | client → server | `protocolVersion`、`clientType`、可选 `lastAck` |
| `server.ready` | server → client | 空 |
| `heartbeat.ping` | client → server | 空 |
| `heartbeat.pong` | server → client | 空 |
| `clock.ping` | client → server | `c0`（客户端发出时刻） |
| `clock.pong` | server → client | `c0`、`r1`（服务端收到）、`r2`（服务端发出） |
| `session.snapshot` | server → client | 版本化快照联合（Phase 1 v1 / Phase 2 v2，见 scene-execution.md §8） |
| `scene.prepared` | server → client | `sceneId`、`cycleId`、`cues[]`（≤64） |
| `scene.committed` | server → client | `sceneId`、`cycleId`、`committedAtMs` |
| `scene.cancelled` | server → client | `sceneId`、`cycleId`、`reason` |
| `media.stream.open` | client → server | `streamId`、`mediaKind`、`contentType` |
| `media.stream.closed` | 双向 | `streamId`、`reason` |
| `error` | server → client | `ErrorEnvelope` |
| `stage.capabilities` | client → server | Stage 能力声明（Phase 2） |
| `scene.prepare` | server → client | `ScenePlan` + `prepareDeadlineUs`（Phase 2） |
| `scene.ready` | client → server | 逐 Lane Ready/不可用 + `preparedAtStageUs`（Phase 2） |
| `scene.commit` | server → client | `commitAtRuntimeUs`（Phase 2） |
| `scene.started` | client → server | 逐 Lane 实际起始时刻（Phase 2） |
| `scene.finished` | client → server | 逐 Lane 完成/失败（Phase 2） |
| `scene.cancel` | server → client | 取消 preparing/scheduled/running Scene（Phase 2） |
| `scene.cancel.ack` | client → server | 逐 Lane 已停止并释放（Phase 2） |
| `media.stream.announce` | server → client | Runtime → Stage Stream 声明（Phase 2） |
| `media.stream.ready` | client → server | Stage 有界缓冲已建立（Phase 2） |

Phase 2 演出消息的语义、时间字段与 reason 码见
[Scene Execution 协议](./scene-execution.md)；Phase 1 的
`scene.prepared/committed/cancelled` 仍是对普通订阅客户端的事实通知。

未知 `type` 返回 `invalid_message`，不会使 Runtime 崩溃。消息 `type` 为小写
点分 segments（允许单段，如 `error`）。

## 4. Envelope 形态与示例

### 4.1 服务端 → 客户端

```json control-envelope-valid
{
  "version": 1,
  "direction": "server",
  "type": "scene.committed",
  "messageId": "77777777-7777-4777-8777-777777777777",
  "sessionId": "11111111-1111-4111-8111-111111111111",
  "trace": { "traceId": "0123456789abcdef0123456789abcdef" },
  "sentAtUs": "1755648000000123",
  "seq": "42",
  "payload": {
    "sceneId": "44444444-4444-4444-8444-444444444444",
    "cycleId": "33333333-3333-4333-8333-333333333333",
    "committedAtMs": 1755648000123
  }
}
```

### 4.2 客户端 → 服务端

```json control-envelope-valid
{
  "version": 1,
  "direction": "client",
  "type": "media.stream.open",
  "messageId": "88888888-8888-4888-8888-888888888888",
  "sessionId": "11111111-1111-4111-8111-111111111111",
  "trace": { "traceId": "0123456789abcdef0123456789abcdef" },
  "sentAtUs": "1755648000000456",
  "deadlineUs": "1755648000050000",
  "ack": "41",
  "idempotencyKey": "open-stream-42",
  "payload": {
    "streamId": "99999999-9999-4999-8999-999999999999",
    "mediaKind": "binary-test",
    "contentType": "application/octet-stream"
  }
}
```

### 4.3 错误响应示例

服务端对非法入站的稳定错误（机器码 + 安全文案，客户端不得解析文案）：

```json control-envelope-valid
{
  "version": 1,
  "direction": "server",
  "type": "error",
  "messageId": "77777777-7777-4777-8777-777777777770",
  "sessionId": "11111111-1111-4111-8111-111111111111",
  "trace": { "traceId": "0123456789abcdef0123456789abcdef" },
  "sentAtUs": "1755648000000999",
  "seq": "43",
  "payload": {
    "error": {
      "code": "deadline_exceeded",
      "message": "message deadline has passed",
      "retryable": false,
      "traceId": "0123456789abcdef0123456789abcdef"
    }
  }
}
```

### 4.4 非法示例

客户端伪造服务端方向字段（客户端 Envelope 不得携带 `seq`，strict 对象拒绝
未知字段）：

```json control-envelope-invalid
{
  "version": 1,
  "direction": "client",
  "type": "heartbeat.ping",
  "messageId": "88888888-8888-4888-8888-888888888881",
  "sessionId": "11111111-1111-4111-8111-111111111111",
  "trace": { "traceId": "0123456789abcdef0123456789abcdef" },
  "sentAtUs": "1",
  "seq": "1",
  "payload": {}
}
```

版本不匹配（数值 `version ≠ 1`）分类为 `unsupported_version`：

```json control-envelope-invalid
{
  "version": 2,
  "direction": "client",
  "type": "client.hello",
  "messageId": "88888888-8888-4888-8888-888888888882",
  "sessionId": "11111111-1111-4111-8111-111111111111",
  "trace": { "traceId": "0123456789abcdef0123456789abcdef" },
  "sentAtUs": "1",
  "payload": { "protocolVersion": 2, "clientType": "studio" }
}
```

## 5. Seq / ACK / Replay（服务端 → 客户端）

- 每个**逻辑 Session** 的服务端消息 `seq` 严格递增（从 1 开始），不因连接
  重建归零。逻辑会话状态（`nextSeq` / `confirmedAck` / Replay Window / 未发送
  暂存消息）由 P4 在重连时通过 `ControlSession` 的 resume 导入；跨重启恢复由
  P2/P4 持久化。
- **Seq 在消息实际发送时分配**（而不是入队时）：发送优先级只作用于 Seq
  分配之前的准入、淘汰、合并与调度。被淘汰/合并/过期的消息从未消耗 Seq、
  从未进入 Replay Window，因此线上 Seq 严格递增且无缺口，累计 ACK 语义
  始终成立。
- `ack` 表示客户端**已处理**（不只是收到）的最大连续服务端 Seq。任意客户端
  消息都可携带 `ack` 累计确认。
- ACK 语义：
  - `ack` ≤ 已确认值 → 重复确认，内部状态不倒退。
  - `ack` > 已分配最大 Seq → 协议错误：返回 `invalid_message` 并以 4003 关闭。
- Replay Window 有界（默认 512 条，容量配置化；`server.hello` 携带
  `replayWindowSize`）。重连 `client.hello.lastAck` 落在窗口内时，按**原 Seq、
  原 messageId、原 JSON 文本**重放；重放消息进入独立的先行缓冲，
  **先于一切新分配 Seq 的消息发送**，保证线上 Seq 不回退。
- `lastAck + 1` 早于窗口最旧条目（缺口超出窗口）→ 服务端产生
  `snapshot_required` 内部 Effect，由 P4 读取 Persistence 后发送完整
  `session.snapshot`，不补发不完整历史。
- 心跳 Pong 与 Clock Pong 也消耗 Seq 并占用窗口（排除会造成虚假缺口），
  标记为 `persistable=false`。持久化语义拆分为两层：
  - **最新分配水位（nextSeq）必须为包括瞬时消息在内的一切 Seq 推进持久化**，
    否则进程重启后会复用 Seq（客户端去重误判、ACK 超前甚至 4003 关闭）；
  - `persistable=false` 仅表示不持久化该消息的 **Replay 内容**（瞬时消息
    重放无意义）。
- **持久化过滤造成的缺口**：跨重启只恢复 `persistable=true` 条目时，被过滤
  的瞬时 Seq 会在恢复后的窗口中留下内部或尾部缺口。恢复时由（条目集合，
  水位）推导缺口区间；`replayAfter` 的请求区间 `(lastAck, latest]` 只要碰到
  缺口即返回 `snapshot_required`——累计 ACK 语义下客户端无法越过缺口推进
  确认，只能走完整快照。客户端 ACK 覆盖缺口（重启前已完整收到瞬时消息）
  后，缺口不再阻塞后续重放。

## 6. 客户端幂等（client → server）

与服务端方向**有意不对称**：客户端方向不建立第二套累计 ACK/重放日志。

- 单连接内：`messageId` 有界去重集合（默认容量 1024，FIFO 淘汰）。重复瞬时
  消息不重复执行，返回稳定的重复结果（例如重复 `heartbeat.ping` 不会再产生
  第二个 Pong）。
- 会改变状态的客户端消息必须携带 `idempotencyKey`（Phase 1 默认约束
  `media.stream.open` / `media.stream.closed`，可配置）。缺少幂等键返回
  `invalid_message`；跨连接、跨重启的最终幂等由 P2 持久化层完成。
- 断线时在飞请求结果视为"不确定"：客户端重连读取 Snapshot 后，用**相同
  idempotencyKey** 重试允许重试的命令；非幂等且无幂等键的命令不得自动重试。
- 心跳、时钟样本等瞬时消息不重放。

## 7. 心跳

- `heartbeat.ping` 只能 client → server；服务端入队 `heartbeat.pong`（P2 优先级）。
- 服务端心跳超时：超过配置时限（默认 3 × `heartbeatIntervalMs`）没有任何
  入站消息 → 关闭码 4001。判定使用单调时钟（`MonotonicClock`），不受墙钟
  跳变影响；测试用 `VirtualClock` 推进，不做真实长等待。
- 客户端按 `server.hello.heartbeatIntervalMs` 周期发送 Ping；连续漏答的
  关闭策略由客户端实现（P1 不实现客户端循环）。

## 8. 时钟同步（clock.ping / clock.pong）

```text
Client 记录 c0 → clock.ping(c0)
Runtime 收到时记录 r1，入队响应时记录 r2 → clock.pong(c0, r1, r2)
Client 收到时记录 c3
```

- 四个值都是单调微秒十进制字符串；`r2 ≥ r1` 是服务端生产者不变量
  （P1 核心在 bigint 域断言）。
- 客户端估计：
  `roundTripUs = (c3 - c0) - (r2 - r1)`；
  `runtimeOffsetUs = ((r1 - c0) + (r2 - c3)) / 2`（Runtime 时钟相对本地时钟，
  bigint 域向零截断）。
- `@bellis/transport` 提供 `ClockOffsetEstimator`：拒绝任一时钟域倒退、负
  RTT 与超上限样本；有界窗口（默认 16）内取最小 RTT 集合（默认前 50%）的
  Offset 下中位数；高 RTT 样本不会覆盖明显更优样本；重连后 `reset()` 重新校准。
- Phase 1 只做采样与估计，不调度正式媒体。

## 9. Deadline

- 客户端消息可携带 `deadlineUs`。`deadlineUs ≤ nowUs`（单调域）时返回
  `deadline_exceeded`，不产生任何后续副作用（不进入去重集合、不触发注册）。
- 排队中的服务端消息在发送前发现 Deadline 已过 → 丢弃并记录类别计数
  （`dropped` Effect，reason=expired）；该消息从未分配 Seq，不产生缺口。

## 10. 背压与发送队列

每个连接一个有界、分优先级的发送队列（默认 512 条 / 8 MiB，双门槛配置化）：

| 优先级 | 类别 | 示例 |
| --- | --- | --- |
| 1 | 安全、取消、Scene Commit、协议错误 | `error`、`scene.committed`、`scene.cancelled`、`scene.commit`、`scene.cancel` |
| 2 | 媒体控制与 Session 状态 | `server.hello`、`server.ready`、`session.snapshot`、`heartbeat.pong`、`clock.pong`、`media.stream.closed`、`scene.prepare`、`media.stream.announce` |
| 3 | 快照增量（默认优先级） | `scene.prepared` 及未来 world delta |
| 4 | 调试 Trace 与可丢弃遥测 | Phase 1 未使用，预留给扩展 |

规则：

- 队列持有的是**尚未分配 Seq 的暂存消息**：优先级只影响准入淘汰、合并、
  过期剪枝与发送调度（drain 按优先级升序、同优先级 FIFO），全部发生在
  Seq 分配之前。被淘汰/合并/过期的消息不产生线上 Seq 缺口，也不会在重连
  时作为脏条目重放。
- 同时统计消息数与估算 UTF-8 字节数，任一达到上限即触发淘汰。
- 淘汰顺序确定：先淘汰更低优先级（数字更大）车道中最旧的条目；优先级 1
  永不淘汰；同优先级 FIFO。
- 低优先级（3/4）可替代消息可按稳定 `mergeKey` 合并（同 Key 旧消息被替换，
  记 `dropped` Effect，reason=merged）。替换先做可行性计算：新消息放不下时
  **旧消息原样保留**，绝不先删后拒。
- 显式 `priority` 与 `priorityOverrides` 只能**提升**优先级（数值变小），
  不能降低冻结的安全下限（`error` / `scene.committed` / `scene.cancelled`
  恒为 P1，永不淘汰）。
- 优先级 1/2 的消息在淘汰所有更低优先级后仍无法入队 → 返回
  `close_slow_consumer` 并以 4002 关闭该连接，绝不静默丢失。
- 淘汰只记录消息类别与数量（`dropped` Effect），不记录 Payload。
- Media 与 Control 使用不同通道；大 Media 流不会阻塞取消与心跳（P1 集成
  测试验证 Pong 先于批量 P3 消息送达）。

## 11. 默认限制与关闭码

| 项 | 默认值 | 可配置 |
| --- | --- | --- |
| 入站文本上限 | 1 MiB | `maxTextBytes` |
| Replay Window | 512 条 | `replayWindowCapacity` |
| 发送队列 | 512 条 / 8 MiB | `sendQueue.maxMessages` / `maxBytes` |
| 去重集合 | 1024 | `dedupCapacity` |
| 心跳 | 30 s 间隔 / 90 s 超时 | `heartbeat` |
| Hello 超时 | 10 s | `helloTimeoutUs` |

关闭码（WebSocket Close）：

| 码 | 含义 |
| --- | --- |
| 1000 | 正常关闭（优雅排空后） |
| 4001 | 心跳超时 |
| 4002 | 发送队列背压（慢消费者） |
| 4003 | 协议错误（版本不匹配、ACK/lastAck 超前） |
| 4004 | Hello 超时 |
| 4005 | 服务端关闭（Runtime 关闭序列） |

## 12. P4 适配器使用方式

P4 只依赖 `@bellis/transport` 包根导出，装配循环如下（伪代码）：

```text
onUpgrade:
  session = new ControlSession({ sessionId, runtimeVersion, clock: SystemMonotonicClock, ... })
  session.enqueueServerMessage({ type: "server.hello", payload: session.helloPayload() })
  pump()

onTextMessage(text):
  accepted = session.acceptClientMessage(text, clock.nowUs())
  if accepted.status === "accepted" && accepted.envelope.type === "media.stream.open":
    registry.open(...)           # 连接 Control 与 Media 两个通道
  pump()

onWsOpenFlush / 定时:
  pump(): for effect of session.tick(clock.nowUs()):
    send  → socket.write(effect.text)
    seq_advanced → 持久化最新分配水位（所有消息，含瞬时消息；
                   persistable=false 仅跳过该消息的 Replay 内容持久化）
    snapshot_required → 读 Persistence 后 enqueueServerMessage("session.snapshot")
    dropped → 记账指标（类别+数量）
    close   → socket.close(effect.code, effect.reason)；释放 registry.closeAll()

onDisconnect:
  state = session.exportLogicalState()   # nextSeq / confirmedAck / replay / pending
  # 持久化 nextSeq 与 persistable=true 的 replay/pending 内容；重连用 resume 恢复。
  # 恢复会话在 client.hello（含 lastAck）之前不会发送新消息——重放先行。

onClose:
  session.close(reason)；registry.closeAll()；丢弃未完成等待（Abort）
```

约束：Transport 核心不持有 Socket/Timer/Fastify 实例；一切网络写入通过
Effect；所有等待支持 Abort；`SystemMonotonicClock` 是唯一生产时钟。

## 13. 版本与兼容策略

- Envelope `version` 与 Hello `protocolVersion` 主版本不匹配 → 拒绝连接。
- 同一主版本新增可选字段属于兼容变更（Payload 使用可扩展对象，未知键的值
  必须是 JSON 值）。
- 删除字段、改变语义、缩窄枚举或改变时间单位属于破坏性变更。
- 协议变更顺序：先修改 `@bellis/contracts` Schema、双 dialect 生成物、
  Fixture 与本文档（含受测试验证的示例），再修改消费者。
