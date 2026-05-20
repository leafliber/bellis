from __future__ import annotations

import copy
import json
import logging
from datetime import datetime

from bellis.core.state import AgentState

logger = logging.getLogger(__name__)

MAX_SNAPSHOTS = 100


class SnapshotExporter:
    def __init__(self, max_snapshots: int = MAX_SNAPSHOTS) -> None:
        self._snapshots: list[dict] = []
        self._max_snapshots = max_snapshots

    def take_snapshot(self, state: AgentState) -> dict:
        try:
            snapshot = copy.deepcopy(dict(state))
        except Exception:
            logger.warning("无法 deep copy state，使用浅拷贝")
            snapshot = dict(state)
        snapshot["_snapshot_time"] = datetime.now().isoformat()
        self._snapshots.append(snapshot)
        # 超过上限时淘汰最旧的
        if len(self._snapshots) > self._max_snapshots:
            self._snapshots = self._snapshots[-self._max_snapshots:]
        return snapshot

    def get_snapshots(self) -> list[dict]:
        return list(self._snapshots)

    def export_json(self) -> str:
        return json.dumps(self._snapshots, default=str, ensure_ascii=False, indent=2)

    def clear(self) -> None:
        self._snapshots.clear()
