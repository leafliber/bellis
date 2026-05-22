"""配置加载与管理中心。

提供 ConfigCenter 类，负责管理直播助手的全部运行时配置，
包括人物设定（Persona）、模型配置和平台配置。
支持从字典或 YAML 文件加载配置，并支持运行时切换人物设定。
配置变更可持久化到 data/ 目录下的 YAML 文件，确保重启后配置不丢失。
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

# 默认持久化目录（项目根目录下的 data/）
DEFAULT_DATA_DIR = Path("data")
DEFAULT_CONFIG_FILENAME = "config.yaml"


def _persona_to_safe_dict(persona: PersonaConfig) -> dict:
    """将 PersonaConfig 转为 yaml.safe_load 兼容的字典。

    枚举值转为字符串、元组转为列表，确保序列化后可被 yaml.safe_load 反序列化。

    Args:
        persona: 人物设定实例。

    Returns:
        安全的字典表示。
    """
    data = persona.model_dump()
    # emotion_map / motion_map 的值从枚举转为字符串
    for key in ("emotion_map", "motion_map"):
        raw_map = data.get(key, {})
        if isinstance(raw_map, dict):
            data[key] = {k: v.value if isinstance(v, EmotionEnum | MotionEnum) else str(v) for k, v in raw_map.items()}
    # tts_speed_range 从元组转为列表
    if "tts_speed_range" in data and isinstance(data["tts_speed_range"], tuple):
        data["tts_speed_range"] = list(data["tts_speed_range"])
    return data


class ConfigCenter:
    """配置中心，统一管理人物设定、模型、平台和插件配置。

    Attributes:
        personas: 所有人物设定的映射表，键为 persona 名称。
        model: LLM 模型相关配置。
        platform: 平台连接与运行参数配置。
        plugins: 插件专属配置映射表，键为插件名称，值为配置字典。
        active_persona: 当前激活的人物设定名称。
    """

    def __init__(
        self,
        personas: dict[str, PersonaConfig] | None = None,
        model: ModelConfig | None = None,
        platform: PlatformConfig | None = None,
        plugins: dict[str, dict] | None = None,
        active_persona: str = "default",
        persist_path: str | Path | None = None,
    ) -> None:
        """初始化配置中心。

        Args:
            personas: 人物设定映射表，为 None 时使用默认设定。
            model: 模型配置，为 None 时使用默认 ModelConfig。
            platform: 平台配置，为 None 时使用默认 PlatformConfig。
            plugins: 插件专属配置映射表，键为插件名称，值为配置字典。
                为 None 时使用空字典。每个插件的配置字典结构由插件自行定义。
            active_persona: 初始激活的人物设定名称，默认为 "default"。
            persist_path: 持久化文件路径，为 None 时使用 data/config.yaml。
                传入路径后，save() 和 save_to_yaml() 默认写入此路径。
        """
        self.personas: dict[str, PersonaConfig] = personas if personas is not None else self._default_personas()
        self.model: ModelConfig = model if model is not None else ModelConfig()
        self.platform: PlatformConfig = platform if platform is not None else PlatformConfig()
        self.plugins: dict[str, dict] = plugins if plugins is not None else {}
        self.active_persona: str = active_persona
        self._persist_path: Path = Path(persist_path) if persist_path else DEFAULT_DATA_DIR / DEFAULT_CONFIG_FILENAME

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

    def switch_persona(self, name: str, auto_save: bool = True) -> None:
        """切换当前激活的人物设定。

        Args:
            name: 要激活的人物设定名称。
            auto_save: 是否自动持久化到默认路径，默认为 True。

        Raises:
            KeyError: 指定名称的人物设定不存在。
        """
        if name not in self.personas:
            raise KeyError(f"Persona '{name}' not found. Available: {list(self.personas.keys())}")
        self.active_persona = name
        if auto_save:
            self.save()

    def register_persona(self, persona: PersonaConfig, auto_save: bool = True) -> None:
        """注册新的人物设定。

        Args:
            persona: 要注册的人物设定实例。
            auto_save: 是否自动持久化到默认路径，默认为 True。
        """
        self.personas[persona.name] = persona
        if auto_save:
            self.save()

    def update_config(self, updates: dict, auto_save: bool = True) -> None:
        """从前端接收局部配置更新并应用。

        支持局部更新：只传需要修改的字段，未传的字段保持不变。
        对于 dict 类型字段（personas、plugins），采用合并策略而非替换。

        Args:
            updates: 需要更新的配置字段，可包含：
                - personas: dict[str, dict]，合并到现有 personas
                - active_persona: str，切换激活的 persona
                - model: dict，合并到现有 model 配置
                - platform: dict，合并到现有 platform 配置
                - plugins: dict[str, dict]，合并到现有 plugins 配置
            auto_save: 是否自动持久化到默认路径，默认为 True。
        """
        # 更新 personas（合并策略）
        if "personas" in updates and updates["personas"] is not None:
            for name, p_data in updates["personas"].items():
                if isinstance(p_data, dict):
                    # tts_speed_range 从列表还原为元组
                    if "tts_speed_range" in p_data and isinstance(p_data["tts_speed_range"], list):
                        p_data["tts_speed_range"] = tuple(p_data["tts_speed_range"])
                    if name in self.personas:
                        # 合并：用新值覆盖已有字段
                        existing = self.personas[name].model_dump()
                        existing.update(p_data)
                        self.personas[name] = PersonaConfig(**existing)
                    else:
                        self.personas[name] = PersonaConfig(**p_data)

        # 切换 active_persona
        if "active_persona" in updates and updates["active_persona"] is not None:
            self.active_persona = updates["active_persona"]

        # 更新 model（合并策略）
        if "model" in updates and updates["model"] is not None:
            existing = self.model.model_dump()
            existing.update(updates["model"])
            self.model = ModelConfig(**existing)

        # 更新 platform（合并策略）
        if "platform" in updates and updates["platform"] is not None:
            existing = self.platform.model_dump()
            existing.update(updates["platform"])
            self.platform = PlatformConfig(**existing)

        # 更新 plugins（合并策略）
        if "plugins" in updates and updates["plugins"] is not None:
            self.plugins.update(updates["plugins"])

        if auto_save:
            self.save()

    def to_dict(self) -> dict:
        """将配置中心序列化为字典。

        所有枚举值转为字符串、元组转为列表，确保输出可被 yaml.safe_load 安全反序列化。

        Returns:
            包含 personas、model、platform、plugins 和 active_persona 的字典。
        """
        return {
            "personas": {name: _persona_to_safe_dict(persona) for name, persona in self.personas.items()},
            "model": self.model.model_dump(),
            "platform": self.platform.model_dump(),
            "plugins": self.plugins,
            "active_persona": self.active_persona,
        }

    @classmethod
    def from_dict(cls, data: dict, persist_path: str | Path | None = None) -> ConfigCenter:
        """从字典反序列化创建 ConfigCenter 实例。

        自动将 tts_speed_range 从列表还原为元组，以匹配 PersonaConfig 的类型定义。

        Args:
            data: 包含配置信息的字典，键应包括 personas、model、platform、plugins、active_persona。
            persist_path: 持久化文件路径，为 None 时使用默认 data/config.yaml。

        Returns:
            重建的 ConfigCenter 实例。
        """
        personas_data = data.get("personas", {})
        personas = {}
        for name, p_data in personas_data.items():
            # YAML 反序列化后 tts_speed_range 为列表，需转回元组
            if "tts_speed_range" in p_data and isinstance(p_data["tts_speed_range"], list):
                p_data["tts_speed_range"] = tuple(p_data["tts_speed_range"])
            personas[name] = PersonaConfig(**p_data)
        model = ModelConfig(**data.get("model", {}))
        platform = PlatformConfig(**data.get("platform", {}))
        plugins = data.get("plugins", {})
        active_persona = data.get("active_persona", "default")
        return cls(
            personas=personas,
            model=model,
            platform=platform,
            plugins=plugins,
            active_persona=active_persona,
            persist_path=persist_path,
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
        return cls.from_dict(data or {}, persist_path=path)

    def save_to_yaml(self, path: str | Path | None = None) -> Path:
        """将当前配置序列化并写入 YAML 文件。

        自动创建目标目录。若未指定路径，则使用初始化时
        设置的 persist_path（默认 data/config.yaml）。

        Args:
            path: 目标文件路径，为 None 时使用 self._persist_path。

        Returns:
            实际写入的文件路径。
        """
        target = Path(path) if path is not None else self._persist_path
        target.parent.mkdir(parents=True, exist_ok=True)
        data = self.to_dict()
        with target.open("w", encoding="utf-8") as f:
            yaml.dump(data, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
        logger.info("配置已保存到: %s", target)
        return target

    def save(self) -> Path:
        """快捷保存：将配置写入默认持久化路径。

        等价于 save_to_yaml() 不传参数，使用初始化时设置的 persist_path。

        Returns:
            实际写入的文件路径。
        """
        return self.save_to_yaml()

    @classmethod
    def load_or_default(cls, persist_path: str | Path | None = None) -> ConfigCenter:
        """尝试从持久化路径加载配置，文件不存在时返回默认配置。

        此方法适合应用启动时调用：若 data/config.yaml 存在则加载，
        否则使用内置默认值并立即持久化一份。

        Args:
            persist_path: 持久化文件路径，为 None 时使用 data/config.yaml。

        Returns:
            加载或默认创建的 ConfigCenter 实例。
        """
        target = Path(persist_path) if persist_path else DEFAULT_DATA_DIR / DEFAULT_CONFIG_FILENAME
        if target.exists():
            return cls.from_yaml(str(target))
        config = cls(persist_path=target)
        config.save_to_yaml(target)
        return config
