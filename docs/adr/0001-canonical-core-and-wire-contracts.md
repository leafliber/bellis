# ADR 0001：Canonical Core and Wire Contracts

> 2026-09-06 架构审查修订：任务所有权、工具恢复事实、调用列表范围、场景终态、Seq 分段预留及 Provider 接缝以 [ADR 0007](./0007-task-ownership-and-runtime-scope.md) 为准。 本文保留历史决策/实施过程；与新决策冲突的描述不再作为当前实现要求。

> 状态：Accepted
>
> 日期：2026-08-19
>
> 决策范围：DecisionPacket、Control WebSocket Envelope、双向可靠性与 JSON Schema dialect
>
> 关联文档：[系统架构设计](../architecture-plan.md) · [技术选型基线](../technology-selection.md) · [Phase 1 完成态参考](../phase-1-reference.md)

## 背景

早期设计示例表达了相同的不变量，但具体类型发生了漂移：

- `architecture-plan.md` 曾在 `DecisionPacket` 顶层使用必填 `message: string`。
- `technology-selection.md` 曾在 `DecisionPacket` 顶层使用可选 `speech`，同时保留 `action`。
- Phase 1 需要让 TTS、字幕、口型和 ActionFrame 读取同一份 SpeechIntent。
- `technology-selection.md` 曾在 WebSocket Envelope 中直接使用 `bigint` 和扁平 `traceId`；裸 `bigint` 无法被 JSON 序列化。
- 原设计只明确了服务端消息的 Seq/ACK，没有明确客户端消息断线后的语义。
- OpenAPI 3.1 与 Fastify/LLM Tool 需要不同 JSON Schema dialect，但必须保持一个 Schema 源。

如果不在实现前收敛，多个 Agent 会各自选择一种“看起来合理”的协议，最终在模型适配、Stage、持久化和重连处发生返工。

## 决策

### 1. DecisionPacket 只有一个发言来源

核心规范形态：

```ts
interface DecisionPacket {
  schemaVersion: 1;
  cycleId: string;
  toolCalls: ToolCall[];
  action: ActionFrame;
  next: "finish" | "after_tools" | "continue";
}

interface ActionFrame {
  schemaVersion: 1;
  noOp?: true;
  speech?: SpeechIntent;
  avatar?: AvatarIntent[];
  game?: GameIntent[];
  overlay?: OverlayIntent[];
  sync: SyncPolicy;
}
```

- 发言只存在于 `DecisionPacket.action.speech`。
- 不设置顶层 `message` 或顶层 `speech`。
- 每个有效 DecisionPacket 恰好包含一个 ActionFrame。
- ActionFrame 携带 `schemaVersion: 1`；至少包含一个行动（`speech`，或非空的 `avatar`/`game`/`overlay` 数组，1–32 个意图）或显式 `noOp: true`，不允许空帧；`noOp` 与任何实际行动互斥。
- 没有发言时允许静默行动或明确 No-op，不生成填充文本。
- Model Provider 的原始输出可以不同，但进入核心前必须规范化并通过 Schema 校验。

### 2. Control Envelope 使用 JSON-safe Wire 类型

规范 Wire 形态：

```ts
interface ControlEnvelopeBase<T> {
  version: 1;
  type: string;
  messageId: string;
  sessionId: string;
  trace: {
    traceId: string;
    spanId?: string;
  };
  sentAtUs: string;
  deadlineUs?: string;
  payload: T;
}

interface ServerControlEnvelope<T> extends ControlEnvelopeBase<T> {
  direction: "server";
  seq: string;
}

interface ClientControlEnvelope<T> extends ControlEnvelopeBase<T> {
  direction: "client";
  ack?: string;
  idempotencyKey?: string;
}

type ControlEnvelope<T> =
  | ServerControlEnvelope<T>
  | ClientControlEnvelope<T>;
```

- `seq`、`ack`、微秒时间和水位在 JSON/WS 中使用非负十进制字符串。
- Runtime 边界校验通过后再无损转换为 `bigint`。
- `direction` 是判别字段：只有服务端 Envelope 包含 `seq`，只有客户端 Envelope 可以包含累计 `ack` 和业务 `idempotencyKey`。
- `messageId` 用于消息去重；`seq/ack` 用于服务端消息的排序、累计确认和 Replay，三者不能互换。
- Trace 使用结构化对象，为 W3C `traceId/spanId` 传播留出稳定位置。
- 所有 Envelope 先验证外层，再按 `type` 验证 Payload。

### 3. 双向可靠性有意不对称

服务端到客户端：

- 每个逻辑 Session 的 `seq` 严格递增。
- 客户端用 `ack` 确认已处理的最大连续服务端序号。
- 服务端维护有界 Replay Window；缺口过大时发送版本化 `session.snapshot`。

客户端到服务端：

- 单连接内使用 WebSocket 自身的可靠有序传输。
- 所有业务消息携带 `messageId`，用于连接内短期去重。
- 持久化状态变更额外携带 `idempotencyKey`，用于跨连接、跨重启去重。
- 断线时在飞请求结果视为不确定；客户端重连读取 Snapshot 后，用相同幂等键重试允许重试的命令。
- 心跳和时钟样本不重放；不为客户端方向建立第二套累计 ACK 日志。

### 4. 一个 Zod 源，两个 JSON Schema target

- Zod 4 Schema 是唯一源。
- 输出 JSON Schema 2020-12，供 OpenAPI 3.1 和对外契约。
- 输出 JSON Schema Draft 7，供 Fastify/Ajv 运行期验证和 LLM Tool。
- 两套生成物使用相同的成功/失败 Fixture 做语义等价测试。
- 两个目录分别进行生成物漂移检查，不能手工维护分叉 Schema。

## 被替代的示例

以下形态不再有效：

```ts
// 已替代：架构文档早期示例
interface DecisionPacket {
  message: string;
  action: ActionFrame;
}
```

```ts
// 已替代：选型文档早期示例
interface DecisionPacket {
  speech?: { text: string };
  action: ActionFrame;
}
```

```ts
// 已替代：无法 JSON 序列化的 Wire 示例
interface Envelope<T> {
  seq: bigint;
  sentAtUs: bigint;
  traceId: string;
  payload: T;
}
```

三份主文档已经回写规范示例。后续协议差异必须修改 ADR/Contracts 和上游示例，不能依赖阅读优先级掩盖漂移。

## 影响

正向影响：

- TTS、字幕、口型和场景动作共享唯一 SpeechIntent。
- 静默行动成为一等能力。
- WebSocket JSON 不会因 `bigint` 序列化失败。
- 重连、去重和幂等边界清晰。
- OpenAPI 与 LLM Tool 可以使用各自兼容的 dialect，而不产生两套业务类型。

代价：

- Provider Adapter 必须执行一次规范化。
- Wire 与 Runtime 之间需要十进制字符串/`bigint` 转换。
- Contracts 生成和 CI 漂移检查要运行两次 target。
- 客户端需要区分 `messageId` 与业务 `idempotencyKey`。

## 验收

P0 必须证明：

- 三份文档的规范示例与 Zod Contracts 一致。
- DecisionPacket 不存在第二个发言字段。
- Wire Schema 中不存在裸 `bigint`。
- 大序号和微秒时间 JSON 往返无精度损失。
- 服务端 Replay、客户端不确定重试和 `session.snapshot` 有契约测试。
- 2020-12 与 Draft 7 生成物通过同一组语义 Fixture。

## 修订记录

### 2026-08-20 · Envelope type 模式允许单段（P1 发现的缺陷修正）

P1 Transport 实现错误分类时发现：`KNOWN_CONTROL_MESSAGE_TYPES` 与
`ControlPayloadSchema` 已冻结单段类型 `"error"`，但 Envelope 的
`CONTROL_MESSAGE_TYPE_PATTERN` 原为 `^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$`
（至少一个点号），导致 `error` Envelope 永远无法通过外层校验，协议自身的
稳定错误通道不可用。

修正：量词从 `+` 放宽为 `*`（`^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$`），
允许单段小写 type。属于纯扩展——原有合法值全部保持合法，Zod、双 dialect
生成物与 Fixture 已同步更新（server/client/control envelope 三个 Schema
的 pattern 与新增 `"error"` Envelope 合法 Fixture、`Clock.ping` 大小写
非法 Fixture）。无并行任务需要同步（P2/P3 尚未开工）。

### 2026-08-22 · 服务端 Envelope `seq` 收紧为 ≥ 1（Gate 3 重开评审发现的规范债务）

冻结协议（control-websocket.md §1/§5）规定服务端 Seq 从 1 开始、
「禁止用 seq: "0" 伪装方向」，但 `ServerControlEnvelopeSchema` 此前
沿用了允许 "0" 的通用 `DecimalStringSchema`，`seq: "0"` 可通过校验，
Schema 与协议文档矛盾。

修正：seq pattern 收紧为 `^[1-9][0-9]{0,29}$`（正数规范十进制，无前导
零）。属于纯收窄——真实服务端 Seq 恒 ≥ 1（nextSeq 从 1 起，Seq 在发送
时分配），无合法流量被拒绝；客户端 `ack` 维持非负（"0" 表示尚未处理
任何消息，语义合法）。双 dialect 生成物、语义 Fixture（合法样例改用
seq ≥ 1，非法侧新增 "0"/"00"/"01"）与性质测试生成器已同步。消费者
（P1 Transport / P4 Runtime）不产生 seq "0"，无需变更。
