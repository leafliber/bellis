"""Mock 数据本地测试脚本：验证新的主循环逻辑（PERCEIVE → THINK → ACT 循环 + 空闲自言自语 + Hook + Action 分发）。

用法：uv run python scripts/test_mock_loop.py
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from unittest.mock import MagicMock

from bellis.agent import decision as decision_module
from bellis.agent.graph import build_main_graph
from bellis.config.loader import ConfigCenter
from bellis.core.actions import Action
from bellis.core.context import AgentContext
from bellis.core.enums import ActionType, EmotionEnum, MotionEnum
from bellis.core.events import (
    CommandEvent,
    DanmakuEvent,
    FollowEvent,
    GiftEvent,
    IdleEvent,
    LiveEvent,
    SuperChatEvent,
)
from bellis.core.models import EmotionState, SceneContext
from bellis.core.response import LiveResponse
from bellis.core.state import AgentState
from bellis.plugin.base import HookPlugin, InputPlugin, OutputPlugin, PluginCategory, PluginMeta
from bellis.plugin.hooks import HookManager
from bellis.plugin.registry import PluginRegistry

# ─── Mock LLM 回复映射 ──────────────────────────────────────────────────

MOCK_RESPONSES: list[tuple[str, LiveResponse]] = [
    ("你好", LiveResponse(text="你好呀！欢迎来到直播间~", emotion=EmotionEnum.happy, motion=MotionEnum.wave)),
    ("送", LiveResponse(text="哇！谢谢你的礼物，太感谢啦！", emotion=EmotionEnum.excited, motion=MotionEnum.cheer)),
    ("醒目", LiveResponse(text="感谢醒目留言！你太给力了！", emotion=EmotionEnum.excited, motion=MotionEnum.bow)),
    ("关注", LiveResponse(text="感谢关注！新朋友你好呀~", emotion=EmotionEnum.happy, motion=MotionEnum.wave)),
    ("切换", LiveResponse(text="好的，收到指令！", emotion=EmotionEnum.calm, motion=MotionEnum.nod)),
    ("安静", LiveResponse(
        text="嗯...直播间好安静呀，大家都在忙什么呢？",
        emotion=EmotionEnum.calm, motion=MotionEnum.think,
    )),
    ("还在", LiveResponse(text="在的在的！我一直在呢~", emotion=EmotionEnum.happy, motion=MotionEnum.wave)),
]

DEFAULT_RESPONSE = LiveResponse(text="收到！让我想想怎么回复~", emotion=EmotionEnum.neutral, motion=MotionEnum.nod)


def _mock_response_for_prompt(prompt: str) -> LiveResponse:
    for keyword, response in MOCK_RESPONSES:
        if keyword in prompt:
            return response
    return DEFAULT_RESPONSE


# ─── Mock 输入插件 ──────────────────────────────────────────────────────

class MockInputPlugin(InputPlugin):
    plugin_meta = PluginMeta(name="mock_input", category=PluginCategory.INPUT)

    def __init__(self, events: list[LiveEvent]) -> None:
        self._events = events
        self._running = False

    async def start(self) -> None:
        self._running = True

    async def stop(self) -> None:
        self._running = False

    async def listen(self) -> AsyncIterator[LiveEvent]:
        for event in self._events:
            if not self._running:
                break
            yield event


# ─── Mock 输出插件 ──────────────────────────────────────────────────────

class MockOutputPlugin(OutputPlugin):
    plugin_meta = PluginMeta(name="mock_output", category=PluginCategory.OUTPUT)

    def __init__(self, name: str = "mock") -> None:
        self.name = name
        self.actions: list[Action] = []

    async def emit(self, action: Action) -> None:
        self.actions.append(action)

    def get_actions_by_type(self, action_type: ActionType) -> list[Action]:
        return [a for a in self.actions if a.type == action_type]


# ─── Mock Hook 插件 ─────────────────────────────────────────────────────

class MockHookPlugin(HookPlugin):
    plugin_meta = PluginMeta(name="mock_hook", category=PluginCategory.HOOK)

    def __init__(self) -> None:
        self.calls: list[str] = []

    def register_hooks(self, hook_mgr: HookManager) -> None:
        async def on_post_think(state: AgentState) -> AgentState:
            self.calls.append("post_think")
            return state

        async def on_pre_act(state: AgentState) -> AgentState:
            self.calls.append("pre_act")
            return state

        async def on_post_act(state: AgentState) -> AgentState:
            self.calls.append("post_act")
            return state

        hook_mgr.register("post_think", on_post_think)
        hook_mgr.register("pre_act", on_pre_act)
        hook_mgr.register("post_act", on_post_act)


# ─── 构造 Mock 事件序列 ─────────────────────────────────────────────────

def build_mock_events() -> list[LiveEvent]:
    return [
        DanmakuEvent(content="你好主播！", user_name="粉丝小明", user_level=10, fan_badge="铁粉"),
        GiftEvent(content="送出小电视", user_name="土豪大佬", gift_name="小电视", gift_count=1, coin_value=1245),
        SuperChatEvent(content="主播加油！醒目留言支持一下", user_name="金主爸爸", price=50),
        FollowEvent(content="关注了主播", user_name="新观众小红"),
        DanmakuEvent(content="1", user_name="路人甲", user_level=1, fan_badge=None),
        CommandEvent(content="切换人设", command_type="switch_persona", payload={"name": "cat_girl"}),
        # 5 个 idle tick 触发空闲自言自语
        IdleEvent(content="idle_tick"),
        IdleEvent(content="idle_tick"),
        IdleEvent(content="idle_tick"),
        IdleEvent(content="idle_tick"),
        IdleEvent(content="idle_tick"),
        # 循环回到 perceive 后的新弹幕
        DanmakuEvent(content="主播还在吗？", user_name="粉丝小明", user_level=10, fan_badge="铁粉"),
    ]


# ─── 安装 Mock ──────────────────────────────────────────────────────────

def install_mock_agent() -> None:
    """Mock 掉 PydanticAI Agent，避免需要真实 API Key。"""
    fake_agent = MagicMock()

    async def mock_call_with_retry(agent, prompt, deps):
        return _mock_response_for_prompt(prompt)

    decision_module._caller.call_with_retry = mock_call_with_retry
    decision_module._get_agent = lambda extra_tools=None: fake_agent
    decision_module.decision_agent = fake_agent


# ─── 主测试逻辑 ─────────────────────────────────────────────────────────

async def run_mock_test() -> None:
    print("=" * 60)
    print("Bellis 主循环 Mock 测试")
    print("=" * 60)

    # 安装 mock
    install_mock_agent()

    # 1. 构建插件注册表
    registry = PluginRegistry()
    mock_output = MockOutputPlugin(name="recorder")
    mock_hook = MockHookPlugin()
    registry.register_output(mock_output)
    registry.register_hook(mock_hook)

    # 2. 构建图
    graph = build_main_graph(streaming=False)

    # 3. 构建初始 state
    config = ConfigCenter()
    state: AgentState = {
        "event_queue": [],
        "current_event": None,
        "scene_context": SceneContext(stream_title="测试直播间", streamer_name="Bellis", viewer_count=100),
        "emotion_state": EmotionState(),
        "action_history": [],
        "live_response": None,
        "actions": [],
        "persona": config.get_active_persona(),
        "state_version": 0,
        "interrupt_flag": False,
        "tts_queue": [],
        "idle_ticks": 0,
        "metrics": {},
        "_context": AgentContext(
            hook_manager=registry.hook_manager,
            output_plugins=registry.outputs,
            extra_tools=[],
        ),
    }

    # 4. 逐事件送入主循环
    mock_events = build_mock_events()

    print(f"\n共 {len(mock_events)} 个 mock 事件待处理\n")
    print("-" * 60)

    for i, event in enumerate(mock_events):
        print(f"\n[事件 {i + 1}] {event.source.value} | priority={event.priority.name} | {event.content[:40]}")

        # 将事件加入队列
        event_queue = list(state.get("event_queue", []))
        event_queue.append(event)
        state["event_queue"] = event_queue
        state["current_event"] = None
        # 不重置 idle_ticks，让空闲检测能正确累加

        # 调用图
        result = await graph.ainvoke(state)

        # 合并结果
        old_context = state.get("_context")
        state = dict(result) if result else state
        if "_context" not in state and old_context is not None:
            state["_context"] = old_context

        # 打印本轮结果
        response = state.get("live_response")
        if response:
            print(f"  → 回复: {response.text}")
            print(f"  → 情绪: {response.emotion.value} | 动作: {response.motion.value}")

        actions = state.get("actions", [])
        if actions:
            for a in actions:
                parts = [f"  → Action: {a.type.value}"]
                if a.text:
                    parts.append(f'text="{a.text[:30]}"')
                if a.expression:
                    parts.append(f"expr={a.expression}")
                if a.motion:
                    parts.append(f"motion={a.motion.value}")
                if a.target_user:
                    parts.append(f"@{a.target_user}")
                print(" ".join(parts))

        idle = state.get("idle_ticks", 0)
        if idle > 0:
            print(f"  → idle_ticks={idle}")

        version = state.get("state_version", 0)
        print(f"  → state_version={version}")

    # 5. 打印汇总
    print("\n" + "=" * 60)
    print("测试结果汇总")
    print("=" * 60)

    print(f"\nMockOutputPlugin 收到 {len(mock_output.actions)} 个 Action:")
    for a in mock_output.actions:
        detail = ""
        if a.text:
            detail = f' text="{a.text[:30]}"'
        if a.expression:
            detail += f" expr={a.expression}"
        if a.motion:
            detail += f" motion={a.motion.value}"
        if a.target_user:
            detail += f" @{a.target_user}"
        print(f"  [{a.type.value}]{detail}")

    print("\n按类型统计:")
    for at in ActionType:
        count = len(mock_output.get_actions_by_type(at))
        if count:
            print(f"  {at.value}: {count}")

    print(f"\nMockHookPlugin 调用记录: {mock_hook.calls}")
    print(f"Hook 调用总次数: {len(mock_hook.calls)}")

    print("\n最终 state:")
    print(f"  state_version: {state.get('state_version', 0)}")
    print(f"  idle_ticks: {state.get('idle_ticks', 0)}")
    print(f"  action_history: {len(state.get('action_history', []))} 条")
    print(f"  emotion: {state.get('emotion_state', EmotionState()).current.value}")
    print(f"  event_queue 剩余: {len(state.get('event_queue', []))}")

    # 6. 验证关键行为
    print("\n" + "=" * 60)
    print("关键行为验证")
    print("=" * 60)

    checks = []

    # 检查1: speak action 有生成
    speak_actions = mock_output.get_actions_by_type(ActionType.speak)
    checks.append(("speak Action 生成", len(speak_actions) > 0))

    # 检查2: set_expression action 有生成
    expr_actions = mock_output.get_actions_by_type(ActionType.set_expression)
    checks.append(("set_expression Action 生成", len(expr_actions) > 0))

    # 检查3: set_motion action 有生成
    motion_actions = mock_output.get_actions_by_type(ActionType.set_motion)
    checks.append(("set_motion Action 生成", len(motion_actions) > 0))

    # 检查4: reply_danmaku action 有生成
    reply_actions = mock_output.get_actions_by_type(ActionType.reply_danmaku)
    checks.append(("reply_danmaku Action 生成", len(reply_actions) > 0))

    # 检查5: Hook 被调用
    checks.append(("Hook 被调用", len(mock_hook.calls) > 0))

    # 检查6: action_history 有记录
    checks.append(("action_history 非空", len(state.get("action_history", [])) > 0))

    # 检查7: state_version 递增
    checks.append(("state_version 递增", state.get("state_version", 0) > 0))

    all_pass = True
    for name, passed in checks:
        status = "PASS" if passed else "FAIL"
        if not passed:
            all_pass = False
        print(f"  [{status}] {name}")

    print(f"\n{'所有检查通过！' if all_pass else '部分检查失败！'}")
    print("\n测试完成！")


if __name__ == "__main__":
    asyncio.run(run_mock_test())
