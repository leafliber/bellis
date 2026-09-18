# Bellis 契约登记（0.8.0）

设计中机器可读的部分：字段结构、状态机、守卫、事件、错误码、命令、代次和不变量。只登记现行阶段（P0/P1）；后续阶段的登记冻结在 [docs/future/contracts](../docs/future/contracts/)。修改规则见 [AGENTS.md](../AGENTS.md)。

## 编辑源：`src/`

| 文件 | 内容 |
| --- | --- |
| `schema.json` | 手写的对象形状（JSON Schema 2020-12，引用全部本地闭合，所有对象封闭） |
| `state-machines.json` | 状态机：状态、初终态、转换、守卫、最早阶段 |
| `guards.json` | 守卫标识及其受信语义 |
| `object-records.json` | 状态机与持久化记录 Schema 的绑定 |
| `events.json` | 公开事件：权威来源、载荷 Schema、可靠性、去重 |
| `errors.json` | 原因码、所属类别、恢复分类、最早阶段 |
| `commands.json` | 命令：目标、输入/结果 Schema、权限、效果类、幂等、不支持原因 |
| `contract-registry.json` | 契约引用（精确 ref 与其 Schema） |
| `epochs.json` | 代次与序号字段的唯一写入者、比较作用域、递增时机与接纳规则 |
| `termination-reasons.json` | 统一终止原因词表 |
| `resources.json` | 资源类别 |
| `invariants.json` | 不变量：必测方向、最早阶段、验收状态、测试 ID |
| `verification.json` | 阶段依赖、测试登记（runner 与实现状态）、阶段出口 |

## 派生定义

以下定义由 `tools/generate.ts` 从登记派生，`schema.json` 只能引用、不能手写：

| 定义 | 来源 |
| --- | --- |
| `Phase` | `verification.json` 的阶段 |
| `EventName`、`EventPayloadBinding` | `events.json`（EventEnvelope 按事件名绑定载荷） |
| `ErrorCategory`、`ReasonCode`、`RetryDisposition`、`ErrorReasonBinding` | `errors.json`（ErrorEnvelope 按原因码绑定类别与恢复分类） |
| `TerminationReason` | `termination-reasons.json` |
| `<状态机>State`，如 `SegmentState` | `state-machines.json` |
| `ResourceKind` | `resources.json` |
| `RpcRequest` | `commands.json`（每个命令一个 JSON-RPC 请求形状） |

## `fixtures/`

`runtime-profile.json`（联调用 RuntimeProfile 示例）和 `plugin-manifest.json`（模拟插件 Manifest）。其中的权限与规则都是测试值，不构成真实执行授权。

## `generated/`

`pnpm generate` 的产物，不要手改：

| 文件 | 用途 |
| --- | --- |
| `bundle.schema.json` | 合成后的完整 Schema；引用类型时用 `contracts/generated/bundle.schema.json#/$defs/<名称>` |
| `types.ts` | 全部定义的结构类型（边界与条件由校验器负责） |
| `registries.ts` | SDK 读取的登记快照与 `schemaDigest` |
| `validators.mjs`、`validators.d.mts` | Ajv 预编译的独立 ESM 校验器 |

SDK 入口是 [packages/contract-sdk/src/index.ts](../packages/contract-sdk/src/index.ts)。它只提供结构校验、转换决定和模拟联调，不实现生产守卫或设备动作。
