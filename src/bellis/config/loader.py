from __future__ import annotations

import logging
from pathlib import Path

import yaml

from bellis.config.model import ModelConfig
from bellis.config.platform import PlatformConfig
from bellis.core.enums import EmotionEnum, MotionEnum
from bellis.core.models import PersonaConfig

logger = logging.getLogger(__name__)


class ConfigCenter:
    def __init__(
        self,
        personas: dict[str, PersonaConfig] | None = None,
        model: ModelConfig | None = None,
        platform: PlatformConfig | None = None,
        active_persona: str = "default",
    ) -> None:
        self.personas: dict[str, PersonaConfig] = personas if personas is not None else self._default_personas()
        self.model: ModelConfig = model if model is not None else ModelConfig()
        self.platform: PlatformConfig = platform if platform is not None else PlatformConfig()
        self.active_persona: str = active_persona

    @staticmethod
    def _default_personas() -> dict[str, PersonaConfig]:
        default_persona = PersonaConfig(
            name="default",
            system_prompt="你是一个友好的直播助手，正在与观众互动。",
            emotion_map={},
            motion_map={},
            tts_voice="default",
            tts_speed_range=(0.8, 1.5),
        )
        cat_girl_persona = PersonaConfig(
            name="cat_girl",
            system_prompt="你是一个可爱的猫娘主播，说话会带'喵~'，性格活泼可爱。",
            emotion_map={"开心": EmotionEnum.happy, "害羞": EmotionEnum.shy},
            motion_map={"打招呼": MotionEnum.wave, "思考": MotionEnum.think},
            tts_voice="cute",
            tts_speed_range=(0.9, 1.3),
        )
        return {
            default_persona.name: default_persona,
            cat_girl_persona.name: cat_girl_persona,
        }

    def get_active_persona(self) -> PersonaConfig:
        if self.active_persona not in self.personas:
            logger.warning("Persona '%s' 不存在，回退到默认", self.active_persona)
            # 回退到第一个可用的 persona
            if self.personas:
                fallback = next(iter(self.personas))
                self.active_persona = fallback
            else:
                # 无任何 persona 时返回默认
                default = PersonaConfig(name="default", system_prompt="你是一个友好的直播助手。")
                self.personas["default"] = default
                self.active_persona = "default"
        return self.personas[self.active_persona]

    def switch_persona(self, name: str) -> None:
        if name not in self.personas:
            raise KeyError(f"Persona '{name}' not found. Available: {list(self.personas.keys())}")
        self.active_persona = name

    def register_persona(self, persona: PersonaConfig) -> None:
        self.personas[persona.name] = persona

    def to_dict(self) -> dict:
        return {
            "personas": {name: persona.model_dump() for name, persona in self.personas.items()},
            "model": self.model.model_dump(),
            "platform": self.platform.model_dump(),
            "active_persona": self.active_persona,
        }

    @classmethod
    def from_dict(cls, data: dict) -> ConfigCenter:
        personas_data = data.get("personas", {})
        personas = {name: PersonaConfig(**p_data) for name, p_data in personas_data.items()}
        model = ModelConfig(**data.get("model", {}))
        platform = PlatformConfig(**data.get("platform", {}))
        active_persona = data.get("active_persona", "default")
        return cls(
            personas=personas,
            model=model,
            platform=platform,
            active_persona=active_persona,
        )

    @classmethod
    def from_yaml(cls, path: str) -> ConfigCenter:
        file_path = Path(path)
        logger.info("从 YAML 加载配置: %s", path)
        with file_path.open("r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
        return cls.from_dict(data or {})
