from __future__ import annotations

from bellis.core.response import LiveResponse
from bellis.output.pipeline import OutputMiddleware


class AuditMiddleware(OutputMiddleware):
    def __init__(self, sensitive_words: list[str] | None = None, replacement: str = "***") -> None:
        self._sensitive_words = sensitive_words or []
        self._replacement = replacement
        self._audit_log: list[dict] = []

    @property
    def audit_log(self) -> list[dict]:
        return list(self._audit_log)

    async def process(self, response: LiveResponse) -> LiveResponse | None:
        text = response.text
        replaced = False
        for word in self._sensitive_words:
            if word in text:
                text = text.replace(word, self._replacement)
                replaced = True
        if replaced:
            self._audit_log.append(
                {
                    "original_text": response.text,
                    "filtered_text": text,
                    "emotion": response.emotion.value,
                }
            )
            return response.model_copy(update={"text": text})
        return response
