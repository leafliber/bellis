from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from typing import Any

from pydantic import BaseModel
from pydantic_ai import Agent, RunContext

from bellis.core.context import AgentContext
from bellis.core.enums import EmotionEnum, MotionEnum
from bellis.core.models import ActionRecord, EmotionState, PersonaConfig, SceneContext, TTSTask
from bellis.core.response import LiveResponse
from bellis.core.state import AgentState, get_context

logger = logging.getLogger(__name__)


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
                logger.warning("Circuit breaker opened after %d failures", self.failure_count)
            raise


class ResilientCaller:
    def __init__(
        self,
        breaker: CircuitBreaker | None = None,
        max_retries: int = 3,
        base_delay: float = 1.0,
        max_delay: float = 30.0,
        fallback_model: str | None = None,
    ) -> None:
        self.breaker = breaker or CircuitBreaker()
        self.max_retries = max_retries
        self.base_delay = base_delay
        self.max_delay = max_delay
        self.fallback_model = fallback_model
        self.fallback_response = LiveResponse(
            text="让我想想...",
            emotion=EmotionEnum.calm,
            motion=MotionEnum.think,
        )

    async def call_with_retry(self, agent: Agent, prompt: str, deps: LiveDeps) -> LiveResponse | str:
        for attempt in range(self.max_retries):
            try:
                result = await self.breaker.call(agent.run, prompt, deps=deps)
                return _extract_output(result)
            except CircuitOpenError:
                break
            except Exception as exc:
                logger.warning("Agent call attempt %d failed: %s", attempt + 1, exc)
                if attempt < self.max_retries - 1:
                    await asyncio.sleep(min(self.base_delay * (2**attempt), self.max_delay))
        if self.fallback_model is not None:
            try:
                result = await agent.run(prompt, deps=deps, model=self.fallback_model)
                return _extract_output(result)
            except Exception as exc:
                logger.warning("Fallback model call failed: %s", exc)
        return self.fallback_response


def _extract_output(result) -> LiveResponse | str:
    if hasattr(result, "get_output"):
        return result.get_output()
    return result.output


def create_decision_agent(
    model: str = "openai:gpt-4o",
    extra_tools: list | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
    compat_mode: bool = False,
) -> Agent:
    """创建决策 Agent。

    工具注册策略：不再内置占位工具，所有工具通过 ToolPlugin 的 extra_tools 注入。
    这保证了每个工具都是真实可用的实现。

    Args:
        compat_mode: 兼容模式，用于不支持 tool calling 的 OpenAI 兼容 API。
    """
    model_obj = model
    if base_url or api_key:
        from openai import AsyncOpenAI
        from pydantic_ai.models.openai import OpenAIChatModel
        from pydantic_ai.providers.openai import OpenAIProvider

        model_name = model.split(":")[-1] if ":" in model else model
        client = AsyncOpenAI(
            base_url=base_url,
            api_key=api_key,
        )
        provider = OpenAIProvider(openai_client=client)
        model_obj = OpenAIChatModel(model_name, provider=provider)

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

    # 所有工具通过 ToolPlugin 注入，不内置占位工具
    if extra_tools:
        for tool_fn in extra_tools:
            agent.tool(tool_fn)

    return agent


decision_agent: Agent | None = None


def _get_caller(ctx: AgentContext) -> ResilientCaller:
    """根据 AgentContext 中的配置创建或复用 ResilientCaller。"""
    return ResilientCaller(
        max_retries=3,
        base_delay=1.0,
        max_delay=30.0,
        fallback_model=None,
    )


def _get_agent(ctx: AgentContext) -> Agent:
    global decision_agent
    if decision_agent is None:
        decision_agent = create_decision_agent(
            model=ctx.effective_model,
            extra_tools=ctx.extra_tools or None,
            base_url=ctx.base_url,
            api_key=ctx.api_key,
            compat_mode=ctx.compat_mode,
        )
    return decision_agent


def reset_agent(ctx: AgentContext) -> Agent:
    """重建 Agent（用于工具变更时）。"""
    global decision_agent
    decision_agent = create_decision_agent(
        model=ctx.effective_model,
        extra_tools=ctx.extra_tools or None,
        base_url=ctx.base_url,
        api_key=ctx.api_key,
        compat_mode=ctx.compat_mode,
    )
    return decision_agent


def _build_prompt(state: AgentState) -> str:
    event = state.get("current_event")
    if event is None:
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
    ctx = get_context(state)
    if ctx.hook_manager:
        state = await ctx.hook_manager.fire("pre_think", state)

    agent = _get_agent(ctx)
    caller = _get_caller(ctx)
    deps = _build_deps(state)
    prompt = _build_prompt(state)
    raw_response = await caller.call_with_retry(agent, prompt, deps)

    response = _parse_compat_response(raw_response) if ctx.compat_mode else raw_response

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

    if ctx.hook_manager:
        state = await ctx.hook_manager.fire("post_think", {**state, **result})
        result = {k: state[k] for k in result if k in state}

    return result


def _parse_compat_response(raw: str | LiveResponse) -> LiveResponse:
    """将兼容模式下的文本响应解析为 LiveResponse。"""
    if isinstance(raw, LiveResponse):
        return raw
    try:
        text = raw.strip()
        if text.startswith("```"):
            lines = text.split("\n")
            text = "\n".join(lines[1:])
            if text.endswith("```"):
                text = text[:-3]
            text = text.strip()
        start = text.find("{")
        end = text.rfind("}") + 1
        if start >= 0 and end > start:
            json_str = text[start:end]
            data = json.loads(json_str)
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
        pass
    return LiveResponse(text=raw, emotion=EmotionEnum.neutral, motion=MotionEnum.idle)


_SENTENCE_PATTERN = re.compile(r"(.*?[。！？!?.])")


async def stream_think(state: AgentState) -> dict:
    ctx = get_context(state)
    if ctx.hook_manager:
        state = await ctx.hook_manager.fire("pre_think", state)

    agent = _get_agent(ctx)
    caller = _get_caller(ctx)
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
            # 流正常结束时，将 buffer 残留文本推入 TTS 队列
            if buffer.strip():
                tts_queue.append(
                    TTSTask(
                        text=buffer.strip(),
                        speed=1.0,
                        emotion=state.get("emotion_state", EmotionState()).current,
                    )
                )
                buffer = ""
            final_response = await stream.get_output()
    except Exception as exc:
        logger.warning("Stream think failed, falling back to retry: %s", exc)
        if buffer.strip():
            tts_queue.append(
                TTSTask(
                    text=buffer.strip(),
                    speed=1.0,
                    emotion=state.get("emotion_state", EmotionState()).current,
                )
            )
        final_response = await caller.call_with_retry(agent, prompt, deps)

    # compat_mode 下解析文本响应为 LiveResponse
    if ctx.compat_mode:
        final_response = _parse_compat_response(final_response)
    if final_response is None:
        final_response = caller.fallback_response
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
        "_streaming_tts_pushed": True,
    }

    if ctx.hook_manager:
        state = await ctx.hook_manager.fire("post_think", {**state, **result})
        result = {k: state[k] for k in result if k in state}

    return result
