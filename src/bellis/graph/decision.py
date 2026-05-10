from __future__ import annotations

import asyncio
import re
import time
from typing import Any

from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel
from pydantic_ai import Agent, RunContext

from bellis.core.enums import EmotionEnum, MotionEnum
from bellis.core.models import ActionRecord, EmotionState, PersonaConfig, SceneContext, TTSTask
from bellis.core.response import LiveResponse
from bellis.core.state import AgentState


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
                return result.data
            except CircuitOpenError:
                break
            except Exception:
                if attempt < self.max_retries - 1:
                    await asyncio.sleep(base_delay * (2**attempt))
        if self.fallback_model is not None:
            try:
                result = await agent.run(prompt, deps=deps, model=self.fallback_model)
                return result.data
            except Exception:
                pass
        return self.fallback_response


def create_decision_agent(model: str = "openai:gpt-4o") -> Agent:
    agent = Agent(
        model,
        result_type=LiveResponse,
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
        return "\n".join(parts)

    @agent.tool
    async def search_knowledge(ctx: RunContext[LiveDeps], query: str) -> str:
        return f"[RAG检索结果] 关于「{query}」的占位内容，实际实现可替换为真实检索。"

    @agent.tool
    async def query_product(ctx: RunContext[LiveDeps], name: str) -> str:
        return f"[商品查询] 「{name}」的占位信息，实际实现可替换为真实查询。"

    return agent


decision_agent: Agent | None = None
_caller = ResilientCaller()


def _get_agent() -> Agent:
    global decision_agent
    if decision_agent is None:
        decision_agent = create_decision_agent()
    return decision_agent


def _build_prompt(state: AgentState) -> str:
    event = state.get("current_event")
    if event is None:
        return "请根据当前场景和情绪状态生成回应。"
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


async def decide(state: AgentState) -> dict:
    agent = _get_agent()
    deps = _build_deps(state)
    prompt = _build_prompt(state)
    response = await _caller.call_with_retry(agent, prompt, deps)
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
    return {
        "live_response": response,
        "emotion_state": new_emotion,
        "action_history": history,
        "state_version": state.get("state_version", 0) + 1,
    }


_SENTENCE_PATTERN = re.compile(r"(.*?[。！？!?.])")


async def stream_decide(state: AgentState) -> dict:
    agent = _get_agent()
    deps = _build_deps(state)
    prompt = _build_prompt(state)
    tts_queue = list(state.get("tts_queue", []))
    buffer = ""
    final_response: LiveResponse | None = None
    try:
        async with agent.iter_stream(prompt, deps=deps) as run:
            async for node in run:
                if Agent.is_model_node(node):
                    async with node.stream() as stream:
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
            result = await run.result()
            final_response = result.data
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
    return {
        "live_response": final_response,
        "emotion_state": new_emotion,
        "action_history": history,
        "state_version": state.get("state_version", 0) + 1,
        "tts_queue": tts_queue,
    }


def build_decision_graph(streaming: bool = False):
    graph = StateGraph(AgentState)
    node_fn = stream_decide if streaming else decide
    graph.add_node("decide", node_fn)
    graph.add_edge(START, "decide")
    graph.add_edge("decide", END)
    return graph.compile()
