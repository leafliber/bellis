import os
from pathlib import Path

import pytest

from bellis.config.model import ModelConfig


def _load_dotenv() -> dict[str, str | None]:
    """从项目根目录 .env 文件加载 KEY、URL、MODEL。"""
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
    # 环境变量优先
    env["api_key"] = os.environ.get("OPENAI_API_KEY", env["api_key"])
    env["base_url"] = os.environ.get("OPENAI_BASE_URL", env["base_url"])
    env["model"] = os.environ.get("BELLIS_MODEL", env["model"])
    return env


@pytest.fixture(scope="session")
def llm_config() -> ModelConfig:
    """提供配置了 .env 中 base_url、api_key、model 的 ModelConfig。"""
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
    """提供 .env 中的 base_url、api_key、model。"""
    return _load_dotenv()
