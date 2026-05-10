from __future__ import annotations

from bellis.core.enums import EventPriority
from bellis.core.response import LiveResponse
from bellis.output.pipeline import OutputMiddleware


class ThrottleMiddleware(OutputMiddleware):
    def __init__(self, queue_limit: int = 20) -> None:
        self._queue_limit = queue_limit
        self._pending_count = 0

    def set_pending_count(self, count: int) -> None:
        self._pending_count = count

    async def process(self, response: LiveResponse) -> LiveResponse | None:
        if self._pending_count >= self._queue_limit:
            if response.priority <= EventPriority.NORMAL.value:
                return None
        return response
