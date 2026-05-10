from __future__ import annotations

from abc import ABC, abstractmethod

from bellis.core.models import TTSTask


class TTSExecutor(ABC):
    @abstractmethod
    async def synthesize(self, task: TTSTask) -> bytes | None: ...


class DummyTTSExecutor(TTSExecutor):
    async def synthesize(self, task: TTSTask) -> bytes | None:
        return b""
