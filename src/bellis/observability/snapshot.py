"""状态快照模块 — 提供 AgentState 的快照采集、存储与导出能力。

本模块用于在主循环运行过程中定期或按需采集 AgentState 的深拷贝快照，
支持快照数量上限管理和 JSON 格式导出，便于调试与可观测性分析。
"""

from __future__ import annotations

import copy
import json
import logging
from datetime import datetime

from bellis.core.state import AgentState

logger = logging.getLogger(__name__)

# 默认最大快照保留数量
MAX_SNAPSHOTS = 100


class SnapshotExporter:
    """AgentState 快照采集与导出器。

    负责采集 AgentState 的深拷贝快照，附加时间戳后存储在内存中，
    并提供快照查询与 JSON 导出功能。当快照数量超过上限时，
    自动淘汰最旧的快照。

    Attributes:
        _snapshots: 已采集的快照列表，每个快照为包含 ``_snapshot_time`` 字段的字典。
        _max_snapshots: 最大快照保留数量。
    """

    def __init__(self, max_snapshots: int = MAX_SNAPSHOTS) -> None:
        self._snapshots: list[dict] = []
        self._max_snapshots = max_snapshots

    def take_snapshot(self, state: AgentState) -> dict:
        """采集当前 AgentState 的快照。

        尝试对 state 进行深拷贝以避免后续修改影响快照数据；
        若深拷贝失败（如包含不可序列化的对象），则降级为浅拷贝。

        Args:
            state: 当前 Agent 状态。

        Returns:
            包含 ``_snapshot_time`` 时间戳字段的快照字典。
        """
        try:
            snapshot = copy.deepcopy(dict(state))
        except Exception:
            # 深拷贝失败时降级为浅拷贝，避免因不可序列化对象导致快照采集中断
            logger.warning("无法 deep copy state，使用浅拷贝", exc_info=True)
            snapshot = dict(state)
        snapshot["_snapshot_time"] = datetime.now().isoformat()
        self._snapshots.append(snapshot)
        # 超过上限时淘汰最旧的
        if len(self._snapshots) > self._max_snapshots:
            self._snapshots = self._snapshots[-self._max_snapshots:]
        return snapshot

    def get_snapshots(self) -> list[dict]:
        """返回所有已采集快照的浅拷贝列表。

        Returns:
            快照字典列表。
        """
        return list(self._snapshots)

    def export_json(self) -> str:
        """将所有快照导出为 JSON 字符串。

        使用 ``default=str`` 处理不可序列化的类型，
        ``ensure_ascii=False`` 保留中文等非 ASCII 字符。

        Returns:
            格式化的 JSON 字符串。
        """
        return json.dumps(self._snapshots, default=str, ensure_ascii=False, indent=2)

    def clear(self) -> None:
        """清空所有已采集的快照。"""
        self._snapshots.clear()
