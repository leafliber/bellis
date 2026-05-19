"""Bellis WebSocket 服务：用真实弹幕数据驱动主循环，推送到前端。

用法：uv run python scripts/ws_server.py
前端连接：ws://localhost:8765
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import websockets

# Monkey-patch: 修复 OpenAI 兼容 API 返回空 finish_reason 的问题
# 部分第三方 API 在 tool calling 时返回 finish_reason="" 而非 "tool_calls"
# pydantic-ai 的 OpenAIChatModel 会验证 finish_reason，空字符串会导致
# UnexpectedModelBehavior 异常。这里将空字符串映射为 "stop"。
try:
    from openai.types.chat import chat_completion

    _original_model_validate = chat_completion.ChatCompletion.model_validate

    def _patched_model_validate(obj, *args, **kwargs):
        if isinstance(obj, dict):
            choices = obj.get("choices")
            if isinstance(choices, list):
                for choice in choices:
                    if isinstance(choice, dict) and choice.get("finish_reason") == "":
                        # 如果有 tool_calls，finish_reason 应该是 "tool_calls"
                        if choice.get("tool_calls"):
                            choice["finish_reason"] = "tool_calls"
                        else:
                            choice["finish_reason"] = "stop"
        return _original_model_validate(obj, *args, **kwargs)

    chat_completion.ChatCompletion.model_validate = _patched_model_validate
    print("[Patch] OpenAI ChatCompletion.model_validate patched for empty finish_reason")
except Exception as e:
    print(f"[Patch] Warning: Could not patch OpenAI: {e}")

from bellis.config.loader import ConfigCenter
from bellis.core.enums import ActionType, EmotionEnum, EventPriority, EventSource, MotionEnum
from bellis.core.events import (
    DanmakuEvent,
    FollowEvent,
    GiftEvent,
    IdleEvent,
    LiveEvent,
    SuperChatEvent,
)
from bellis.core.models import EmotionState, PersonaConfig, SceneContext
from bellis.core.state import AgentState
from bellis.graph.decision import CircuitBreaker, ResilientCaller, reset_agent
from bellis.graph.main import build_main_graph
from bellis.plugins.base import OutputPlugin
from bellis.plugins.hooks import HookManager
from bellis.plugins.registry import PluginRegistry
from bellis.core.actions import Action


# ─── 从 .env 加载配置 ──────────────────────────────────────────────────


def _load_env() -> dict[str, str | None]:
    env_path = Path(__file__).resolve().parent.parent / ".env"
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


# ─── 真实弹幕数据集 ──────────────────────────────────────────────────


def build_real_danmaku_events() -> list[LiveEvent]:
    """模拟一个真实直播间的弹幕流。"""
    return [
        # 开场阶段
        DanmakuEvent(content="主播好！", user_name="铁粉小明", user_level=20, fan_badge="铁粉"),
        DanmakuEvent(content="来了来了", user_name="老观众阿花", user_level=15, fan_badge="粉丝"),
        DanmakuEvent(content="晚上好呀", user_name="夜猫子", user_level=8, fan_badge="铁粉"),
        # 互动阶段
        DanmakuEvent(content="主播今天穿得好好看", user_name="小甜心", user_level=12, fan_badge="铁粉"),
        DanmakuEvent(content="哈哈哈笑死我了", user_name="快乐水", user_level=6, fan_badge=None),
        GiftEvent(content="送出小心心", gift_name="小心心", gift_count=5, coin_value=100, user_name="小甜心"),
        DanmakuEvent(content="主播唱首歌吧！", user_name="音乐迷", user_level=10, fan_badge="粉丝"),
        DanmakuEvent(content="666666", user_name="路人甲", user_level=1, fan_badge=None),
        # 礼物高潮
        GiftEvent(content="送出小电视", gift_name="小电视", gift_count=1, coin_value=1245, user_name="土豪大佬"),
        DanmakuEvent(content="哇！大佬大气", user_name="铁粉小明", user_level=20, fan_badge="铁粉"),
        SuperChatEvent(content="主播加油！一直支持你！", user_name="金主爸爸", price=50),
        DanmakuEvent(content="感谢金主爸爸！", user_name="老观众阿花", user_level=15, fan_badge="粉丝"),
        # 空闲阶段
        IdleEvent(content="idle_tick"),
        IdleEvent(content="idle_tick"),
        IdleEvent(content="idle_tick"),
        IdleEvent(content="idle_tick"),
        IdleEvent(content="idle_tick"),
        # 恢复互动
        DanmakuEvent(content="主播还在吗？", user_name="夜猫子", user_level=8, fan_badge="铁粉"),
        FollowEvent(content="关注了主播", user_name="新观众小红"),
        DanmakuEvent(content="欢迎新朋友！", user_name="铁粉小明", user_level=20, fan_badge="铁粉"),
        GiftEvent(content="送出火箭", gift_name="火箭", gift_count=1, coin_value=2000, user_name="土豪大佬"),
        DanmakuEvent(content="主播能聊聊最近的新闻吗？", user_name="时事通", user_level=11, fan_badge="铁粉"),
        DanmakuEvent(content="1", user_name="刷屏党", user_level=1, fan_badge=None),
        DanmakuEvent(content="主播真棒！加油加油！", user_name="小甜心", user_level=12, fan_badge="铁粉"),
    ]


# ─── WebSocket 输出插件 ──────────────────────────────────────────────


class WSOutputPlugin(OutputPlugin):
    """将 Action 通过 WebSocket 推送到前端。"""

    def __init__(self) -> None:
        self.actions: list[Action] = []
        self._ws_clients: set = set()

    def add_client(self, ws) -> None:
        self._ws_clients.add(ws)

    def remove_client(self, ws) -> None:
        self._ws_clients.discard(ws)

    async def emit(self, action: Action) -> None:
        self.actions.append(action)
        msg = _action_to_ws_message(action)
        await self._broadcast(msg)

    async def _broadcast(self, msg: dict) -> None:
        data = json.dumps(msg, ensure_ascii=False)
        dead = set()
        for ws in self._ws_clients:
            try:
                await ws.send(data)
            except websockets.ConnectionClosed:
                dead.add(ws)
        self._ws_clients -= dead


# ─── 序列化工具 ──────────────────────────────────────────────────────


EMOTION_ICONS = {
    "happy": "😊", "excited": "🤩", "calm": "😌", "shy": "😳",
    "angry": "😠", "sad": "😢", "surprised": "😲", "neutral": "😐",
}

EMOTION_COLORS = {
    "happy": "#FFD700", "excited": "#FF6B6B", "calm": "#87CEEB", "shy": "#FFB6C1",
    "angry": "#FF4444", "sad": "#6495ED", "surprised": "#FFA500", "neutral": "#A0A0A0",
}


def _event_to_ws_message(event: LiveEvent) -> dict:
    source_map = {
        "danmaku": "danmaku", "gift": "gift", "super_chat": "danmaku",
        "follow": "system", "enter": "system", "idle": "system",
        "command": "command", "rag": "system", "system": "system",
    }
    source = source_map.get(event.source.value, "system")
    user_name = getattr(event, "user_name", "")
    return {
        "type": "event",
        "payload": {
            "display_text": event.content,
            "source": source,
            "color_tag": source,
            "user_name": user_name,
            "timestamp": event.timestamp.isoformat(),
            "priority_name": event.priority.name,
            "metadata": {},
        },
    }


def _action_to_ws_message(action: Action) -> dict:
    return {
        "type": "action",
        "payload": {
            "action_type": action.type.value,
            "text": action.text,
            "expression": action.expression,
            "motion": action.motion.value if action.motion else None,
            "target_user": action.target_user,
        },
    }


def _state_to_ws_message(state: AgentState) -> dict:
    emotion_state = state.get("emotion_state", EmotionState())
    scene = state.get("scene_context", SceneContext())
    emotion_val = emotion_state.current.value

    return {
        "type": "state",
        "payload": {
            "emotion": {
                "current": emotion_val,
                "intensity": emotion_state.intensity,
                "icon": EMOTION_ICONS.get(emotion_val, "😐"),
                "color": EMOTION_COLORS.get(emotion_val, "#A0A0A0"),
            },
            "scene": {
                "stream_title": scene.stream_title or "直播间",
                "streamer_name": scene.streamer_name or "Bellis",
                "viewer_count": scene.viewer_count,
                "topic": scene.topic or "日常闲聊",
                "phase": "streaming",
            },
            "recent_actions": [
                {
                    "action_type": a.action_type,
                    "description": a.description,
                    "emotion": a.emotion.value,
                    "motion": a.motion.value if a.motion else "idle",
                }
                for a in state.get("action_history", [])[-5:]
            ],
            "state_version": state.get("state_version", 0),
            "interrupt_flag": state.get("interrupt_flag", False),
            "event_queue_size": len(state.get("event_queue", [])),
            "tts_queue_size": len(state.get("tts_queue", [])),
        },
    }


def _response_to_ws_message(state: AgentState) -> dict | None:
    response = state.get("live_response")
    if response is None:
        return None
    return {
        "type": "response",
        "payload": {
            "text": response.text,
            "emotion": response.emotion.value,
            "motion": response.motion.value,
            "tts_speed": response.tts_speed,
            "target_user": response.target_user,
            "motion_duration": response.motion_duration,
        },
    }


# ─── 主循环 ──────────────────────────────────────────────────────────


class BellisWSServer:
    def __init__(self) -> None:
        self.env = _load_env()
        self.model_name = self.env.get("model") or "gpt-4o-mini"
        self.model_str = f"openai:{self.model_name}"
        self.ws_output = WSOutputPlugin()
        self.registry = PluginRegistry()
        self.registry.register_output(self.ws_output)
        self.graph = build_main_graph(streaming=False)
        self.state: AgentState | None = None
        self._running = False
        self._event_index = 0

        # 使用更宽容的 CircuitBreaker + 更多重试
        self.caller = ResilientCaller(
            breaker=CircuitBreaker(failure_threshold=10, recovery_timeout=15.0),
            max_retries=3,
        )

        # 替换全局 _caller，使 think/stream_think 使用自定义 caller
        from bellis.graph import decision as decision_module
        decision_module._caller = self.caller

    def _build_initial_state(self) -> AgentState:
        config = ConfigCenter()
        persona = config.get_active_persona()
        return {
            "event_queue": [],
            "current_event": None,
            "scene_context": SceneContext(stream_title="Bellis 直播间", streamer_name="Bellis", viewer_count=500),
            "emotion_state": EmotionState(),
            "action_history": [],
            "live_response": None,
            "actions": [],
            "persona": persona,
            "state_version": 0,
            "interrupt_flag": False,
            "tts_queue": [],
            "idle_ticks": 0,
            "metrics": {
                "_base_url": self.env["base_url"],
                "_api_key": self.env["api_key"],
                "_model": self.model_str,
                "_compat_mode": True,
                "_hook_manager": self.registry.hook_manager,
                "_output_plugins": self.registry.outputs,
                "_extra_tools": [],
            },
        }

    async def process_event(self, event: LiveEvent) -> None:
        """处理单个事件并推送结果到前端。"""
        if self.state is None:
            self.state = self._build_initial_state()

        # 推送原始事件
        event_msg = _event_to_ws_message(event)
        await self.ws_output._broadcast(event_msg)

        # 将事件加入队列
        event_queue = list(self.state.get("event_queue", []))
        event_queue.append(event)
        self.state["event_queue"] = event_queue
        self.state["current_event"] = None

        # 调用主循环
        t0 = time.monotonic()
        result = await self.graph.ainvoke(self.state)
        elapsed = (time.monotonic() - t0) * 1000

        # 合并结果
        old_metrics = self.state.get("metrics", {})
        self.state = dict(result) if result else self.state
        new_metrics = self.state.get("metrics", {})
        for key in ("_hook_manager", "_output_plugins", "_extra_tools", "_base_url", "_api_key", "_model", "_compat_mode"):
            if key in old_metrics and key not in new_metrics:
                new_metrics[key] = old_metrics[key]
        self.state["metrics"] = new_metrics

        # 推送状态更新
        state_msg = _state_to_ws_message(self.state)
        await self.ws_output._broadcast(state_msg)

        # 推送回复
        response_msg = _response_to_ws_message(self.state)
        if response_msg:
            await self.ws_output._broadcast(response_msg)

        # 打印日志
        response = self.state.get("live_response")
        source = event.source.value
        content = event.content[:40]
        if response:
            print(f"  [{source}] {content} → {response.text[:50]} ({elapsed:.0f}ms)")
        else:
            print(f"  [{source}] {content} → (无回复, {elapsed:.0f}ms)")

    async def run_event_loop(self) -> None:
        """逐事件处理真实弹幕数据。"""
        events = build_real_danmaku_events()
        self._running = True

        print(f"\n共 {len(events)} 个事件待处理")
        print("=" * 60)

        for i, event in enumerate(events):
            if not self._running:
                break
            self._event_index = i + 1
            print(f"\n[事件 {i + 1}/{len(events)}] {event.source.value} | {event.content[:40]}")
            await self.process_event(event)
            # 事件间间隔，模拟真实节奏
            if isinstance(event, IdleEvent):
                await asyncio.sleep(0.3)
            elif isinstance(event, GiftEvent):
                await asyncio.sleep(1.5)
            elif isinstance(event, SuperChatEvent):
                await asyncio.sleep(2.0)
            else:
                await asyncio.sleep(1.0)

        print("\n" + "=" * 60)
        print("所有事件处理完毕！")
        print(f"共生成 {len(self.ws_output.actions)} 个 Action")
        for at in ActionType:
            count = len([a for a in self.ws_output.actions if a.type == at])
            if count:
                print(f"  {at.value}: {count}")

    async def handle_client(self, websocket) -> None:
        """处理 WebSocket 客户端连接。"""
        self.ws_output.add_client(websocket)
        print(f"  客户端连接: {websocket.remote_address}")

        # 发送当前状态
        if self.state:
            state_msg = _state_to_ws_message(self.state)
            await websocket.send(json.dumps(state_msg, ensure_ascii=False))
            response_msg = _response_to_ws_message(self.state)
            if response_msg:
                await websocket.send(json.dumps(response_msg, ensure_ascii=False))

        try:
            async for message in websocket:
                # 处理客户端消息（如发送弹幕）
                try:
                    data = json.loads(message)
                    if data.get("type") == "command":
                        cmd = data.get("payload", {}).get("command", "")
                        if cmd.strip():
                            print(f"\n[用户输入] {cmd}")
                            event = DanmakuEvent(
                                content=cmd, user_name="你", user_level=10, fan_badge="铁粉"
                            )
                            await self.process_event(event)
                    elif data.get("type") == "switch_persona":
                        name = data.get("payload", {}).get("name", "default")
                        if self.state:
                            self.state["persona"] = PersonaConfig(
                                name=name,
                                system_prompt=f"你是{name}人设的直播助手，回复简短。",
                            )
                            print(f"  切换人设: {name}")
                except json.JSONDecodeError:
                    pass
        except websockets.ConnectionClosed:
            pass
        finally:
            self.ws_output.remove_client(websocket)
            print(f"  客户端断开: {websocket.remote_address}")


async def main() -> None:
    server = BellisWSServer()

    # 初始化 Agent（兼容模式：不支持 tool calling 的 API）
    reset_agent(
        model=server.model_str,
        base_url=server.env["base_url"],
        api_key=server.env["api_key"],
        compat_mode=True,
    )

    print("=" * 60)
    print("Bellis WebSocket 服务")
    print(f"模型: {server.model_str}")
    print(f"API: {server.env['base_url']}")
    print(f"WebSocket: ws://localhost:8765")
    print("=" * 60)

    # 启动 WebSocket 服务
    async with websockets.serve(server.handle_client, "localhost", 8765):
        # 同时运行事件循环
        await server.run_event_loop()
        # 事件处理完后保持服务运行，等待用户输入
        print("\n事件处理完毕，WebSocket 服务保持运行...")
        print("前端可继续连接 ws://localhost:8765 发送弹幕")
        print("按 Ctrl+C 退出")
        try:
            await asyncio.Future()  # 永久等待
        except asyncio.CancelledError:
            pass


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n服务已停止")
