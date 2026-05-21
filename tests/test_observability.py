"""可观测性模块的单元测试。

验证 Tracer 的 span 上下文管理、嵌套关系、异常记录、
追踪导出与淘汰策略，以及 SnapshotExporter 的快照采集、
深拷贝降级、JSON 导出与淘汰策略。
"""

import copy
import json
import time

import pytest

from bellis.core.state import AgentState
from bellis.observability.snapshot import SnapshotExporter
from bellis.observability.tracing import Tracer


# ---------------------------------------------------------------------------
# Tracer 测试
# ---------------------------------------------------------------------------


class TestTracer:
    """Tracer 核心功能测试。"""

    def test_span_records_trace_with_name_and_duration(self):
        """span 上下文管理器应记录名称和耗时。"""
        tracer = Tracer()
        with tracer.span("test_op"):
            time.sleep(0.01)  # 短暂等待以确保耗时 > 0

        traces = tracer.get_traces()
        assert len(traces) == 1
        trace = traces[0]
        assert trace["name"] == "test_op"
        # 耗时应为正数（毫秒）
        assert trace["duration_ms"] > 0
        assert trace["start_time"] > 0
        assert trace["end_time"] >= trace["start_time"]

    def test_nested_spans_create_parent_child_relationship(self):
        """嵌套 span 应建立父子关系。"""
        tracer = Tracer()
        with tracer.span("parent"):
            with tracer.span("child_1"):
                pass
            with tracer.span("child_2"):
                pass

        traces = tracer.get_traces()
        assert len(traces) == 1
        parent = traces[0]
        assert parent["name"] == "parent"
        assert len(parent["children"]) == 2
        assert parent["children"][0]["name"] == "child_1"
        assert parent["children"][1]["name"] == "child_2"
        # 子 span 不应出现在顶层追踪列表
        assert all(c["children"] == [] for c in parent["children"])

    def test_span_records_error_in_metadata_on_exception(self):
        """span 内发生异常时，metadata 中应记录错误信息。"""
        tracer = Tracer()
        with pytest.raises(ValueError, match="boom"):
            with tracer.span("failing_op"):
                raise ValueError("boom")

        traces = tracer.get_traces()
        assert len(traces) == 1
        assert "error" in traces[0]["metadata"]
        assert "ValueError" in traces[0]["metadata"]["error"]
        assert "boom" in traces[0]["metadata"]["error"]

    def test_get_traces_returns_list_of_dicts(self):
        """get_traces 应返回字典列表。"""
        tracer = Tracer()
        with tracer.span("op_a"):
            pass
        with tracer.span("op_b"):
            pass

        traces = tracer.get_traces()
        assert isinstance(traces, list)
        assert len(traces) == 2
        assert all(isinstance(t, dict) for t in traces)
        assert traces[0]["name"] == "op_a"
        assert traces[1]["name"] == "op_b"

    def test_clear_removes_all_traces(self):
        """clear 应清空所有追踪记录并重置活跃 span。"""
        tracer = Tracer()
        with tracer.span("op"):
            pass
        assert len(tracer.get_traces()) == 1

        tracer.clear()
        assert tracer.get_traces() == []
        # 清空后应能正常使用
        with tracer.span("after_clear"):
            pass
        assert len(tracer.get_traces()) == 1

    def test_max_traces_limit_evicts_oldest(self):
        """超过 max_traces 上限时应淘汰最旧的追踪记录。"""
        tracer = Tracer(max_traces=3)
        for i in range(5):
            with tracer.span(f"op_{i}"):
                pass

        traces = tracer.get_traces()
        assert len(traces) == 3
        # 应保留最新的 3 条（op_2, op_3, op_4）
        assert traces[0]["name"] == "op_2"
        assert traces[1]["name"] == "op_3"
        assert traces[2]["name"] == "op_4"


# ---------------------------------------------------------------------------
# SnapshotExporter 测试
# ---------------------------------------------------------------------------


class TestSnapshotExporter:
    """SnapshotExporter 核心功能测试。"""

    @staticmethod
    def _make_state(**overrides) -> AgentState:
        """构造测试用的 AgentState 字典。"""
        state: AgentState = {"state_version": 1, "idle_ticks": 0}
        state.update(overrides)
        return state

    def test_take_snapshot_creates_deep_copy_with_snapshot_time(self):
        """take_snapshot 应创建深拷贝并附加 _snapshot_time 字段。"""
        exporter = SnapshotExporter()
        original = self._make_state(metrics={"count": 42})

        snapshot = exporter.take_snapshot(original)

        # 快照应包含 _snapshot_time
        assert "_snapshot_time" in snapshot
        # 深拷贝：修改原始 state 不影响快照
        original["metrics"]["count"] = 999
        assert snapshot["metrics"]["count"] == 42

    def test_get_snapshots_returns_list_of_snapshots(self):
        """get_snapshots 应返回已采集快照的列表。"""
        exporter = SnapshotExporter()
        state = self._make_state()

        exporter.take_snapshot(state)
        exporter.take_snapshot(state)

        snapshots = exporter.get_snapshots()
        assert isinstance(snapshots, list)
        assert len(snapshots) == 2
        assert all("_snapshot_time" in s for s in snapshots)

    def test_export_json_produces_valid_json_string(self):
        """export_json 应生成合法的 JSON 字符串。"""
        exporter = SnapshotExporter()
        state = self._make_state(metrics={"key": "值"})

        exporter.take_snapshot(state)
        result = exporter.export_json()

        # 应为合法 JSON
        parsed = json.loads(result)
        assert isinstance(parsed, list)
        assert len(parsed) == 1
        # ensure_ascii=False 应保留中文
        assert "值" in result

    def test_clear_removes_all_snapshots(self):
        """clear 应清空所有快照。"""
        exporter = SnapshotExporter()
        state = self._make_state()

        exporter.take_snapshot(state)
        exporter.take_snapshot(state)
        assert len(exporter.get_snapshots()) == 2

        exporter.clear()
        assert exporter.get_snapshots() == []

    def test_max_snapshots_limit_evicts_oldest(self):
        """超过 max_snapshots 上限时应淘汰最旧的快照。"""
        exporter = SnapshotExporter(max_snapshots=2)
        state = self._make_state()

        for i in range(4):
            state["state_version"] = i
            exporter.take_snapshot(state)

        snapshots = exporter.get_snapshots()
        assert len(snapshots) == 2
        # 应保留最新的两条（version 2, 3）
        assert snapshots[0]["state_version"] == 2
        assert snapshots[1]["state_version"] == 3

    def test_take_snapshot_falls_back_to_shallow_copy_on_non_serializable(self):
        """当 state 包含不可深拷贝的对象时，应降级为浅拷贝。"""
        exporter = SnapshotExporter()

        # 构造一个 deepcopy 会失败的对象（例如带不可 pickle 的锁）
        class UnDeepCopyable:
            def __init__(self):
                import threading
                self.lock = threading.Lock()

        state = self._make_state()
        state["_context"] = UnDeepCopyable()

        # 不应抛异常
        snapshot = exporter.take_snapshot(state)
        assert "_snapshot_time" in snapshot
        # 浅拷贝降级后，_context 应存在（引用同一对象）
        assert "_context" in snapshot
