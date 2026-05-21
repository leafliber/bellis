"""OpenTelemetry 集成模块 — 提供分布式追踪、指标采集与日志关联能力。

本模块实现 Bellis 的正式可观测性接入，包括：
- OTel TracerProvider / MeterProvider 初始化与 OTLP 导出
- @traced 装饰器：为 LangGraph 节点自动创建 OTel span
- 业务指标定义（事件计数、循环耗时、LLM token 消耗等）
- LangSmith 零代码集成（环境变量驱动）

设计原则：
- 装饰器模式而非 Hook 注入：@traced 直接包裹节点函数，保留 OTel context 传播
- 优雅降级：OTel SDK 未配置时装饰器为 no-op，不影响业务逻辑
- 与自建 Tracer 解耦：两者独立运行，自建 Tracer 用于内存调试，OTel 用于生产导出
"""

from __future__ import annotations

import asyncio
import functools
import logging
import os
from collections.abc import Callable
from typing import Any

from opentelemetry import metrics, trace
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace import Status, StatusCode

logger = logging.getLogger(__name__)

# ─── 全局 OTel 对象 ──────────────────────────────────────────────

_tracer = trace.get_tracer("bellis.agent", "0.1.0")
_initialized = False

# ─── 指标仪器（由 init_metrics 填充）──────────────────────────

events_counter: metrics.Counter | None = None
loop_duration: metrics.Histogram | None = None
error_counter: metrics.Counter | None = None
llm_tokens_counter: metrics.Counter | None = None


# ─── 初始化函数 ─────────────────────────────────────────────────


def init_tracing(
    service_name: str = "bellis-agent",
    otlp_endpoint: str | None = None,
) -> None:
    """初始化 OTel TracerProvider 并配置 OTLP 导出。

    当 otlp_endpoint 为 None 时不创建 exporter，span 仅在进程内可见
    （适用于开发调试）。设置环境变量 OTEL_EXPORTER_OTLP_ENDPOINT
    也可指定端点。

    Args:
        service_name: 服务名称，用于标识 trace 来源。
        otlp_endpoint: OTLP gRPC 导出端点（如 "http://localhost:4317"）。
    """
    global _initialized  # noqa: PLW0603
    resource = Resource.create({"service.name": service_name})
    provider = TracerProvider(resource=resource)

    endpoint = otlp_endpoint or os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    if endpoint:
        from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter

        exporter = OTLPSpanExporter(endpoint=endpoint, insecure=True)
        provider.add_span_processor(BatchSpanProcessor(exporter))
        logger.info("OTel tracing 已启用，导出端点: %s", endpoint)
    else:
        logger.info("OTel tracing 已启用（无外部导出，仅进程内追踪）")

    trace.set_tracer_provider(provider)
    _initialized = True


def init_metrics(
    service_name: str = "bellis-agent",
    otlp_endpoint: str | None = None,
    export_interval_ms: int = 15000,
) -> None:
    """初始化 OTel MeterProvider 并注册业务指标。

    Args:
        service_name: 服务名称。
        otlp_endpoint: OTLP gRPC 导出端点。
        export_interval_ms: 指标导出间隔（毫秒）。
    """
    resource = Resource.create({"service.name": service_name})

    endpoint = otlp_endpoint or os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    readers = []
    if endpoint:
        from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter

        exporter = OTLPMetricExporter(endpoint=endpoint, insecure=True)
        readers.append(PeriodicExportingMetricReader(exporter, export_interval_millis=export_interval_ms))

    provider = MeterProvider(resource=resource, metric_readers=readers)
    metrics.set_meter_provider(provider)

    meter = metrics.get_meter("bellis.agent", "0.1.0")
    _register_metrics(meter)


def _register_metrics(meter: metrics.Meter) -> None:
    """注册 Bellis 业务指标。"""
    global events_counter, loop_duration, error_counter, llm_tokens_counter  # noqa: PLW0603

    events_counter = meter.create_counter(
        name="bellis.events.processed",
        description="已处理事件总数",
        unit="1",
    )
    loop_duration = meter.create_histogram(
        name="bellis.loop.duration",
        description="主循环单轮端到端耗时",
        unit="ms",
    )
    error_counter = meter.create_counter(
        name="bellis.errors.total",
        description="错误总数",
        unit="1",
    )
    llm_tokens_counter = meter.create_counter(
        name="bellis.llm.tokens.total",
        description="LLM token 消耗总量",
        unit="1",
    )


def init_langsmith() -> bool:
    """配置 LangSmith 追踪（环境变量驱动）。

    LangGraph 内置 LangSmith 回调支持，设置以下环境变量即可自动上报：
    - LANGSMITH_API_KEY: LangSmith API 密钥
    - LANGSMITH_TRACING: 设为 "true" 启用追踪
    - LANGSMITH_PROJECT: 项目名称（可选）

    Returns:
        是否成功启用 LangSmith 追踪。
    """
    api_key = os.environ.get("LANGSMITH_API_KEY")
    if not api_key:
        logger.debug("LANGSMITH_API_KEY 未设置，LangSmith 追踪未启用")
        return False

    os.environ.setdefault("LANGSMITH_TRACING", "true")
    os.environ.setdefault("LANGSMITH_PROJECT", "bellis")
    logger.info("LangSmith 追踪已启用，项目: %s", os.environ.get("LANGSMITH_PROJECT", "bellis"))
    return True


def setup_observability(
    service_name: str = "bellis-agent",
    otlp_endpoint: str | None = None,
    enable_tracing: bool = True,
    enable_metrics: bool = True,
    enable_langsmith: bool = True,
) -> None:
    """一键初始化全部可观测性组件。

    Args:
        service_name: 服务名称。
        otlp_endpoint: OTLP 导出端点。
        enable_tracing: 是否启用 OTel 追踪。
        enable_metrics: 是否启用 OTel 指标。
        enable_langsmith: 是否启用 LangSmith 追踪。
    """
    if enable_tracing:
        init_tracing(service_name=service_name, otlp_endpoint=otlp_endpoint)
    if enable_metrics:
        init_metrics(service_name=service_name, otlp_endpoint=otlp_endpoint)
    if enable_langsmith:
        init_langsmith()


# ─── @traced 装饰器 ─────────────────────────────────────────────


def _set_state_attributes(span: trace.Span, state: dict) -> None:
    """从 AgentState 提取关键属性注入 OTel span。"""
    if not span.is_recording():
        return
    event = state.get("current_event")
    if event is not None:
        span.set_attribute("event.source", getattr(event, "source", "unknown"))
        if hasattr(event, "content"):
            span.set_attribute("event.content_preview", str(event.content)[:100])
    metrics_data = state.get("metrics")
    if metrics_data and isinstance(metrics_data, dict):
        perception = metrics_data.get("perception")
        if perception:
            span.set_attribute("perception.intent", perception.get("intent", ""))
            span.set_attribute("perception.emotion", perception.get("emotion", ""))
            span.set_attribute("perception.priority", perception.get("reassessed_priority", ""))


def traced(name: str | None = None) -> Callable:
    """为 LangGraph 节点函数添加 OTel 追踪的装饰器。

    自动创建 OTel span，从 AgentState 提取关键属性，
    异常时记录错误状态。OTel 未配置时为 no-op。

    支持同步和异步函数。

    Args:
        name: Span 名称，默认为 "bellis.node.{func.__name__}"。

    Usage::

        @traced("agent.perceive")
        async def perceive(state: AgentState) -> dict:
            ...
    """

    def decorator(func: Callable) -> Callable:
        span_name = name or f"bellis.node.{func.__name__}"

        if asyncio.iscoroutinefunction(func):

            @functools.wraps(func)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                with _tracer.start_as_current_span(span_name) as span:
                    if args and isinstance(args[0], dict):
                        _set_state_attributes(span, args[0])
                    try:
                        result = await func(*args, **kwargs)
                        # 记录输出摘要
                        if isinstance(result, dict) and span.is_recording():
                            if "live_response" in result:
                                resp = result["live_response"]
                                if hasattr(resp, "emotion"):
                                    span.set_attribute("response.emotion", resp.emotion.value)
                            if "actions" in result:
                                span.set_attribute("action.count", len(result["actions"]))
                        return result
                    except Exception as exc:
                        if span.is_recording():
                            span.record_exception(exc)
                            span.set_status(Status(StatusCode.ERROR, str(exc)))
                        raise

            return async_wrapper
        else:

            @functools.wraps(func)
            def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
                with _tracer.start_as_current_span(span_name) as span:
                    if args and isinstance(args[0], dict):
                        _set_state_attributes(span, args[0])
                    try:
                        result = func(*args, **kwargs)
                        if isinstance(result, dict) and span.is_recording():
                            if "actions" in result:
                                span.set_attribute("action.count", len(result["actions"]))
                        return result
                    except Exception as exc:
                        if span.is_recording():
                            span.record_exception(exc)
                            span.set_status(Status(StatusCode.ERROR, str(exc)))
                        raise

            return sync_wrapper

    return decorator
