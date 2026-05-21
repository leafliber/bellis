"""端到端感知流程和配置中心的集成测试。

验证弹幕、礼物、中断、刷屏等事件从出队到路由的完整流程，
以及 ConfigCenter 的人设管理（切换、注册、序列化）。
"""

import pytest

from bellis.agent.execution import act, handle_interrupt
from bellis.agent.perception import dequeue_event, perceive, route_after_perception
from bellis.config import ConfigCenter
from bellis.config.model import ModelConfig
from bellis.core.context import AgentContext
from bellis.core.enums import ActionType, CommandType, EmotionEnum, MotionEnum
from bellis.core.events import CommandEvent, DanmakuEvent, GiftEvent
from bellis.core.models import EmotionState, PersonaConfig, SceneContext
from bellis.core.response import LiveResponse
from bellis.core.state import AgentState


class TestEndToEndPerception:
    """端到端感知流程测试：事件出队 → 感知 → 路由决策。"""
    @pytest.mark.asyncio
    async def test_danmaku_flow(self):
        event = DanmakuEvent(content="你好主播！", user_name="粉丝A", user_level=10, fan_badge="铁粉")
        state: AgentState = {
            "event_queue": [event],
            "current_event": None,
            "scene_context": SceneContext(),
            "emotion_state": EmotionState(),
            "action_history": [],
            "persona": PersonaConfig(),
            "state_version": 0,
            "interrupt_flag": False,
            "tts_queue": [],
            "idle_ticks": 0,
            "metrics": {},
            "_context": AgentContext(),
        }
        result = dequeue_event(state)
        state.update(result)
        assert state["current_event"] == event

        result = await perceive(state)
        state.update(result)
        assert state["metrics"]["perception"]["intent"] == "greeting"
        assert state["metrics"]["perception"]["reassessed_priority"] == "NORMAL"

        route = route_after_perception(state)
        assert route == "think"

    @pytest.mark.asyncio
    async def test_gift_flow(self):
        event = GiftEvent(content="送火箭", gift_name="火箭", coin_value=2000, user_name="土豪")
        state: AgentState = {
            "event_queue": [event],
            "current_event": None,
            "scene_context": SceneContext(),
            "emotion_state": EmotionState(),
            "action_history": [],
            "persona": PersonaConfig(),
            "state_version": 0,
            "interrupt_flag": False,
            "tts_queue": [],
            "idle_ticks": 0,
            "metrics": {},
            "_context": AgentContext(),
        }
        result = dequeue_event(state)
        state.update(result)
        result = await perceive(state)
        state.update(result)
        assert state["metrics"]["perception"]["intent"] == "gift"
        assert state["metrics"]["perception"]["reassessed_priority"] == "CRITICAL"
        route = route_after_perception(state)
        assert route == "think"

    @pytest.mark.asyncio
    async def test_interrupt_flow(self):
        event = CommandEvent(content="中断", command_type="interrupt")
        state: AgentState = {
            "event_queue": [event],
            "current_event": None,
            "scene_context": SceneContext(),
            "emotion_state": EmotionState(),
            "action_history": [],
            "persona": PersonaConfig(),
            "state_version": 0,
            "interrupt_flag": True,
            "tts_queue": [],
            "idle_ticks": 0,
            "metrics": {},
            "_context": AgentContext(),
        }
        result = dequeue_event(state)
        state.update(result)
        result = await perceive(state)
        state.update(result)
        route = route_after_perception(state)
        assert route == "interrupt"

    @pytest.mark.asyncio
    async def test_spam_routed_to_end(self):
        event = DanmakuEvent(content="1", user_level=1, fan_badge=None)
        state: AgentState = {
            "event_queue": [event],
            "current_event": None,
            "scene_context": SceneContext(),
            "emotion_state": EmotionState(),
            "action_history": [],
            "persona": PersonaConfig(),
            "state_version": 0,
            "interrupt_flag": False,
            "tts_queue": [],
            "idle_ticks": 0,
            "metrics": {},
            "_context": AgentContext(),
        }
        result = dequeue_event(state)
        state.update(result)
        result = await perceive(state)
        state.update(result)
        assert state["metrics"]["perception"]["intent"] == "spam"
        route = route_after_perception(state)
        assert route == "end"


class TestConfigCenter:
    """ConfigCenter 人设管理测试：默认人设、切换、注册、序列化。"""
    def test_default_personas(self):
        config = ConfigCenter()
        assert "default" in config.personas
        assert "cat_girl" in config.personas
        assert config.active_persona == "default"

    def test_switch_persona(self):
        config = ConfigCenter()
        config.switch_persona("cat_girl")
        assert config.active_persona == "cat_girl"
        persona = config.get_active_persona()
        assert "猫娘" in persona.system_prompt

    def test_switch_invalid_persona(self):
        config = ConfigCenter()
        with pytest.raises(KeyError):
            config.switch_persona("nonexistent")

    def test_register_persona(self):
        config = ConfigCenter()
        new_persona = PersonaConfig(
            name="cool_guy",
            system_prompt="你是一个酷酷的主播。",
        )
        config.register_persona(new_persona)
        assert "cool_guy" in config.personas

    def test_to_dict_and_from_dict(self):
        config = ConfigCenter()
        data = config.to_dict()
        restored = ConfigCenter.from_dict(data)
        assert restored.active_persona == config.active_persona
        assert set(restored.personas.keys()) == set(config.personas.keys())


class TestConfigCenterPersistence:
    """ConfigCenter 持久化测试：保存到 YAML 后重新加载，验证数据一致性。"""

    def test_config_round_trip_with_yaml(self, tmp_path):
        """配置保存到 YAML 后重新加载，值应保持一致。"""
        yaml_path = tmp_path / "config.yaml"
        config = ConfigCenter(persist_path=str(yaml_path))
        config.save_to_yaml(yaml_path)

        # 从 YAML 重新加载
        restored = ConfigCenter.from_yaml(str(yaml_path))

        # 验证基本字段一致
        assert restored.active_persona == config.active_persona
        assert set(restored.personas.keys()) == set(config.personas.keys())
        # 验证模型配置一致
        assert restored.model.primary_model == config.model.primary_model
        assert restored.model.fallback_model == config.model.fallback_model
        # 验证平台配置一致
        assert restored.platform == config.platform

    def test_config_switch_persona_persists(self, tmp_path):
        """切换人设后保存再加载，active_persona 应已变更。"""
        yaml_path = tmp_path / "config.yaml"
        config = ConfigCenter(persist_path=str(yaml_path))
        # 初始为 default
        assert config.active_persona == "default"

        # 切换到 cat_girl 并保存（auto_save=True）
        config.switch_persona("cat_girl", auto_save=False)
        config.save_to_yaml(yaml_path)

        # 重新加载验证
        restored = ConfigCenter.from_yaml(str(yaml_path))
        assert restored.active_persona == "cat_girl"
        # 确认不是 default
        assert restored.active_persona != "default"

    def test_config_register_new_persona_persists(self, tmp_path):
        """注册新人设后保存再加载，新人设应存在。"""
        yaml_path = tmp_path / "config.yaml"
        config = ConfigCenter(persist_path=str(yaml_path))

        # 注册新人设
        new_persona = PersonaConfig(
            name="cool_guy",
            system_prompt="你是一个酷酷的主播。",
            tts_voice="cool",
        )
        config.register_persona(new_persona, auto_save=False)
        config.save_to_yaml(yaml_path)

        # 重新加载验证
        restored = ConfigCenter.from_yaml(str(yaml_path))
        assert "cool_guy" in restored.personas
        assert restored.personas["cool_guy"].system_prompt == "你是一个酷酷的主播。"
        assert restored.personas["cool_guy"].tts_voice == "cool"

    def test_config_model_update_persists(self, tmp_path):
        """修改模型配置后保存再加载，模型配置应已变更。"""
        yaml_path = tmp_path / "config.yaml"
        config = ConfigCenter(persist_path=str(yaml_path))

        # 修改模型配置
        config.model = ModelConfig(
            primary_model="openai:gpt-4o-mini",
            fallback_model="openai:gpt-3.5-turbo",
            max_retries=5,
            compat_mode=True,
        )
        config.save_to_yaml(yaml_path)

        # 重新加载验证
        restored = ConfigCenter.from_yaml(str(yaml_path))
        assert restored.model.primary_model == "openai:gpt-4o-mini"
        assert restored.model.fallback_model == "openai:gpt-3.5-turbo"
        assert restored.model.max_retries == 5
        assert restored.model.compat_mode is True


class TestEndToEndWithExecution:
    """端到端执行流程测试：dequeue → perceive → route → act/handle_interrupt。"""

    @pytest.mark.asyncio
    async def test_full_perceive_think_act_flow(self):
        """完整流程：dequeue_event → perceive → route → 手动调用 act，验证 Action 生成。"""
        event = DanmakuEvent(content="你好主播！", user_name="粉丝A", user_level=10, fan_badge="铁粉")
        state: AgentState = {
            "event_queue": [event],
            "current_event": None,
            "scene_context": SceneContext(),
            "emotion_state": EmotionState(),
            "action_history": [],
            "persona": PersonaConfig(),
            "state_version": 0,
            "interrupt_flag": False,
            "tts_queue": [],
            "idle_ticks": 0,
            "metrics": {},
            "_context": AgentContext(),
        }

        # 第一步：出队事件
        result = dequeue_event(state)
        state.update(result)
        assert state["current_event"] == event

        # 第二步：感知
        result = await perceive(state)
        state.update(result)
        assert state["metrics"]["perception"]["intent"] == "greeting"

        # 第三步：路由决策
        route = route_after_perception(state)
        assert route == "think"

        # 第四步：手动设置 LiveResponse 并调用 act
        live_response = LiveResponse(
            text="你好呀！欢迎来到直播间~",
            emotion=EmotionEnum.happy,
            motion=MotionEnum.wave,
            target_user="粉丝A",
        )
        state["live_response"] = live_response

        # 执行 act
        result = await act(state)
        state.update(result)

        # 验证 actions 被正确生成
        actions = state.get("actions", [])
        assert len(actions) > 0
        # 应包含 speak 动作
        speak_actions = [a for a in actions if a.type == ActionType.speak]
        assert len(speak_actions) > 0
        assert speak_actions[0].text == "你好呀！欢迎来到直播间~"
        # 应包含 set_expression 动作（因为 emotion=happy 非 neutral）
        expr_actions = [a for a in actions if a.type == ActionType.set_expression]
        assert len(expr_actions) > 0
        # 应包含 set_motion 动作（因为 motion=wave 非 idle）
        motion_actions = [a for a in actions if a.type == ActionType.set_motion]
        assert len(motion_actions) > 0
        # 应包含 reply_danmaku 动作（因为事件有 user_name）
        reply_actions = [a for a in actions if a.type == ActionType.reply_danmaku]
        assert len(reply_actions) > 0
        assert reply_actions[0].target_user == "粉丝A"

    @pytest.mark.asyncio
    async def test_interrupt_command_flow(self):
        """中断命令流程：CommandEvent(switch_persona) → dequeue → perceive → route → handle_interrupt。"""
        event = CommandEvent(
            content="切换人设",
            command_type=CommandType.SWITCH_PERSONA,
            payload={"name": "cat_girl"},
        )
        state: AgentState = {
            "event_queue": [event],
            "current_event": None,
            "scene_context": SceneContext(),
            "emotion_state": EmotionState(),
            "action_history": [],
            "persona": PersonaConfig(),
            "state_version": 0,
            "interrupt_flag": True,
            "tts_queue": [],
            "idle_ticks": 0,
            "metrics": {},
            "_context": AgentContext(),
        }

        # 第一步：出队事件
        result = dequeue_event(state)
        state.update(result)
        assert state["current_event"] == event

        # 第二步：感知
        result = await perceive(state)
        state.update(result)

        # 第三步：路由决策——中断标志 + 命令事件应路由到 interrupt
        route = route_after_perception(state)
        assert route == "interrupt"

        # 第四步：处理中断
        result = await handle_interrupt(state)
        state.update(result)

        # 验证中断处理结果
        assert state["interrupt_flag"] is False
        assert state["metrics"]["interrupt_action"] == "switch_persona:cat_girl"
        assert state["state_version"] > 0
