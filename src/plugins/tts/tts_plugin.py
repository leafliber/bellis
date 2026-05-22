"""TTS 插件主类 — 根据 provider 配置分发到不同 TTS 驱动。

支持三种驱动：
- dummy: 占位驱动，不产生实际语音（默认）
- edge: Edge-TTS 在线服务
- api: 通用 HTTP API（兼容 OpenAI TTS / 本地 VITS 部署）
"""

from __future__ import annotations

import logging

from bellis.core.actions import Action
from bellis.core.enums import ActionType, EmotionEnum
from bellis.core.models import TTSTask
from bellis.plugin.base import OutputPlugin, PluginCategory, PluginMeta
from bellis.runtime.executors import TTSExecutor

from .api_tts import ApiTTSDriver
from .dummy_tts import _DummyTTSDriver
from .edge_tts import EdgeTTSDriver

logger = logging.getLogger(__name__)

# provider 名称 → 驱动工厂函数
_DRIVER_FACTORIES: dict[str, type[TTSExecutor]] = {
    "dummy": _DummyTTSDriver,
    "edge": EdgeTTSDriver,
    "api": ApiTTSDriver,
}


class TTSPlugin(OutputPlugin):
    """TTS 输出插件，根据配置分发到不同 TTS 驱动。

    通过 config_schema 声明可配置项，前端 PluginPanel 会自动渲染
    结构化表单。provider 字段使用 enum 类型，前端渲染为下拉选择框。

    Attributes:
        _driver: 当前使用的 TTS 驱动实例。
    """

    plugin_meta = PluginMeta(
        name="tts_plugin",
        version="0.1.0",
        description="TTS 语音合成插件，支持 Edge-TTS / HTTP API / 占位驱动",
        category=PluginCategory.OUTPUT,
        tags=("tts",),
    )

    config_schema = {
        "provider": {
            "type": "enum",
            "label": "TTS 服务商",
            "default": "dummy",
            "description": "选择 TTS 驱动后端",
            "options": ["dummy", "edge", "api"],
        },
        "voice": {
            "type": "str",
            "label": "音色",
            "default": "zh-CN-XiaoxiaoNeural",
            "description": "Edge-TTS 音色名 或 API 音色 ID",
        },
        "api_endpoint": {
            "type": "str",
            "label": "API 地址",
            "default": "http://localhost:9880/tts",
            "description": "api 模式的 HTTP 端点（兼容 VITS/OpenAI 等）",
        },
        "api_key": {
            "type": "str",
            "label": "API Key",
            "default": "",
            "description": "API 认证密钥（本地部署可留空）",
        },
        "api_format": {
            "type": "enum",
            "label": "API 格式",
            "default": "openai",
            "description": "HTTP API 请求格式",
            "options": ["openai", "vits"],
        },
        "sample_rate": {
            "type": "int",
            "label": "采样率",
            "default": 24000,
            "description": "输出音频采样率",
        },
    }

    def __init__(self) -> None:
        super().__init__()
        self._driver: TTSExecutor = _DummyTTSDriver()

    @property
    def driver(self) -> TTSExecutor:
        """暴露底层驱动器，供 TimelineSync 等组件直接使用。"""
        return self._driver

    def _build_driver(self) -> TTSExecutor:
        """根据当前配置构建对应的 TTS 驱动实例。

        Returns:
            TTSExecutor 实例。
        """
        provider = self._config.get("provider", "dummy")
        driver_cls = _DRIVER_FACTORIES.get(provider)
        if driver_cls is None:
            logger.warning("未知的 TTS provider: %r，回退到 dummy", provider)
            driver_cls = _DummyTTSDriver

        # 根据驱动类型传递不同参数
        if driver_cls is _DummyTTSDriver:
            return _DummyTTSDriver()
        elif driver_cls is EdgeTTSDriver:
            return EdgeTTSDriver(
                voice=self._config.get("voice", "zh-CN-XiaoxiaoNeural"),
            )
        elif driver_cls is ApiTTSDriver:
            return ApiTTSDriver(
                endpoint=self._config.get("api_endpoint", "http://localhost:9880/tts"),
                api_key=self._config.get("api_key", ""),
                voice=self._config.get("voice", "default"),
                api_format=self._config.get("api_format", "openai"),
            )
        return _DummyTTSDriver()

    async def _on_start(self) -> None:
        """启动时根据配置构建驱动实例。"""
        self._driver = self._build_driver()
        provider = self._config.get("provider", "dummy")
        logger.info("TTS 插件启动，provider=%s, driver=%s", provider, type(self._driver).__name__)

    def set_config(self, cfg: dict) -> None:
        """注入配置，若 provider 变更则重建驱动。

        Args:
            cfg: 插件配置字典。
        """
        old_provider = self._config.get("provider", "dummy")
        super().set_config(cfg)
        new_provider = self._config.get("provider", "dummy")

        # provider 变更时重建驱动（仅当插件已运行时）
        if old_provider != new_provider and self.state.value == "running":
            self._driver = self._build_driver()
            logger.info("TTS provider 变更: %s → %s，已重建驱动", old_provider, new_provider)

    async def emit(self, action: Action) -> None:
        """根据 Action 类型执行 TTS 合成。

        仅处理 speak 类型动作，将文本、语速、情绪等参数构造为
        TTSTask 后交由驱动器合成。

        Args:
            action: 待执行的动作对象。
        """
        if action.type == ActionType.speak and action.text:
            task = TTSTask(
                text=action.text,
                speed=action.tts_speed,
                emotion=action.emotion or EmotionEnum.neutral,
                target_user=action.target_user,
                priority=action.priority,
            )
            await self._driver.synthesize(task)
