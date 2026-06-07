"""Bellis 后端启动入口 — python -m bellis。"""

from __future__ import annotations

import asyncio
import logging
import os


def _patch_openai_finish_reason() -> None:
    """Monkey-patch: 修复 OpenAI 兼容 API 返回空 finish_reason 的问题。"""
    try:
        from openai.types.chat import chat_completion

        _original_model_validate = chat_completion.ChatCompletion.model_validate

        def _patched_model_validate(obj, *args, **kwargs):
            if isinstance(obj, dict):
                choices = obj.get("choices")
                if isinstance(choices, list):
                    for choice in choices:
                        if isinstance(choice, dict) and choice.get("finish_reason") == "":
                            choice["finish_reason"] = "tool_calls" if choice.get("tool_calls") else "stop"
            return _original_model_validate(obj, *args, **kwargs)

        chat_completion.ChatCompletion.model_validate = _patched_model_validate
        print("[Patch] OpenAI ChatCompletion.model_validate patched for empty finish_reason")
    except Exception as e:
        print(f"[Patch] Warning: Could not patch OpenAI: {e}")


def main() -> None:
    """入口函数。"""
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    _patch_openai_finish_reason()

    from bellis.app import BellisApp

    app = BellisApp.create(enable_gateway=True)

    print("=" * 60)
    print("  Bellis 后端服务")
    print(f"  模型: {app.config.model.primary_model}")
    print(f"  API: {app.config.model.base_url or '(default)'}")
    print(f"  Gateway: ws://localhost:8765")
    print(f"  已注册插件: {[p.name for p in app.registry.get_all_plugins()]}")
    print("=" * 60)

    try:
        asyncio.run(app.start())
    except KeyboardInterrupt:
        print("\n服务已停止")


if __name__ == "__main__":
    main()
