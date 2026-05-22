# Bellis 可观测性模块使用指南

本模块提供纯本地的可观测性能力：分布式追踪（Tracing）、指标采集（Metrics）、日志关联（Logging），以及前端面板实时展示。

## 架构总览

```
┌─────────────────────────────────────────────────────┐
│  Layer 1: OpenTelemetry Trace（@traced 装饰器）      │
│  全链路 span，支持 Console / OTLP / 进程内三种导出    │
├─────────────────────────────────────────────────────┤
│  Layer 2: OpenTelemetry Metrics（业务指标）          │
│  事件计数、循环耗时、错误率，导出到 Prometheus        │
├─────────────────────────────────────────────────────┤
│  Layer 3: OTel Logs（日志关联）                      │
│  日志自动携带 trace_id/span_id                       │
├─────────────────────────────────────────────────────┤
│  Layer 4: 自建 Tracer + SnapshotExporter（内存调试）  │
│  进程内追踪记录与状态快照，用于前端面板和快速调试      │
├─────────────────────────────────────────────────────┤
│  Layer 5: 前端可观测性面板（实时 WebSocket 推送）     │
│  TracePanel / MetricsPanel / SnapshotPanel           │
└─────────────────────────────────────────────────────┘
```

## 模块组成

```
bellis.observability
├── otel.py          # OTel 集成：Provider 初始化、@traced 装饰器、Metrics、Console Exporter
├── tracing.py       # 自建轻量 Tracer：内存级 span 追踪
├── snapshot.py      # SnapshotExporter：AgentState 快照采集与导出
└── __init__.py      # 统一导出
```

---

## 快速开始

### 1. 一键初始化（推荐）

BellisApp 默认启用全部可观测性组件：

```python
from bellis.app import BellisApp

# 本地调试模式（span 打印到终端）
app = BellisApp(
    console_export=True,
    enable_gateway=True,
)

# 连接 OTel Collector 模式
app = BellisApp(
    otlp_endpoint="http://localhost:4317",
    enable_gateway=True,
)

# 最轻量模式（仅进程内追踪 + 前端面板）
app = BellisApp(enable_gateway=True)
```

### 2. 手动初始化

若不使用 BellisApp，可手动调用：

```python
from bellis.observability import setup_observability

setup_observability(
    service_name="bellis-agent",
    otlp_endpoint="http://localhost:4317",  # 可选
    console_export=True,                     # 可选，终端输出 span
    enable_tracing=True,
    enable_metrics=True,
)
```

### 3. 纯环境变量驱动

无需修改代码，仅通过环境变量控制：

```bash
# OTel 导出端点
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4317"

# OTel 服务名称
export OTEL_SERVICE_NAME="bellis-agent"
```

---

## OpenTelemetry Trace — @traced 装饰器

`@traced` 装饰器为 LangGraph 节点函数自动创建 OTel span，从 AgentState 提取关键属性，异常时记录错误状态。

### 基本用法

```python
from bellis.observability import traced

@traced("bellis.node.perceive")
async def perceive(state: AgentState) -> dict:
    ...

@traced()  # 默认名称 "bellis.node.{func.__name__}"
async def think(state: AgentState) -> dict:
    ...
```

### 自动提取的 Span 属性

**输入**（从 AgentState 提取）：

| 属性 | 说明 |
|------|------|
| `event.source` | 事件来源（danmaku/gift/command 等） |
| `event.content_preview` | 事件内容预览（前 100 字符） |
| `perception.intent` | 感知意图（greeting/question/gift 等） |
| `perception.emotion` | 情绪标签（happy/angry/neutral 等） |
| `perception.priority` | 重评估优先级 |

**输出**（从返回字典提取）：

| 属性 | 说明 |
|------|------|
| `response.emotion` | 响应情绪 |
| `action.count` | 生成的 Action 数量 |

### 已装饰的节点

| Span 名称 | 对应阶段 |
|-----------|---------|
| `bellis.node.dequeue_event` | 事件出队 |
| `bellis.node.perceive` | 感知阶段 |
| `bellis.node.think` | 同步思考 |
| `bellis.node.stream_think` | 流式思考 |
| `bellis.node.act` | 执行阶段 |
| `bellis.node.handle_interrupt` | 中断处理 |

### Span 层级关系

```
bellis.process_event              ← 主循环根 span（app.py 创建）
  ├── bellis.node.dequeue_event
  ├── bellis.node.perceive
  ├── bellis.node.think / stream_think
  └── bellis.node.act
```

### 注意事项

- OTel SDK 未初始化时，`@traced` 为 no-op，不影响业务逻辑
- 装饰器同时支持同步和异步函数
- 异常时自动设置 span 状态为 ERROR 并记录异常堆栈

---

## Console Exporter — 终端输出

将 OTel span 实时打印到终端，适用于本地调试，无需部署任何外部服务。

### 启用方式

```python
# 方式 1：BellisApp 参数
app = BellisApp(console_export=True)

# 方式 2：手动初始化
from bellis.observability.otel import init_tracing
init_tracing(console_export=True)

# 方式 3：setup_observability
setup_observability(console_export=True)
```

### 终端输出示例

```json
{
    "name": "bellis.node.perceive",
    "context": {"trace_id": "0xabc123...", "span_id": "0xdef456..."},
    "kind": "SpanKind.INTERNAL",
    "parent_id": "0x789...",
    "start_time": "2025-01-01T12:00:00Z",
    "end_time": "2025-01-01T12:00:00.015Z",
    "status": {"status_code": "OK"},
    "attributes": {
        "event.source": "danmaku",
        "perception.intent": "greeting",
        "perception.emotion": "happy"
    }
}
```

### 导出模式优先级

| 优先级 | 模式 | 说明 |
|--------|------|------|
| 1 | `console_export=True` | span 打印到终端 |
| 2 | `otlp_endpoint` 配置 | span 导出到 OTLP Collector |
| 3 | 均未配置 | span 仅在进程内可见 |

---

## OpenTelemetry Metrics — 业务指标

初始化后自动注册以下指标仪器：

| 指标名称 | 类型 | 说明 |
|---------|------|------|
| `bellis.events.processed` | Counter | 已处理事件总数 |
| `bellis.loop.duration` | Histogram | 主循环单轮端到端耗时（ms） |
| `bellis.errors.total` | Counter | 错误总数 |
| `bellis.llm.tokens.total` | Counter | LLM token 消耗总量 |

### 指标使用示例

```python
from bellis.observability.otel import events_counter, loop_duration

# 记录事件处理
if events_counter is not None:
    events_counter.add(1, {"source": "danmaku"})

# 记录循环耗时
if loop_duration is not None:
    loop_duration.record(150.5, {"source": "gift"})
```

### 指标导出

- 配置 `otlp_endpoint` 后，指标每 15 秒自动导出至 OTLP Collector
- 可通过 `init_metrics(export_interval_ms=...)` 调整导出间隔
- 无端点时指标仅在进程内可见（适用于开发调试）

---

## OTel Logs — 日志关联

集成 `opentelemetry-instrumentation-logging` 后，日志自动携带 trace_id 和 span_id。

### 日志格式

```
# 标准格式（无 OTel context 时）
2025-01-01 12:00:00 | INFO     | bellis.agent | Graph 执行完成

# OTel 关联格式（有 OTel context 时）
2025-01-01 12:00:00 | INFO     | trace_id=abc123 span_id=def456 | bellis.agent | Graph 执行完成
```

### 启用方式

```python
from bellis.core.logging import setup_logging

# 默认启用 OTel 日志关联
setup_logging(level="INFO")

# 显式关闭
setup_logging(level="INFO", enable_otel_correlation=False)
```

---

## 前端可观测性面板

Bellis 前端通过 WebSocket 实时接收后端推送的追踪和指标数据，在可观测性面板中展示。

### 数据流

```
后端 app.py 主循环
  │
  ├─ Gateway.broadcast_traces(tracer.get_traces())
  │     → ServerMessage { type: "trace", payload: { spans: [...] } }
  │
  ├─ Gateway.broadcast_metrics(state)
  │     → ServerMessage { type: "metrics", payload: { event_queue_size, ... } }
  │
  └─ WebSocket (ws://localhost:8765)
        │
        ▼
  前端 useEventStore → handleWSMessage()
        │
        ├─ type="trace"   → useObservabilityStore.updateTraces()
        └─ type="metrics" → useObservabilityStore.updateMetrics()
                              │
                              ▼
                    Observability 页面
                    ├─ TracePanel     ← 树形展示追踪记录
                    ├─ MetricsPanel   ← 展示运行指标卡片
                    └─ SnapshotPanel  ← 手动拍摄状态快照
```

### 启用前端面板

```python
app = BellisApp(enable_gateway=True)
```

启动后前端连接 `ws://localhost:8765`，即可在 Observability 页面看到实时数据。

### Trace 面板

展示自建 Tracer 的追踪记录，树形结构显示每个 span 的名称、耗时、输入输出摘要。每轮主循环自动推送最新数据。

### Metrics 面板

展示 5 个运行指标卡片：
- 事件队列大小
- TTS 队列大小
- 熔断器状态
- 状态版本号
- 事件处理速率

### Mock 模式

未连接后端时，点击前端 "Mock" 按钮可启动模拟数据轮询，用于开发调试。

---

## 自建 Tracer — 内存级追踪

`Tracer` 和 `TraceSpan` 提供进程内的轻量级链路追踪，不依赖 OTel SDK，适用于快速调试和前端面板展示。

### 基本用法

```python
from bellis.observability import Tracer

tracer = Tracer(max_traces=1000)

with tracer.span("process_event", {"source": "danmaku"}) as span:
    span.input_data = "用户弹幕内容"
    # ... 业务逻辑 ...
    span.output_data = "回复内容"

# 获取所有追踪记录
traces = tracer.get_traces()  # -> list[dict]

# 清空
tracer.clear()
```

### 嵌套 span

```python
with tracer.span("parent"):
    with tracer.span("child_1"):
        pass
    with tracer.span("child_2"):
        pass

# traces[0]["children"] 包含 child_1 和 child_2
```

### 异常记录

```python
try:
    with tracer.span("risky_op"):
        raise ValueError("boom")
except ValueError:
    pass

# traces[0]["metadata"]["error"] == "ValueError: boom"
```

---

## SnapshotExporter — 状态快照

`SnapshotExporter` 采集 AgentState 的深拷贝快照，附加时间戳后存储在内存中。

### 基本用法

```python
from bellis.observability import SnapshotExporter

exporter = SnapshotExporter(max_snapshots=100)

# 采集快照
snapshot = exporter.take_snapshot(state)

# 获取所有快照
snapshots = exporter.get_snapshots()

# 导出 JSON
json_str = exporter.export_json()

# 清空
exporter.clear()
```

### 快照特性

- 自动深拷贝，修改原始 state 不影响快照
- 深拷贝失败时降级为浅拷贝（如 state 包含不可序列化对象）
- 每个快照附加 `_snapshot_time` 时间戳
- 超过上限自动淘汰最旧的快照

---

## 配置参考

### 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP gRPC 导出端点 | （无） |
| `OTEL_SERVICE_NAME` | OTel 服务名称 | `bellis-agent` |

### BellisApp 参数

| 参数 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `otlp_endpoint` | `str \| None` | OTLP 导出端点 | `None` |
| `console_export` | `bool` | span 打印到终端 | `False` |
| `enable_otel` | `bool` | 启用 OTel | `True` |
| `enable_gateway` | `bool` | 启用前端面板 | `False` |

### setup_observability 参数

| 参数 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `service_name` | `str` | 服务名称 | `"bellis-agent"` |
| `otlp_endpoint` | `str \| None` | OTLP 导出端点 | `None` |
| `console_export` | `bool` | span 打印到终端 | `False` |
| `enable_tracing` | `bool` | 启用 OTel 追踪 | `True` |
| `enable_metrics` | `bool` | 启用 OTel 指标 | `True` |

---

## 典型部署场景

### 场景 1：本地开发（终端 + 前端面板）

```python
app = BellisApp(console_export=True, enable_gateway=True)
```

- OTel span 打印到终端
- 前端面板实时展示追踪和指标
- 无需任何外部服务

### 场景 2：生产部署（OTel Collector + Grafana）

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://otel-collector:4317"
```

```python
app = BellisApp(enable_gateway=True)
```

- OTel Trace → OTLP Collector → Jaeger/Tempo
- OTel Metrics → OTLP Collector → Prometheus + Grafana
- 日志自动携带 trace_id，可关联到 Loki/ELK
- 前端面板同时可用

### 场景 3：最轻量（仅前端面板）

```python
app = BellisApp(enable_gateway=True)
```

- 自建 Tracer 追踪数据推送到前端面板
- OTel span 仅在进程内可见
- 无需任何外部服务
