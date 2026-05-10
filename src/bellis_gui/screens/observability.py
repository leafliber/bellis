from __future__ import annotations

from textual.app import ComposeResult
from textual.containers import Vertical
from textual.screen import Screen
from textual.widgets import Button, Static, TabbedContent, TabPane

from bellis_gui.adapters.models import GUIMetrics


class TracePanel(Vertical):
    DEFAULT_CSS = """
    TracePanel {
        padding: 1;
        height: auto;
    }
    """

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._traces: list[dict] = []

    def compose(self) -> ComposeResult:
        yield Static("追踪记录", id="trace-title")
        yield Static("暂无追踪数据", id="trace-content")

    def load_traces(self, traces: list[dict]) -> None:
        self._traces = traces
        content = self.query_one("#trace-content", Static)
        if not traces:
            content.update("暂无追踪数据")
            return
        lines = []
        for trace in traces[-10:]:
            name = trace.get("name", "unknown")
            duration = trace.get("duration_ms", 0)
            lines.append(f"• {name} ({duration:.1f}ms)")
            children = trace.get("children", [])
            for child in children[:5]:
                child_name = child.get("name", "?")
                child_dur = child.get("duration_ms", 0)
                lines.append(f"  └─ {child_name} ({child_dur:.1f}ms)")
        content.update("\n".join(lines))


class MetricsPanel(Vertical):
    DEFAULT_CSS = """
    MetricsPanel {
        padding: 1;
        height: auto;
    }
    """

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._metrics: GUIMetrics | None = None

    def compose(self) -> ComposeResult:
        yield Static("运行指标", id="metrics-title")
        yield Static("等待数据...", id="metrics-content")

    def update_metrics(self, metrics: GUIMetrics) -> None:
        self._metrics = metrics
        content = self.query_one("#metrics-content", Static)
        lines = [
            f"📦 事件队列: {metrics.event_queue_size}",
            f"🔊 TTS 队列: {metrics.tts_queue_size}",
            f"⚡ 熔断器: {metrics.circuit_breaker_state}",
            f"🔄 状态版本: {metrics.state_version}",
            f"📊 事件速率: {metrics.events_per_minute:.1f}/min",
        ]
        content.update("\n".join(lines))


class SnapshotPanel(Vertical):
    DEFAULT_CSS = """
    SnapshotPanel {
        padding: 1;
        height: auto;
    }
    """

    def __init__(self, snapshot_exporter=None, **kwargs) -> None:
        super().__init__(**kwargs)
        self._snapshot_exporter = snapshot_exporter

    def compose(self) -> ComposeResult:
        yield Button("📸 拍摄快照", id="btn-take-snapshot", variant="primary")
        yield Static("快照列表", id="snapshot-title")
        yield Static("暂无快照", id="snapshot-content")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-take-snapshot" and self._snapshot_exporter is not None:
            self._snapshot_exporter.take_snapshot({})
            self._refresh()

    def _refresh(self) -> None:
        if self._snapshot_exporter is None:
            return
        snapshots = self._snapshot_exporter.get_snapshots()
        content = self.query_one("#snapshot-content", Static)
        if not snapshots:
            content.update("暂无快照")
            return
        lines = []
        for i, snap in enumerate(snapshots[-10:]):
            time = snap.get("_snapshot_time", "unknown")
            version = snap.get("state_version", "?")
            lines.append(f"#{i + 1} v{version} @ {time}")
        content.update("\n".join(lines))


class ObservabilityScreen(Screen):
    DEFAULT_CSS = """
    ObservabilityScreen {
        layout: vertical;
    }
    """

    def __init__(
        self,
        tracer=None,
        snapshot_exporter=None,
        **kwargs,
    ) -> None:
        super().__init__(**kwargs)
        self._tracer = tracer
        self._snapshot_exporter = snapshot_exporter

    def compose(self) -> ComposeResult:
        with TabbedContent():
            with TabPane("Traces"):
                yield TracePanel(id="trace-panel")
            with TabPane("Metrics"):
                yield MetricsPanel(id="metrics-panel")
            with TabPane("Snapshots"):
                yield SnapshotPanel(self._snapshot_exporter, id="snapshot-panel")

    def on_mount(self) -> None:
        self._refresh_traces()
        self.set_interval(2.0, self._refresh_traces)

    def _refresh_traces(self) -> None:
        if self._tracer is not None:
            traces = self._tracer.get_traces()
            self.query_one("#trace-panel", TracePanel).load_traces(traces)

    def update_metrics(self, metrics: GUIMetrics) -> None:
        try:
            self.query_one("#metrics-panel", MetricsPanel).update_metrics(metrics)
        except Exception:
            pass
