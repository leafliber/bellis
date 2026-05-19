from __future__ import annotations

import asyncio
import re
import time
from typing import Any

from pydantic import BaseModel
from pydantic_ai import Agent, RunContext

from bellis.core.enums import EmotionEnum, MotionEnum
from bellis.core.models import ActionRecord, EmotionState, PersonaConfig, SceneContext, TTSTask
from bellis.core.response import LiveResponse
from bellis.core.state import AgentState
from bellis.plugins.hooks import HookManager


class LiveDeps(BaseModel):
    scene_context: SceneContext
    emotion_state: EmotionState
    persona: PersonaConfig
    action_history: list[ActionRecord]


class CircuitOpenError(Exception):
    pass


class CircuitBreaker:
    def __init__(self, failure_threshold: int = 5, recovery_timeout: float = 30.0) -> None:
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.state: str = "closed"
        self.failure_count: int = 0
        self.last_failure_time: float = 0.0

    async def call(self, fn: Any, *args: Any, **kwargs: Any) -> Any:
        if self.state == "open":
            if time.monotonic() - self.last_failure_time < self.recovery_timeout:
                raise CircuitOpenError("Circuit breaker is open")
            self.state = "half_open"
        try:
            result = await fn(*args, **kwargs)
            self.failure_count = 0
            self.state = "closed"
            return result
        except Exception:
            self.failure_count += 1
            self.last_failure_time = time.monotonic()
            if self.failure_count >= self.failure_threshold:
                self.state = "open"
            raise


class ResilientCaller:
    def __init__(
        self,
        breaker: CircuitBreaker | None = None,
        max_retries: int = 3,
        fallback_model: str | None = None,
    ) -> None:
        self.breaker = breaker or CircuitBreaker()
        self.max_retries = max_retries
        self.fallback_model = fallback_model
        self.fallback_response = LiveResponse(
            text="让我想想...",
            emotion=EmotionEnum.calm,
            motion=MotionEnum.think,
        )

    async def call_with_retry(self, agent: Agent, prompt: str, deps: LiveDeps) -> LiveResponse:
        base_delay = 1.0
        for attempt in range(self.max_retries):
            try:
                result = await self.breaker.call(agent.run, prompt, deps=deps)
                return result.get_output()
            except CircuitOpenError:
                break
            except Exception:
                if attempt < self.max_retries - 1:
                    await asyncio.sleep(base_delay * (2**attempt))
        if self.fallback_model is not None:
            try:
                result = await agent.run(prompt, deps=deps, model=self.fallback_model)
                return result.get_output()
            except Exception:
                pass
        return self.fallback_response


def create_decision_agent(
    model: str = "openai:gpt-4o",
    extra_tools: list | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
    compat_mode: bool = False,
) -> Agent:
    """创建决策 Agent。

    Args:
        compat_mode: 兼容模式，用于不支持 tool calling 的 OpenAI 兼容 API。
            使用 output_type=str + JSON prompt 代替 tool calling。
    """
    model_obj = model
    if base_url or api_key:
        from openai import AsyncOpenAI
        from pydantic_ai.models.openai import OpenAIChatModel
        from pydantic_ai.providers.openai import OpenAIProvider

        # 从 model 字符串提取模型名（如 "openai:gpt-4o" → "gpt-4o"）
        model_name = model.split(":")[-1] if ":" in model else model
        client = AsyncOpenAI(
            base_url=base_url,
            api_key=api_key,
        )
        provider = OpenAIProvider(openai_client=client)
        model_obj = OpenAIChatModel(model_name, provider=provider)

    # 兼容模式：不支持 tool calling 的 API 使用纯文本输出
    output_type = str if compat_mode else LiveResponse

    agent = Agent(
        model_obj,
        output_type=output_type,
        deps_type=LiveDeps,
    )

    @agent.system_prompt
    async def build_system_prompt(ctx: RunContext[LiveDeps]) -> str:
        deps = ctx.deps
        parts = [deps.persona.system_prompt]
        parts.append(
            f"当前场景：{deps.scene_context.stream_title or '未知'}，"
            f"话题：{deps.scene_context.topic or '无'}，"
            f"观众数：{deps.scene_context.viewer_count}"
        )
        parts.append(f"当前情绪：{deps.emotion_state.current.value}，强度：{deps.emotion_state.intensity}")
        if deps.action_history:
            recent = deps.action_history[-3:]
            actions_desc = "，".join(f"{a.description}({a.emotion.value})" for a in recent)
            parts.append(f"最近行为：{actions_desc}")
        if compat_mode:
            parts.append(
                "你必须以纯 JSON 格式回复，不要包含任何其他文字。格式如下：\n"
                '{"text": "你的回复内容", "emotion": "happy", "motion": "wave", '
                '"tts_speed": 1.0, "priority": 0, "target_user": null, '
                '"motion_duration": 1.0, "wait_for_next": false}\n'
                f"emotion 可选值：{', '.join(e.value for e in EmotionEnum)}\n"
                f"motion 可选值：{', '.join(m.value for m in MotionEnum)}"
            )
        return "\n".join(parts)

    # 兼容模式下不注册工具（API 可能不支持 tool calling）
    if not compat_mode:

        @agent.tool
        async def search_knowledge(ctx: RunContext[LiveDeps], query: str) -> str:
            return f"[RAG检索结果] 关于「{query}」的占位内容，实际实现可替换为真实检索。"

        @agent.tool
        async def query_product(ctx: RunContext[LiveDeps], name: str) -> str:
            return f"[商品查询] 「{name}」的占位信息，实际实现可替换为真实查询。"

    # 注册 ToolPlugin 提供的额外工具
    if extra_tools:
        for tool_fn in extra_tools:
            agent.tool(tool_fn)

    return agent


decision_agent: Agent | None = None
_caller = ResilientCaller()


def _get_agent(
    extra_tools: list | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
    model: str | None = None,
    compat_mode: bool = False,
) -> Agent:
    global decision_agent
    if decision_agent is None:
        decision_agent = create_decision_agent(
            model=model or "openai:gpt-4o",
            extra_tools=extra_tools,
            base_url=base_url,
            api_key=api_key,
            compat_mode=compat_mode,
        )
    return decision_agent


def reset_agent(
    extra_tools: list | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
    model: str | None = None,
    compat_mode: bool = False,
) -> Agent:
    """重建 Agent（用于工具变更时）。"""
    global decision_agent
    decision_agent = create_decision_agent(
        model=model or "openai:gpt-4o",
        extra_tools=extra_tools,
        base_url=base_url,
        api_key=api_key,
        compat_mode=compat_mode,
    )
    return decision_agent


def _build_prompt(state: AgentState) -> str:
    event = state.get("current_event")
    if event is None:
        # 空闲自言自语
        return "现在直播间比较安静，你可以主动说点什么来活跃气氛，保持简短自然。"
    parts = [f"事件内容：{event.content}"]
    if event.source:
        parts.append(f"来源：{event.source.value}")
    if event.metadata:
        meta_str = "，".join(f"{k}={v}" for k, v in event.metadata.items())
        parts.append(f"附加信息：{meta_str}")
    return "\n".join(parts)


def _build_deps(state: AgentState) -> LiveDeps:
    history = state.get("action_history", [])[-10:]
    return LiveDeps(
        scene_context=state.get("scene_context", SceneContext()),
        emotion_state=state.get("emotion_state", EmotionState()),
        persona=state.get("persona", PersonaConfig()),
        action_history=history,
    )


async def think(state: AgentState) -> dict:
    hook_mgr: HookManager | None = state.get("metrics", {}).get("_hook_manager")
    if hook_mgr:
        state = await hook_mgr.fire("pre_think", state)

    extra_tools = state.get("metrics", {}).get("_extra_tools")
    base_url = state.get("metrics", {}).get("_base_url")
    api_key = state.get("metrics", {}).get("_api_key")
    model = state.get("metrics", {}).get("_model")
    compat_mode = state.get("metrics", {}).get("_compat_mode", False)
    agent = _get_agent(extra_tools, base_url=base_url, api_key=api_key, model=model, compat_mode=compat_mode)
    deps = _build_deps(state)
    prompt = _build_prompt(state)
    raw_response = await _caller.call_with_retry(agent, prompt, deps)

    # 兼容模式下，raw_response 是 str，需要解析为 LiveResponse
    response = _parse_compat_response(raw_response) if compat_mode else raw_response

    new_emotion = EmotionState(
        current=response.emotion,
        intensity=state.get("emotion_state", EmotionState()).intensity,
    )
    new_action = ActionRecord(
        action_type="response",
        description=response.text[:50],
        emotion=response.emotion,
        motion=response.motion,
    )
    history = list(state.get("action_history", []))
    history.append(new_action)
    history = history[-10:]

    result = {
        "live_response": response,
        "emotion_state": new_emotion,
        "action_history": history,
        "state_version": state.get("state_version", 0) + 1,
        "idle_ticks": 0,
    }

    if hook_mgr:
        state = await hook_mgr.fire("post_think", {**state, **result})
        result = {k: state[k] for k in result if k in state}

    return result


def _parse_compat_response(raw: str | LiveResponse) -> LiveResponse:
    """将兼容模式下的文本响应解析为 LiveResponse。"""
    if isinstance(raw, LiveResponse):
        return raw
    try:
        import json

        data = json.loads(raw)
        return LiveResponse(
            text=data.get("text", raw),
            emotion=EmotionEnum(data.get("emotion", "neutral")),
            motion=MotionEnum(data.get("motion", "idle")),
            tts_speed=data.get("tts_speed", 1.0),
            priority=data.get("priority", 0),
            target_user=data.get("target_user"),
            motion_duration=data.get("motion_duration", 1.0),
            wait_for_next=data.get("wait_for_next", False),
        )
    except (json.JSONDecodeError, ValueError):
        return LiveResponse(text=raw, emotion=EmotionEnum.neutral, motion=MotionEnum.idle)


_SENTENCE_PATTERN = re.compile(r"(.*?[。！？!?.])")


async def stream_think(state: AgentState) -> dict:
    hook_mgr: HookManager | None = state.get("metrics", {}).get("_hook_manager")
    if hook_mgr:
        state = await hook_mgr.fire("pre_think", state)

    extra_tools = state.get("metrics", {}).get("_extra_tools")
    base_url = state.get("metrics", {}).get("_base_url")
    api_key = state.get("metrics", {}).get("_api_key")
    model = state.get("metrics", {}).get("_model")
    compat_mode = state.get("metrics", {}).get("_compat_mode", False)
    agent = _get_agent(extra_tools, base_url=base_url, api_key=api_key, model=model, compat_mode=compat_mode)
    deps = _build_deps(state)
    prompt = _build_prompt(state)
    tts_queue = list(state.get("tts_queue", []))
    buffer = ""
    final_response: LiveResponse | None = None
    try:
        async with agent.run_stream(prompt, deps=deps) as stream:
            async for text_delta in stream.stream_text(delta=True):
                buffer += text_delta
                sentences = _SENTENCE_PATTERN.findall(buffer)
                if sentences:
                    for sentence in sentences:
                        buffer = buffer.replace(sentence, "", 1)
                        tts_queue.append(
                            TTSTask(
                                text=sentence.strip(),
                                speed=1.0,
                                emotion=state.get("emotion_state", EmotionState()).current,
                            )
                        )
            final_response = await stream.get_output()
    except Exception:
        if buffer.strip():
            tts_queue.append(
                TTSTask(
                    text=buffer.strip(),
                    speed=1.0,
                    emotion=state.get("emotion_state", EmotionState()).current,
                )
            )
        final_response = await _caller.call_with_retry(agent, prompt, deps)
    if final_response is None:
        final_response = _caller.fallback_response
    new_emotion = EmotionState(
        current=final_response.emotion,
        intensity=state.get("emotion_state", EmotionState()).intensity,
    )
    new_action = ActionRecord(
        action_type="response",
        description=final_response.text[:50],
        emotion=final_response.emotion,
        motion=final_response.motion,
    )
    history = list(state.get("action_history", []))
    history.append(new_action)
    history = history[-10:]

    result = {
        "live_response": final_response,
        "emotion_state": new_emotion,
        "action_history": history,
        "state_version": state.get("state_version", 0) + 1,
        "tts_queue": tts_queue,
        "idle_ticks": 0,
    }

    if hook_mgr:
        state = await hook_mgr.fire("post_think", {**state, **result})
        result = {k: state[k] for k in result if k in state}

    return result
