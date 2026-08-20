# P1 开发文档：Clock、Control WebSocket 与 Binary Media WebSocket

> 任务编号：Phase 1 / P1
> 前置 Gate：P0 / Gate 1 已合入
> 建议分支：`codex/phase1-transport`
> 文件所有权：`packages/transport/**`、两份传输协议文档
> 上位规范：[Phase 1 构建指导](../phase-1-build-guide.md) 第 6–8、11、12、13.2 节 · [ADR 0001](../adr/0001-canonical-core-and-wire-contracts.md)

## 1. 任务目标

实现不依赖 Fastify、数据库或真实媒体业务的传输核心，使 P4 可以通过公开 API 完成 Runtime 的 REST/WS 边缘装配。

本任务结束时必须具备：

- `SystemMonotonicClock` 和可测试的客户端时钟偏移估计。
- Control Envelope/Payload 的分层校验、序列化和错误分类。
- 服务端 Seq/ACK/Replay、客户端消息去重、心跳、Deadline 和连接状态机。
- 有界、分优先级、按消息数和字节数限制的发送队列。
- Binary Media Frame 编码、增量解析、Stream Registry 和资源限制。
- 可供 P4 使用的框架无关适配接口。
- 单元、性质和传输集成测试。
- `docs/protocols/control-websocket.md` 和 `docs/protocols/binary-media-websocket.md`。

## 2. 明确不做

- 不启动 Fastify，不实现 HTTP Upgrade、Cookie 或 Origin 校验。
- 不实现 Stage、AudioWorklet、TTS、Live2D 或可播放音频。
- 不访问 SQLite，不保存 Session 或 Replay 到数据库。
- 不实现 Scene Director；Phase 1 Scene 消息只作为类型化测试消息。
- 不修改 Contracts 来迁就实现。确需改协议时先提交变更请求。
- 不使用真实网络等待来验证心跳、Deadline 或重试。

## 3. 开工步骤

1. 从 Gate 1 Commit 创建分支和独立 worktree。
2. 阅读 `packages/contracts/src/transport/**`、Contracts 公开入口和共享 Fixture。
3. 运行 [任务索引](./README.md) 第 4 节的共同检查。
4. 先提交公开 API 清单，通过 Gate 1.1 后再写主体实现。
5. 在 `packages/transport/package.json` 增加真实的 `test`、`test:integration` 脚本；不得把测试脚本做成空成功。

## 4. 推荐目录

可以按实现需要调整文件名，但职责必须保持分离：

```text
packages/transport/
  src/
    clock/
      system-monotonic-clock.ts
      offset-estimator.ts
    control/
      codec.ts
      connection-state.ts
      message-deduplicator.ts
      replay-window.ts
      bounded-send-queue.ts
      control-session.ts
    media/
      frame-codec.ts
      incremental-parser.ts
      stream-registry.ts
    errors.ts
    index.ts
  test/
    unit/
    properties/
    integration/
  vitest.config.ts

docs/protocols/
  control-websocket.md
  binary-media-websocket.md
```

所有公共导出只能从包根 `src/index.ts` 暴露。测试可以读取包内模块，P4 不可以。

## 5. 公开 API 最低能力

具体命名可在 Gate 1.1 微调，但包根至少要暴露以下能力：

```ts
// Clock
class SystemMonotonicClock implements MonotonicClock {}

interface ClockSample {
  c0: bigint;
  r1: bigint;
  r2: bigint;
  c3: bigint;
}

interface ClockEstimate {
  roundTripUs: bigint;
  runtimeOffsetUs: bigint;
}

interface ClockOffsetEstimator {
  add(sample: ClockSample): ClockEstimate | null;
  current(): ClockEstimate | null;
  reset(): void;
}

// Control
function decodeControlMessage(input: unknown): ControlEnvelope;
function encodeControlMessage(input: ControlEnvelope): string;

interface ControlSession {
  acceptClientMessage(input: unknown, nowUs: bigint): AcceptedClientMessage;
  enqueueServerMessage(input: ServerMessageInput): EnqueueResult;
  acknowledge(seq: bigint): void;
  replayAfter(lastAck: bigint): ReplayResult;
  tick(nowUs: bigint): readonly ControlEffect[];
  close(reason: string): void;
}

// Media
function encodeMediaFrame(frame: MediaFrame): Uint8Array;
class MediaFrameParser {
  push(chunk: Uint8Array): readonly MediaFrame[];
  reset(): void;
}

interface MediaStreamRegistry {
  open(input: OpenStreamInput): void;
  accept(frame: MediaFrame): void;
  close(streamId: string): void;
  closeAll(): void;
}
```

要求：

- API 使用 `@bellis/contracts` 类型，不复制 Envelope、Payload 或 Header 类型。
- 解码入口的输入类型是 `unknown`。
- 微秒、Seq、ACK 在核心中使用 `bigint`；仅 Wire 使用十进制字符串。
- 状态对象不暴露可变内部数组、Map、Timer 或 Socket。
- 网络写入通过返回 Effect 或注入 Adapter 完成，核心不持有 Fastify/WebSocket 实例。
- 所有启动后台行为的对象都必须有 `close`，所有等待都接受 Abort/Deadline。

## 6. Clock 实现

### 6.1 SystemMonotonicClock

- `nowUs()` 基于 `process.hrtime.bigint()`，从纳秒无损转换到微秒。
- `sleepUntil()` 的目标已过时立即完成。
- 必须正确处理调用前已 Abort、等待中 Abort、多个并发等待和 Close。
- 系统墙钟变化不得影响等待结果。
- 生产实现允许使用短期 Timer，但测试业务时长必须使用 `VirtualClock` 推进。

### 6.2 Offset Estimator

对样本 `c0/r1/r2/c3`：

```text
roundTripUs = (c3 - c0) - (r2 - r1)
runtimeOffsetUs = ((r1 - c0) + (r2 - c3)) / 2
```

实现必须：

- 在有符号 `bigint` 域计算 Offset。
- 拒绝任一时钟域倒退、`r2 < r1`、负 RTT 和超出配置上限的样本。
- 保留有界样本窗口；高 RTT 样本不能覆盖明显更优样本。
- 提供确定性的选择策略，例如最小 RTT 集合中的中位 Offset。
- 重连时清空旧估计并重新校准。

P1 只完成估计，不调度正式媒体。

## 7. Control 协议

### 7.1 解码顺序

入站消息必须按以下顺序处理：

```text
字节/文本大小限制
  → JSON 解析
  → ControlEnvelopeSchema
  → direction/type 白名单
  → 对应 Payload Schema
  → 十进制字符串无损转换
  → Session 状态和 Deadline 检查
  → messageId 去重
  → 产生框架无关 Effect
```

任何失败都返回稳定的 Transport 错误，不抛出含原始 Payload、Cookie、Token 或堆栈的客户端错误。

### 7.2 连接状态

至少实现：

```text
awaiting_client_hello → active → draining → closed
```

规则：

- 建连后先由 P4 发送 `server.hello`，然后只接受一次合法 `client.hello`。
- 协议主版本不匹配时返回 `unsupported_version` 并关闭。
- Hello 前的业务消息、重复 Hello、关闭后的消息稳定拒绝。
- Heartbeat Ping/Pong 和 Clock Ping/Pong 不写 Replay 持久记录。
- `deadlineUs <= nowUs` 的消息返回 `deadline_exceeded`，不产生后续副作用。
- Draining 后不接受新的状态变更，但允许必要 ACK/关闭流程完成。

### 7.3 服务端 Seq、ACK 与 Replay

- Seq 按逻辑 Session 严格递增，不因连接重建归零。
- ACK 是客户端已处理的最大连续服务端 Seq。
- ACK 小于已确认值视为重复，不能倒退内部状态。
- ACK 大于已发送最大 Seq 属于协议错误。
- Replay Window 默认有界，初始建议 512 条；容量必须配置化。
- 重连 `lastAck` 在窗口内时按原 Seq 和原 `messageId` 重放。
- 缺口超出窗口时返回 `snapshot_required` Effect，由 P4 读取 Persistence 后发送 `session.snapshot`。
- Media Stream 不重放；Snapshot 后要求重新注册。

P1 不负责把最新 Seq 写入数据库，但必须通过公开 Effect/回调让 P4 能持久化推进后的 Seq。

### 7.4 客户端消息去重与幂等

- 单连接内使用有界 `messageId` 去重集合。
- 重复瞬时消息不重复执行，但可以返回稳定的重复结果。
- 状态变更消息缺少 `idempotencyKey` 时拒绝；最终跨重启幂等由 P2/P4 处理。
- P1 不缓存业务结果来假装跨重启幂等。
- 去重集合有容量和淘汰策略，不能无限增长。

### 7.5 心跳

- 心跳间隔、超时和最大漏答次数配置化。
- 使用 `MonotonicClock` 判断超时。
- `tick()` 或等价 API 产生 Ping、Pong、Close Effect；测试不需要真实 Socket。
- 慢客户端、Clock 消息和普通业务消息不能阻止安全/关闭消息处理。

## 8. 有界发送队列

默认门槛：512 条或 8 MiB，任一达到即背压。门槛必须可配置。

优先级：

1. 安全、取消、Scene Commit、协议错误。
2. Media 控制和 Session 状态。
3. World Snapshot 增量。
4. 调试 Trace 和可丢弃遥测。

必须实现：

- 同时统计消息数和编码后字节数。
- 可替代的低优先级消息可按稳定 Key 合并。
- 先淘汰最低优先级；记录类别和计数，不记录完整 Payload。
- 高优先级消息无法入队时返回明确 `close_slow_consumer`，不能静默丢失。
- 一个连接的队列对象不与其他连接共享可变状态。
- 所有边界和淘汰顺序有确定性测试。

## 9. Binary Media 协议

### 9.1 帧布局

必须严格实现上位文档定义的布局：

```text
4 bytes  "BELL"
1 byte   version = 1
1 byte   media kind
2 bytes  flags, unsigned LE
4 bytes  header length, unsigned LE
N bytes  UTF-8 JSON header
M bytes  payload
```

默认 Header 上限 16 KiB，Payload 上限 1 MiB，均可配置。

### 9.2 增量 Parser

- 接受任意分片方式，只有完整帧到达后才返回结果。
- 读取长度后先检查上限，再分配目标 Buffer。
- 非法 Magic/版本/Flags/Header 长度/UTF-8/JSON/Schema 均稳定拒绝。
- Parser 失败后进入明确的失败或 Reset 状态，不能继续误读后续字节。
- 不保留超限输入的完整副本。

### 9.3 Stream Registry

- Stream 必须经 Control `media.stream.open` 注册后才能收帧。
- 校验 Session、Stream、Media Kind、Content-Type、严格递增 Sequence。
- 重复或乱序 Frame 拒绝；关闭后的 Stream 不能复活。
- `frameId` 去重与 Sequence 顺序是两个不同约束。
- Deadline 已过且帧不可再使用时拒绝。
- 连接关闭时释放所有 Stream 和 Buffer。

Phase 1 Payload 使用随机测试字节，文档不得称其为真实 PCM、viseme 或可播放音频。

## 10. 测试计划

### 10.1 单元测试

- System/Virtual Clock 的到期、Abort 和并发等待。
- Clock 样本合法性、异常值过滤和重连 Reset。
- Envelope/Payload 合法、非法、未知 Type、方向错误和十进制溢出。
- 状态机所有合法和非法转移。
- ACK 重复、倒退、超前，Replay 命中和缺口。
- `messageId` 去重、幂等键要求和去重容量。
- 队列的合并、淘汰、高优先级保护和双门槛。
- Media 编解码、分片、长度、UTF-8、Stream 与 Sequence。

### 10.2 fast-check 性质测试

- 任意合法 Envelope 编解码等价。
- 任意合法 Media Frame 编解码等价。
- 任意分片组合产生相同帧或相同稳定错误。
- 任意 ACK 序列不会让已确认 Seq 倒退。
- 任意队列操作不会突破配置的消息/字节上限。
- 任意 VirtualClock 推进不会提前释放等待者。

### 10.3 集成测试

使用内存 Adapter 或本地临时 WS Harness，覆盖：

- Hello、Heartbeat、Clock、ACK、重连和 Replay Gap。
- 客户端断线后用同一幂等键重试状态变更。
- Media Stream 注册、合法帧、非法帧和关闭。
- 持续 Media 压力下 Control 心跳/取消仍能及时被处理。
- Abort 后连接、Timer、Parser Buffer 和任务全部释放。

集成测试不能访问公网，也不能依赖长时间 sleep。

## 11. 协议文档要求

`control-websocket.md` 至少写明：

- 握手状态机和所有消息方向。
- Envelope 示例、错误示例和版本策略。
- Seq/ACK/Replay 与客户端幂等的非对称语义。
- Snapshot/Replay Gap、Heartbeat、Clock、Deadline 和背压。
- 默认限制、关闭码和 P4 Adapter 使用方式。

`binary-media-websocket.md` 至少写明：

- 字节布局、大小端、Media Kind/Flags 表。
- Header Schema、合法帧十六进制示例和失败示例。
- Stream 注册、顺序、Deadline、资源上限和关闭语义。
- Phase 1 只传测试字节的范围声明。

文档示例必须通过测试 Fixture 或生成脚本验证，不能维护一份未经测试的协议副本。

## 12. 验收命令

```bash
pnpm --filter @bellis/transport typecheck
pnpm --filter @bellis/transport lint
pnpm --filter @bellis/transport format:check
pnpm --filter @bellis/transport test
pnpm --filter @bellis/transport test:integration
pnpm contracts:check
pnpm build
```

## 13. 拒绝合入条件

- 在 Wire 中序列化裸 `bigint`。
- 用 `Date.now()` 调度心跳、Deadline 或等待。
- 队列、Replay、去重或 Parser Buffer 无上限。
- 未先验证长度就分配大型 Buffer。
- Transport 直接导入 Fastify、SQLite 或 Runtime 私有代码。
- 复制 Contracts 类型，或对入站 `unknown` 做类型断言跳过校验。
- 以真实长 sleep 代替 VirtualClock。
- Media 压力可以饿死 Control 安全消息。
- 测试脚本为空成功、跳过性质测试或协议文档与实现不一致。

## 14. 可直接交给 Agent 的任务提示

```text
你负责 Bellis Phase 1 的 P1 Transport。基线和执行规则见 docs/phase-1/README.md，完整任务见 docs/phase-1/p1-transport.md。先完成共同基线检查和 Gate 1.1 公开 API 清单；只修改 packages/transport/**、docs/protocols/control-websocket.md、docs/protocols/binary-media-websocket.md。严格复用 @bellis/contracts 和 Gate 1 VirtualClock，实现 SystemMonotonicClock、时钟偏移估计、Control 解码/状态机、服务端 Seq/ACK/Replay、客户端 messageId/幂等语义、心跳/Deadline、有界优先级队列、Media Frame 编解码/增量 Parser/Stream Registry，并提供不依赖 Fastify 的公开适配接口。不要实现 Runtime、数据库、Stage 或真实音频。使用 Vitest/fast-check 覆盖分片、乱序、重复、Abort、重连、Replay Gap 和背压；完成两份协议文档。运行文档第 12 节全部命令，并按 README 第 9 节格式报告公开 API、限制、测试证据、风险、分支和 Commit。
```
