# P3 开发文档：Observability 与 Testkit

> 任务编号：Phase 1 / P3
> 前置 Gate：P0 / Gate 1 已合入
> 建议分支：`codex/phase1-observability`
> 文件所有权：`packages/observability/**`、`packages/testkit/**`
> 上位规范：[Phase 1 构建指导](../phase-1-build-guide.md) 第 6、7、10–13.4 节 · [ADR 0001](../adr/0001-canonical-core-and-wire-contracts.md)

## 1. 任务目标

在保持 Gate 1 Logger/Metrics Port 和 `VirtualClock` 兼容的前提下，交付 P1、P2、P4 可直接使用的 Trace、结构化日志、内存指标和确定性测试设施。

本任务结束时必须具备：

- W3C `traceparent` 解析、格式化、创建和显式传播。
- 可选的异步 Trace 上下文管理，不依赖共享可变全局变量。
- 实现既有 `LoggerPort` 的 Pino Logger Factory、子 Logger 和字段级 Redaction。
- 实现既有 `MetricsPort` 的内存 Registry、快照和有界 Label/Cardinality 策略。
- Phase 1 指标定义与测试。
- 确定性 ID、随机源、临时目录和协议 Fixture 工具。
- 保持 `VirtualClock` 的既有 API 与行为不变。
- 单元、性质和使用示例测试。

## 2. 明确不做

- 不部署 OpenTelemetry Collector、Prometheus、Grafana 或外部日志系统。
- 不要求网络可用，不把测试发送到公网。
- 不让生产包依赖 `@bellis/testkit`。
- 不把完整 Signal、Cookie、Token、授权头、数据库内容或隐私 Payload 作为日志字段。
- 不以 Trace ID 替代 Session/Cycle/Scene 等业务 ID。
- 不把 Span/Metric Label 做成任意用户输入或高基数 ID 集合。
- 不修改 Contracts 中的 TraceContext 形态，除非走正式协议变更流程。

## 3. 不可破坏的 Gate 1 契约

以下导出已经被 P1/P2 依赖：

```ts
LoggerPort
LogLevel
LogFields
createNoopLogger

MetricsPort
CounterMetric
GaugeMetric
HistogramMetric
MetricLabels
createNoopMetrics

VirtualClock
```

约束：

- 不删除、重命名或改变现有方法语义。
- `VirtualClock` 的 `nowUs/sleepUntil/advance/advanceBy/pendingCount` 行为保持不变。
- `packages/testkit/src/index.ts` 只追加导出。
- 新实现必须可通过现有 Port 使用；不能要求 P1/P2 改成依赖 Pino/OpenTelemetry 的具体类型。

## 4. 开工步骤

1. 从 Gate 1 Commit 创建分支和独立 worktree。
2. 阅读 Observability/Testkit 现有源码和 Contracts `TraceContextSchema`。
3. 运行 [任务索引](./README.md) 第 4 节共同检查。
4. 提交 Gate 1.1 公开 API 清单，说明 P1/P2/P4 的最小使用方式。
5. 新增依赖必须精确锁定，并说明用途、运行时影响和替代方案；Pino 是上位选型允许的实现。

## 5. 推荐目录

```text
packages/observability/
  src/
    trace/
      traceparent.ts
      trace-context.ts
      context-manager.ts
    logger/
      pino-logger.ts
      redaction.ts
    metrics/
      definitions.ts
      in-memory-registry.ts
    index.ts
  test/
    trace.test.ts
    logger.test.ts
    redaction.test.ts
    metrics.test.ts

packages/testkit/
  src/
    virtual-clock.ts        # 行为冻结，不修改
    deterministic-ids.ts
    deterministic-random.ts
    temp-data-directory.ts
    protocol-fixtures.ts
    index.ts
  test/
```

目录可以微调，但 Trace、日志、指标和 Testkit 不应混成一个通用 Utils 文件。

## 6. TraceContext

### 6.1 W3C traceparent

至少公开：

```ts
interface ParsedTraceparent {
  traceId: string;
  spanId: string;
  traceFlags: number;
}

function parseTraceparent(value: string): ParsedTraceparent | null;
function formatTraceparent(value: ParsedTraceparent): string;
function createTraceContext(input?: Partial<TraceContext>): TraceContext;
function childTraceContext(parent: TraceContext): TraceContext;
```

解析要求：

- 支持 W3C version `00` 的标准字段宽度。
- 拒绝全零 Trace ID / Span ID、非小写十六进制、错误长度、非法 flags 和多余字段。
- HTTP 收到非法 `traceparent` 时返回 `null`，由 P4 创建新 Trace；不能原样透传。
- 格式化输出稳定、全小写，不包含业务 ID。
- Trace/Span ID 生成使用加密安全随机源；测试使用注入的确定性源。

### 6.2 业务上下文传播

`TraceContext` 中存在的字段必须能显式派生和绑定：

```text
traceId
spanId?
sessionId?
turnId?
cycleId?
sceneId?
cueId?
toolRunId?
```

可以提供基于 `AsyncLocalStorage` 的 Context Manager，但必须：

- 以实例形式创建，不使用模块级共享可变单例。
- 提供 `run(context, callback)`、`current()` 和显式绑定方式。
- Worker/WS/Outbox 边界仍显式序列化 TraceContext，不能依赖 ALS 跨线程或跨进程传播。
- 没有上下文时行为明确，不静默复用上一个请求。

## 7. Logger

### 7.1 Factory

至少公开一个实现既有 Port 的工厂：

```ts
interface LoggerOptions {
  service: string;
  version: string;
  level: LogLevel;
  destination?: LoggerDestination;
}

function createPinoLogger(options: LoggerOptions): LoggerPort;
```

要求：

- 每条日志包含时间、level、service、version、event。
- `child()` 合并固定字段，但调用时字段不能覆盖受保护的 service/version/event 语义。
- Error 保留 `cause` 用于本地诊断，同时经过安全序列化和 Redaction。
- Logger 写入失败不能递归写日志或终止 Runtime 核心路径。
- 测试可注入内存 Destination，不能依赖读取控制台文本。

### 7.2 Redaction

默认按大小写不敏感的字段名和已知路径脱敏，至少覆盖：

```text
authorization
proxy-authorization
cookie
set-cookie
token
startupToken
sessionToken
accessToken
refreshToken
apiKey
password
secret
credentials
```

要求：

- 递归对象、数组、Error/Cause 和子 Logger 固定字段都经过处理。
- 不修改调用方传入对象。
- 循环引用、Getter 抛错、超深对象和超大字段稳定处理。
- 默认不记录完整 Signal Payload、数据库 Payload 或文件内容。
- 客户端错误永不返回本地 Stack、SQL 或绝对路径；本地开发日志可保留经过脱敏的 Stack。

Redaction 测试必须断言敏感原值不出现在序列化输出的任何位置，而不只检查顶层字段。

## 8. Metrics

### 8.1 Phase 1 指标

至少定义并测试：

```text
bellis_ws_connections
bellis_ws_queue_messages
bellis_ws_queue_bytes
bellis_ws_dropped_messages_total
bellis_clock_rtt_us
bellis_clock_offset_us
bellis_db_operation_duration_ms
bellis_db_worker_queue_depth
bellis_outbox_pending
bellis_outbox_delivery_total
bellis_scene_commit_total
bellis_scene_commit_duration_ms
```

### 8.2 In-memory Registry

至少公开：

```ts
interface MetricSnapshot {
  // 稳定、只读、可序列化的本地快照
}

interface InMemoryMetrics extends MetricsPort {
  snapshot(): MetricSnapshot;
  reset(): void;
}

function createInMemoryMetrics(options?: MetricsOptions): InMemoryMetrics;
```

要求：

- Counter 不能减少；Gauge 可升降；Histogram 记录 count/sum/min/max 和固定 Bucket 或等价摘要。
- 非有限数、负 Counter 增量和非法 Metric 名稳定拒绝。
- 每个已知指标有 Label Allowlist。
- 禁止 `traceId/sessionId/messageId/sceneId/outboxId/userId` 等高基数 ID 作为默认 Label。
- Registry 的 Series 数有配置上限；超过后拒绝或聚合到明确的 overflow Series，并记录一次安全告警。
- `snapshot()` 返回不可变副本，不能暴露内部 Map。
- Metrics 失败不阻塞业务路径。

可预留 OTLP Exporter Port，但 Phase 1 不要求实现网络导出。

## 9. Testkit

### 9.1 Deterministic IDs

提供固定种子下可重放的：

- UUID v4 形态 ID。
- W3C Trace ID / Span ID。
- `messageId/recordId/outboxId` 等测试 ID。

同一种子和调用顺序必须产生相同结果；不同命名空间不能意外碰撞。生产代码不得使用此生成器。

### 9.2 Deterministic Random

为 P2 Outbox 抖动和性质测试提供最小随机接口。不要引入全局 `Math.random` Mock；通过实例注入。

### 9.3 Temp Data Directory

提供：

- 在系统临时目录创建唯一目录。
- 返回绝对路径。
- 显式 `cleanup()`，重复清理幂等。
- 测试失败也可在 `afterEach/afterAll` 清理。
- 防止将仓库根、用户目录或未验证路径作为递归删除目标。

### 9.4 Protocol Fixtures

提供 P1/P2/P4 可复用的合法/非法 Envelope、Media Header、Scene、Outbox 和 Session Record 构造器：

- 默认值符合 Contracts。
- 调用方只覆盖所需字段。
- Fixture 返回新对象，不能共享可变 Payload。
- Fixture 不能成为第二套协议类型；返回类型来自 `@bellis/contracts`。

## 10. 依赖边界

- `@bellis/observability` 可以依赖 `@bellis/contracts`，不能依赖 Transport/Persistence/Runtime/Testkit。
- `@bellis/testkit` 可以依赖 Contracts；新增只用于测试的包必须放 devDependencies。
- P1/P2 对 Testkit 的依赖只能是 devDependency。
- P4 的生产依赖只能使用 Observability，测试代码才可使用 Testkit。
- 不为方便测试导出生产内部可变状态。

## 11. 测试计划

### 11.1 Trace

- 合法/非法 `traceparent` 全边界。
- 全零、大小写、错误 flags、额外字段和空白。
- Parent/Child 保持 Trace ID、更新 Span ID。
- 并发异步任务 Context 隔离。
- Worker 边界必须显式传播，不依赖 Context Manager 魔法。

### 11.2 Logger/Redaction

- 五个日志级别和 Child 字段合并。
- Token、Cookie、Authorization、API Key、嵌套数组、Error Cause 全部脱敏。
- 循环引用、Getter 抛错和大对象不会崩溃。
- 敏感原值不出现在最终字节输出。
- Logger 目的地失败不递归或终止业务。

### 11.3 Metrics

- Counter/Gauge/Histogram 语义。
- Label 顺序不产生重复 Series。
- 未允许 Label、高基数 Label 和 Series 上限。
- Snapshot 不可变、Reset、并发更新。
- 所有 Phase 1 指标名和单位一致。

### 11.4 Testkit

- 固定种子可重放，命名空间隔离。
- 临时目录创建/清理/重复清理/失败清理。
- 危险清理目标被拒绝。
- Fixture 通过 Contracts 且每次返回独立对象。
- Gate 1 `VirtualClock` 既有测试原样继续通过。

## 12. 验收命令

```bash
pnpm --filter @bellis/observability typecheck
pnpm --filter @bellis/observability lint
pnpm --filter @bellis/observability format:check
pnpm --filter @bellis/observability test
pnpm --filter @bellis/testkit typecheck
pnpm --filter @bellis/testkit lint
pnpm --filter @bellis/testkit format:check
pnpm --filter @bellis/testkit test
pnpm contracts:check
pnpm build
```

## 13. 拒绝合入条件

- 改变 `VirtualClock` 已冻结行为或删除现有导出。
- 生产包依赖 Testkit。
- 使用模块级共享可变 Trace 上下文导致并发串线。
- 非法 `traceparent` 被原样透传。
- Token/Cookie/Authorization/Secret 的原值出现在日志输出。
- 以高基数业务 ID 作为默认 Metric Label，或 Series 无上限。
- Logger/Metrics 错误可以终止 Runtime 关键路径。
- Temp Directory Helper 可删除仓库根、用户目录或任意未验证路径。
- Fixture 复制协议类型或返回共享可变对象。
- 测试依赖公网、真实业务等待或空脚本成功。

## 14. 可直接交给 Agent 的任务提示

```text
你负责 Bellis Phase 1 的 P3 Observability/Testkit。基线和执行规则见 docs/phase-1/README.md，完整任务见 docs/phase-1/p3-observability-testkit.md。先完成共同检查和 Gate 1.1 公开 API 清单；只修改 packages/observability/** 与 packages/testkit/**。保持 Logger/Metrics Port 和 Gate 1 VirtualClock 完全兼容，只追加导出。实现 W3C traceparent 解析/格式化/创建、实例化异步上下文管理、Pino Logger Factory、递归字段级 Redaction、Phase 1 内存 Metrics 与 Label/Cardinality 限制；在 Testkit 增加确定性 ID/随机源、安全临时目录和协议 Fixture。生产包不得依赖 Testkit，不部署外部 Collector，不访问公网。重点证明 Token/Cookie/Authorization/嵌套 Error 全脱敏、并发 Trace 不串线、高基数指标受限、固定种子可重放。运行文档第 12 节全部命令，并按 README 第 9 节报告公开 API、Redaction/确定性证据、风险、分支和 Commit。
```
