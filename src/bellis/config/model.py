from __future__ import annotations

from pydantic import BaseModel


class ModelConfig(BaseModel):
    primary_model: str = "openai:gpt-4o"
    fallback_model: str = "openai:gpt-4o-mini"
    max_retries: int = 3
    base_delay: float = 1.0
    max_delay: float = 30.0
    temperature: float = 0.7
    base_url: str | None = None
    api_key: str | None = None
    compat_mode: bool = False
