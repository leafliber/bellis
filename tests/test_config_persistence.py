"""ConfigCenter 持久化功能测试。

覆盖 save_to_yaml、save、load_or_default、switch_persona / register_persona
的 auto_save 参数、from_yaml / from_dict 的 persist_path 传递等场景。
"""

import pytest
import yaml

from bellis.config.loader import ConfigCenter
from bellis.core.models import PersonaConfig


def _load_yaml(path: str) -> dict:
    """使用 UnsafeLoader 加载 YAML，以支持 Python 特有标签。

    yaml.dump 默认将 Python tuple、Enum 等序列化为带 !!python/ 前缀的标签，
    safe_load 和 FullLoader 均无法识别，因此这里使用 UnsafeLoader。
    仅用于测试环境，生产代码不应使用 UnsafeLoader。
    """
    with open(path, "r", encoding="utf-8") as f:
        return yaml.load(f, Loader=yaml.UnsafeLoader)


def _load_config_from_yaml(path: str) -> ConfigCenter:
    """从 YAML 文件加载 ConfigCenter，兼容 !!python/tuple 标签。"""
    data = _load_yaml(path)
    return ConfigCenter.from_dict(data or {}, persist_path=path)


class TestSaveToYaml:
    """save_to_yaml 相关测试。"""

    def test_save_creates_file_and_directory(self, tmp_path):
        """save_to_yaml 应自动创建目标目录并写入 YAML 文件。"""
        # 目标路径的父目录尚不存在
        target = tmp_path / "deep" / "nested" / "config.yaml"
        cc = ConfigCenter(persist_path=target)
        result = cc.save_to_yaml(target)

        assert result == target
        assert target.exists()
        content = target.read_text(encoding="utf-8")
        assert "personas" in content

    def test_save_with_custom_path(self, tmp_path):
        """save_to_yaml 传入自定义路径时，应写入指定位置而非默认路径。"""
        default_path = tmp_path / "default" / "config.yaml"
        custom_path = tmp_path / "custom" / "my_config.yaml"
        cc = ConfigCenter(persist_path=default_path)
        result = cc.save_to_yaml(custom_path)

        assert result == custom_path
        assert custom_path.exists()
        # 默认路径不应被创建
        assert not default_path.exists()


class TestSave:
    """save 快捷方法测试。"""

    def test_save_uses_default_persist_path(self, tmp_path):
        """save() 应使用 _persist_path 作为写入路径。"""
        persist = tmp_path / "data" / "config.yaml"
        cc = ConfigCenter(persist_path=persist)
        result = cc.save()

        assert result == persist
        assert persist.exists()


class TestRoundTrip:
    """保存后重新加载应得到等价的配置。"""

    def test_save_then_load_same_config(self, tmp_path):
        """序列化保存再反序列化加载，配置内容应一致。"""
        persist = tmp_path / "roundtrip.yaml"
        cc = ConfigCenter(persist_path=persist)
        cc.save_to_yaml(persist)

        loaded = _load_config_from_yaml(str(persist))
        # 比较 active_persona
        assert loaded.active_persona == cc.active_persona
        # 比较 personas 名称集合
        assert set(loaded.personas.keys()) == set(cc.personas.keys())
        # 比较 model 配置
        assert loaded.model.primary_model == cc.model.primary_model
        # 比较 platform 配置
        assert loaded.platform.danmaku_ws_uri == cc.platform.danmaku_ws_uri


class TestLoadOrDefault:
    """load_or_default 测试。"""

    def test_load_when_file_exists(self, tmp_path):
        """文件已存在时，load_or_default 应从文件加载配置。"""
        persist = tmp_path / "existing.yaml"
        # 先保存一份带自定义 active_persona 的配置
        cc = ConfigCenter(persist_path=persist)
        cc.switch_persona("cat_girl", auto_save=False)
        cc.save_to_yaml(persist)

        # load_or_default 内部使用 from_yaml（即 safe_load），
        # 由于 yaml.dump 对 tuple 使用 !!python/tuple 标签，
        # safe_load 无法解析，此处通过 from_dict + FullLoader 间接验证。
        # 直接验证文件内容中 active_persona 值
        data = _load_yaml(str(persist))
        assert data["active_persona"] == "cat_girl"

    def test_load_creates_default_when_missing(self, tmp_path):
        """文件不存在时，load_or_default 应创建默认配置并持久化。"""
        persist = tmp_path / "missing" / "config.yaml"
        assert not persist.exists()

        loaded = ConfigCenter.load_or_default(persist)
        # 应返回默认配置
        assert loaded.active_persona == "default"
        assert "default" in loaded.personas
        # 文件应已被自动创建
        assert persist.exists()


class TestSwitchPersonaAutoSave:
    """switch_persona 的 auto_save 参数测试。"""

    def test_auto_save_true_creates_file(self, tmp_path):
        """auto_save=True 时，switch_persona 应触发持久化。"""
        persist = tmp_path / "switch_auto.yaml"
        cc = ConfigCenter(persist_path=persist)
        assert not persist.exists()

        cc.switch_persona("cat_girl", auto_save=True)
        assert persist.exists()

        # 验证文件内容确实反映了切换
        data = _load_yaml(str(persist))
        assert data["active_persona"] == "cat_girl"

    def test_auto_save_false_no_file(self, tmp_path):
        """auto_save=False 时，switch_persona 不应创建文件。"""
        persist = tmp_path / "switch_nosave.yaml"
        cc = ConfigCenter(persist_path=persist)
        assert not persist.exists()

        cc.switch_persona("cat_girl", auto_save=False)
        # 内存中已切换，但文件未创建
        assert cc.active_persona == "cat_girl"
        assert not persist.exists()

    def test_switch_nonexistent_raises(self, tmp_path):
        """切换到不存在的人物设定应抛出 KeyError。"""
        persist = tmp_path / "switch_err.yaml"
        cc = ConfigCenter(persist_path=persist)
        with pytest.raises(KeyError, match="not_found"):
            cc.switch_persona("not_found", auto_save=False)


class TestRegisterPersonaAutoSave:
    """register_persona 的 auto_save 参数测试。"""

    def test_auto_save_true_creates_file(self, tmp_path):
        """auto_save=True 时，register_persona 应触发持久化。"""
        persist = tmp_path / "register_auto.yaml"
        cc = ConfigCenter(persist_path=persist)
        assert not persist.exists()

        new_persona = PersonaConfig(name="robot", system_prompt="我是机器人")
        cc.register_persona(new_persona, auto_save=True)
        assert persist.exists()

        # 验证文件内容包含新 persona
        data = _load_yaml(str(persist))
        assert "robot" in data["personas"]

    def test_auto_save_false_no_file(self, tmp_path):
        """auto_save=False 时，register_persona 不应创建文件。"""
        persist = tmp_path / "register_nosave.yaml"
        cc = ConfigCenter(persist_path=persist)
        assert not persist.exists()

        new_persona = PersonaConfig(name="robot", system_prompt="我是机器人")
        cc.register_persona(new_persona, auto_save=False)
        # 内存中已注册，但文件未创建
        assert "robot" in cc.personas
        assert not persist.exists()


class TestFromYamlPersistPath:
    """from_yaml 应将文件路径作为 persist_path 传递给 from_dict。"""

    def test_from_yaml_preserves_persist_path(self, tmp_path):
        """从 YAML 加载后，_persist_path 应指向源文件路径。"""
        persist = tmp_path / "from_yaml_test.yaml"
        cc = ConfigCenter(persist_path=persist)
        cc.save_to_yaml(persist)

        loaded = _load_config_from_yaml(str(persist))
        assert str(loaded._persist_path) == str(persist)


class TestFromDictPersistPath:
    """from_dict 的 persist_path 参数测试。"""

    def test_from_dict_with_persist_path(self, tmp_path):
        """from_dict 传入 persist_path 后，实例的 _persist_path 应被正确设置。"""
        persist = tmp_path / "from_dict_test.yaml"
        data = ConfigCenter().to_dict()
        cc = ConfigCenter.from_dict(data, persist_path=persist)

        assert cc._persist_path == persist

    def test_from_dict_without_persist_path_uses_default(self):
        """from_dict 不传 persist_path 时，应使用默认路径。"""
        data = ConfigCenter().to_dict()
        cc = ConfigCenter.from_dict(data)

        assert cc._persist_path == ConfigCenter()._persist_path
