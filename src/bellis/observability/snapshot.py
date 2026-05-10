from __future__ import annotations

import copy
import json
from datetime import datetime

from bellis.core.state import AgentState


class SnapshotExporter:
    def __init__(self) -> None:
        self._snapshots: list[dict] = []

    def take_snapshot(self, state: AgentState) -> dict:
        snapshot = copy.deepcopy(dict(state))
        snapshot["_snapshot_time"] = datetime.now().isoformat()
        self._snapshots.append(snapshot)
        return snapshot

    def get_snapshots(self) -> list[dict]:
        return list(self._snapshots)

    def export_json(self) -> str:
        return json.dumps(self._snapshots, default=str, ensure_ascii=False, indent=2)

    def clear(self) -> None:
        self._snapshots.clear()
