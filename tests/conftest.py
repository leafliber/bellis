"""Pytest 全局配置和共享 fixture。

从项目根目录 .env 文件加载 LLM 配置（api_key、base_url、model），
环境变量优先级高于 .env 文件。
"""

import os
from pathlib import Path

import pytest

from bellis.config.model import ModelConfig


def _load_dotenv() -> dict[str, str | None]:
    """从项目根目录 .env 文件加载 KEY、URL、MODEL。

    解析 .env 文件中的 KEY=VALUE 行，同时检查环境变量覆盖。
    环境变量优先级：OPENAI_API_KEY > .env 中的 KEY，
    OPENAI_BASE_URL > .env 中的 URL，BELLIS_MODEL > .env 中的 MODEL。

    Returns:
        包含 api_key、base_url、model 三个键的字典，值可能为 None。
    """
    env_path = Path(__file__).resolve().parent.parent / ".env"
    env: dict[str, str | None] = {"api_key": None, "base_url": None, "model": None}
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip()
                if key.upper() == "KEY":
                    env["api_key"] = value
                elif key.upper() == "URL":
                    env["base_url"] = value
                elif key.upper() == "MODEL":
                    env["model"] = value
    # 环境变量优先于 .env 文件
    env["api_key"] = os.environ.get("OPENAI_API_KEY", env["api_key"])
    env["base_url"] = os.environ.get("OPENAI_BASE_URL", env["base_url"])
    env["model"] = os.environ.get("BELLIS_MODEL", env["model"])
    return env


@pytest.fixture(scope="session")
def llm_config() -> ModelConfig:
    """提供配置了 .env 中 base_url、api_key、model 的 ModelConfig。

    Returns:
        配置完成的 ModelConfig 实例，model 默认使用 gpt-4o-mini。
    """
    env = _load_dotenv()
    model = env.get("model") or "gpt-4o-mini"
    return ModelConfig(
        primary_model=f"openai:{model}",
        fallback_model=f"openai:{model}",
        base_url=env["base_url"],
        api_key=env["api_key"],
    )


@pytest.fixture(scope="session")
def llm_env() -> dict[str, str | None]:
    """提供 .env 中的 base_url、api_key、model。

    Returns:
        包含 api_key、base_url、model 的字典。
    """
    return _load_dotenv()
