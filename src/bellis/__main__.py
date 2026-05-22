"""Bellis 后端启动入口 — python -m bellis。

组装 ConfigCenter、PluginRegistry、BellisApp 并启动主循环。
支持从 .env 文件加载 LLM 配置，启用 Gateway 供前端连接。
"""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path

# 确保 Windows 终端使用 UTF-8
os.environ.setdefault("PYTHONIOENCODING", "utf-8")

from bellis.app import BellisApp
from bellis.config.loader import ConfigCenter
from bellis.plugin.registry import PluginRegistry
from plugins.tts import TTSPlugin

logger = logging.getLogger(__name__)


def _load_env() -> dict[str, str | None]:
    """从项目根目录 .env 文件加载 LLM 配置。

    Returns:
        包含 api_key、base_url、model 三个键的字典，值可能为 None。
    """
    env_path = Path(__file__).resolve().parent.parent.parent / ".env"
    env: dict[str, str | None] = {"api_key": None, "base_url": None, "model": None}
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                key, value = line.split("=", 1)
                key = key.strip().upper()
                value = value.strip()
                if key == "KEY":
                    env["api_key"] = value
                elif key == "URL":
                    env["base_url"] = value
                elif key == "MODEL":
                    env["model"] = value
    return env


def _patch_openai_finish_reason() -> None:
    """Monkey-patch: 修复 OpenAI 兼容 API 返回空 finish_reason 的问题。

    部分第三方 API 在 tool calling 时返回 finish_reason="" 而非 "tool_calls"，
    pydantic-ai 的 OpenAIChatModel 会验证 finish_reason，空字符串会导致
    UnexpectedModelBehavior 异常。这里将空字符串映射为 "stop"。
    """
    try:
        from openai.types.chat import chat_completion

        _original_model_validate = chat_completion.ChatCompletion.model_validate

        def _patched_model_validate(obj, *args, **kwargs):
            if isinstance(obj, dict):
                choices = obj.get("choices")
                if isinstance(choices, list):
                    for choice in choices:
                        if isinstance(choice, dict) and choice.get("finish_reason") == "":
                            if choice.get("tool_calls"):
                                choice["finish_reason"] = "tool_calls"
                            else:
                                choice["finish_reason"] = "stop"
            return _original_model_validate(obj, *args, **kwargs)

        chat_completion.ChatCompletion.model_validate = _patched_model_validate
        print("[Patch] OpenAI ChatCompletion.model_validate patched for empty finish_reason")
    except Exception as e:
        print(f"[Patch] Warning: Could not patch OpenAI: {e}")


def _build_config(env: dict[str, str | None]) -> ConfigCenter:
    """根据 .env 配置构建 ConfigCenter。

    Args:
        env: 从 .env 加载的配置字典。

    Returns:
        配置好的 ConfigCenter 实例。
    """
    config = ConfigCenter.load_or_default()

    # 如果 .env 中有模型配置，覆盖 ConfigCenter 的默认值
    if env["api_key"] or env["base_url"] or env["model"]:
        model_updates = {}
        if env["api_key"]:
            model_updates["api_key"] = env["api_key"]
        if env["base_url"]:
            model_updates["base_url"] = env["base_url"]
        if env["model"]:
            model_updates["primary_model"] = env["model"]
        config.update_config({"model": model_updates}, auto_save=False)

    return config


def _build_registry() -> PluginRegistry:
    """构建插件注册表，注册所有内置插件。

    Returns:
        已注册插件的 PluginRegistry 实例。
    """
    registry = PluginRegistry()
    registry.register_output(TTSPlugin())
    return registry


async def run() -> None:
    """启动 Bellis 后端服务。"""
    env = _load_env()
    _patch_openai_finish_reason()

    config = _build_config(env)
    registry = _build_registry()

    app = BellisApp(
        config=config,
        registry=registry,
        enable_gateway=True,
        gateway_host="localhost",
        gateway_port=8765,
    )

    model_name = config.model.primary_model
    print("=" * 60)
    print("  Bellis 后端服务")
    print(f"  模型: {model_name}")
    print(f"  API: {config.model.base_url or '(default)'}")
    print(f"  Gateway: ws://localhost:8765")
    print(f"  已注册插件: {[p.name for p in registry.get_all_plugins()]}")
    print("=" * 60)

    await app.start()


def main() -> None:
    """入口函数。"""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        print("\n服务已停止")


if __name__ == "__main__":
    main()
