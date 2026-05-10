from __future__ import annotations

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor


class Telemetry:
    def __init__(self, service_name: str = "bellis") -> None:
        self._resource = Resource.create({"service.name": service_name})
        self._provider = TracerProvider(resource=self._resource)
        self._tracer = trace.get_tracer(service_name)
        self._enabled = False

    def enable(self) -> None:
        trace.set_tracer_provider(self._provider)
        self._enabled = True

    def add_processor(self, processor: SimpleSpanProcessor) -> None:
        self._provider.add_span_processor(processor)

    @property
    def tracer(self) -> trace.Tracer:
        return self._tracer

    @property
    def enabled(self) -> bool:
        return self._enabled
