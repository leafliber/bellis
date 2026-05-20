"""配置加载与管理中心。

提供 ConfigCenter 类，负责管理直播助手的全部运行时配置，
包括人物设定（Persona）、模型配置和平台配置。
支持从字典或 YAML 文件加载配置，并支持运行时切换人物设定。
"""

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
    """配置中心，统一管理人物设定、模型和平台配置。

    Attributes:
        personas: 所有人物设定的映射表，键为 persona 名称。
        model: LLM 模型相关配置。
        platform: 平台连接与运行参数配置。
        active_persona: 当前激活的人物设定名称。
    """

    def __init__(
        self,
        personas: dict[str, PersonaConfig] | None = None,
        model: ModelConfig | None = None,
        platform: PlatformConfig | None = None,
        active_persona: str = "default",
    ) -> None:
        """初始化配置中心。

        Args:
            personas: 人物设定映射表，为 None 时使用默认设定。
            model: 模型配置，为 None 时使用默认 ModelConfig。
            platform: 平台配置，为 None 时使用默认 PlatformConfig。
            active_persona: 初始激活的人物设定名称，默认为 "default"。
        """
        self.personas: dict[str, PersonaConfig] = personas if personas is not None else self._default_personas()
        self.model: ModelConfig = model if model is not None else ModelConfig()
        self.platform: PlatformConfig = platform if platform is not None else PlatformConfig()
        self.active_persona: str = active_persona

    @staticmethod
    def _default_personas() -> dict[str, PersonaConfig]:
        """生成默认的人物设定集合。

        Returns:
            包含 "default"（通用助手）和 "cat_girl"（猫娘主播）两个预设的映射表。
        """
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
        """获取当前激活的人物设定。

        若 active_persona 对应的设定不存在，会自动回退到第一个可用设定；
        若无任何设定，则创建并返回一个默认设定。

        Returns:
            当前激活的 PersonaConfig 实例。
        """
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
        """切换当前激活的人物设定。

        Args:
            name: 要激活的人物设定名称。

        Raises:
            KeyError: 指定名称的人物设定不存在。
        """
        if name not in self.personas:
            raise KeyError(f"Persona '{name}' not found. Available: {list(self.personas.keys())}")
        self.active_persona = name

    def register_persona(self, persona: PersonaConfig) -> None:
        self.personas[persona.name] = persona

    def to_dict(self) -> dict:
        """将配置中心序列化为字典。

        Returns:
            包含 personas、model、platform 和 active_persona 的字典。
        """
        return {
            "personas": {name: persona.model_dump() for name, persona in self.personas.items()},
            "model": self.model.model_dump(),
            "platform": self.platform.model_dump(),
            "active_persona": self.active_persona,
        }

    @classmethod
    def from_dict(cls, data: dict) -> ConfigCenter:
        """从字典反序列化创建 ConfigCenter 实例。

        Args:
            data: 包含配置信息的字典，键应包括 personas、model、platform、active_persona。

        Returns:
            重建的 ConfigCenter 实例。
        """
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
        """从 YAML 文件加载配置并创建 ConfigCenter 实例。

        Args:
            path: YAML 文件的路径。

        Returns:
            从文件内容构建的 ConfigCenter 实例。
        """
        file_path = Path(path)
        logger.info("从 YAML 加载配置: %s", path)
        with file_path.open("r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
        return cls.from_dict(data or {})
