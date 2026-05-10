from __future__ import annotations

from bellis import PersonaConfig
from bellis.config.loader import ConfigCenter
from bellis_gui.adapters.base import BaseAdapter
from bellis_gui.adapters.models import GUIConfig, GUIModelConfig, GUIPersonaConfig, GUIPlatformConfig


class ConfigAdapter(BaseAdapter[GUIConfig]):
    def __init__(self, config_center: ConfigCenter, maxsize: int = 50) -> None:
        super().__init__(maxsize=maxsize)
        self._config_center = config_center

    @property
    def config_center(self) -> ConfigCenter:
        return self._config_center

    def snapshot(self) -> GUIConfig:
        cc = self._config_center
        personas = {}
        for name, persona in cc.personas.items():
            personas[name] = GUIPersonaConfig(
                name=persona.name,
                system_prompt=persona.system_prompt,
                tts_voice=persona.tts_voice,
            )
        model = GUIModelConfig(
            primary_model=cc.model.primary_model,
            fallback_model=cc.model.fallback_model,
            max_retries=cc.model.max_retries,
            temperature=cc.model.temperature,
        )
        platform = GUIPlatformConfig(
            danmaku_ws_uri=cc.platform.danmaku_ws_uri,
            command_ws_uri=cc.platform.command_ws_uri,
            max_queue_size=cc.platform.max_queue_size,
            danmaku_qps_limit=cc.platform.danmaku_qps_limit,
            tts_queue_limit=cc.platform.tts_queue_limit,
        )
        return GUIConfig(
            personas=personas,
            active_persona=cc.active_persona,
            model=model,
            platform=platform,
        )

    def switch_persona(self, name: str) -> None:
        self._config_center.switch_persona(name)
        self._push(self.snapshot())

    def register_persona(self, persona: GUIPersonaConfig) -> None:
        p = PersonaConfig(
            name=persona.name,
            system_prompt=persona.system_prompt,
            tts_voice=persona.tts_voice,
        )
        self._config_center.register_persona(p)
        self._push(self.snapshot())

    def update_model_config(self, **kwargs) -> None:
        for key, value in kwargs.items():
            if hasattr(self._config_center.model, key):
                setattr(self._config_center.model, key, value)
        self._push(self.snapshot())

    def update_platform_config(self, **kwargs) -> None:
        for key, value in kwargs.items():
            if hasattr(self._config_center.platform, key):
                setattr(self._config_center.platform, key, value)
        self._push(self.snapshot())

    def reload_from_yaml(self, path: str) -> None:
        new_center = ConfigCenter.from_yaml(path)
        self._config_center.personas = new_center.personas
        self._config_center.model = new_center.model
        self._config_center.platform = new_center.platform
        self._config_center.active_persona = new_center.active_persona
        self._push(self.snapshot())

    async def _run(self) -> None:
        self._push(self.snapshot())
        import asyncio
        while self._running:
            await asyncio.sleep(5.0)
