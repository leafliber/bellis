"""LLM 模型配置定义。

定义 ModelConfig 数据模型，包含主模型、回退模型、
重试策略及 API 连接等参数。
"""

from __future__ import annotations

from pydantic import BaseModel


class ModelConfig(BaseModel):
    """LLM 模型配置。

    Attributes:
        primary_model: 主模型标识，格式为 "provider:model_name"。
        fallback_model: 主模型不可用时的回退模型标识。
        max_retries: 最大重试次数。
        base_delay: 重试基础延迟（秒），用于指数退避计算。
        max_delay: 重试最大延迟（秒）。
        base_url: 自定义 API 基础地址，为 None 时使用默认地址。
        api_key: API 密钥，为 None 时从环境变量读取。
        compat_mode: 是否启用兼容模式（用于非标准 OpenAI API）。
    """

    primary_model: str = "openai:gpt-4o"
    fallback_model: str = "openai:gpt-4o-mini"
    max_retries: int = 3
    base_delay: float = 1.0
    max_delay: float = 30.0
    base_url: str | None = None
    api_key: str | None = None
    compat_mode: bool = False
