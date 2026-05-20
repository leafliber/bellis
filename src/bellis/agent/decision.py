"""决策模块：负责 Agent 的思考与响应生成。

本模块实现了直播 Agent 的核心决策流程，包括：
- 基于 pydantic_ai 的决策 Agent 创建与配置
- 熔断器（CircuitBreaker）与弹性调用（ResilientCaller）保障 LLM 调用的稳定性
- 同步思考（think）与流式思考（stream_think）两种决策模式
- 兼容模式下的文本响应解析
"""

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
    """决策 Agent 的依赖注入数据模型。

    将当前场景、情绪、人设和行为历史打包为 Agent 运行时的依赖项，
    用于构建系统提示词和上下文感知决策。

    Attributes:
        scene_context: 当前直播间场景信息（标题、话题、观众数等）。
        emotion_state: Agent 当前情绪状态。
        persona: Agent 人设配置（包含系统提示词等）。
        action_history: 最近的行动记录列表，用于提供上下文连续性。
    """

    scene_context: SceneContext
    emotion_state: EmotionState
    persona: PersonaConfig
    action_history: list[ActionRecord]


class CircuitOpenError(Exception):
    """熔断器处于开启状态时抛出的异常。

    当连续失败次数超过阈值后，熔断器进入 open 状态，
    后续调用将直接抛出此异常，避免对不可用的服务持续发起请求。
    """


class CircuitBreaker:
    """熔断器：保护 LLM 调用免受级联故障。

    实现了 closed → open → half_open 三态熔断模式：
    - closed：正常调用，连续失败计数达到阈值后切换到 open。
    - open：直接拒绝调用，等待恢复超时后切换到 half_open。
    - half_open：允许一次试探性调用，成功则恢复 closed，失败则回到 open。

    Attributes:
        failure_threshold: 触发熔断的连续失败次数阈值。
        recovery_timeout: 熔断开启后等待恢复的超时时间（秒）。
        state: 当前熔断状态（"closed" / "open" / "half_open"）。
        failure_count: 当前连续失败次数。
        last_failure_time: 最近一次失败的单调时间戳。
    """

    def __init__(self, failure_threshold: int = 5, recovery_timeout: float = 30.0) -> None:
        """初始化熔断器。

        Args:
            failure_threshold: 连续失败次数阈值，超过后熔断器进入 open 状态。
            recovery_timeout: 熔断恢复超时时间（秒），open 状态持续至少这么久后才允许试探。
        """
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.state: str = "closed"
        self.failure_count: int = 0
        self.last_failure_time: float = 0.0

    async def call(self, fn: Any, *args: Any, **kwargs: Any) -> Any:
        """通过熔断器保护地调用异步函数。

        根据当前熔断状态决定是否允许调用：
        - open 状态下若未超过恢复超时则直接拒绝，否则切换为 half_open 允许试探。
        - 调用成功则重置失败计数并回到 closed。
        - 调用失败则增加失败计数，达到阈值后切换为 open。

        Args:
            fn: 待调用的异步函数。
            *args: 传递给 fn 的位置参数。
            **kwargs: 传递给 fn 的关键字参数。

        Returns:
            fn 的返回值。

        Raises:
            CircuitOpenError: 熔断器处于 open 状态且未到恢复时间时抛出。
            Exception: fn 调用失败时原样抛出原始异常。
        """
        if self.state == "open":
            if time.monotonic() - self.last_failure_time < self.recovery_timeout:
                raise CircuitOpenError("Circuit breaker is open")
            # 超过恢复超时，允许一次试探性调用
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
    """弹性调用器：结合熔断器与重试机制保障 LLM 调用的可靠性。

    在熔断器保护下进行指数退避重试，所有重试失败后可尝试回退模型，
    最终返回预设的兜底响应，确保 Agent 始终能产出回复。

    Attributes:
        breaker: 底层熔断器实例。
        max_retries: 最大重试次数。
        base_delay: 首次重试的基础延迟（秒）。
        max_delay: 重试延迟上限（秒）。
        fallback_model: 重试全部失败后尝试的回退模型名称，为 None 则不尝试回退。
        fallback_response: 所有调用均失败时返回的兜底 LiveResponse。
    """

    def __init__(
        self,
        breaker: CircuitBreaker | None = None,
        max_retries: int = 3,
        base_delay: float = 1.0,
        max_delay: float = 30.0,
        fallback_model: str | None = None,
    ) -> None:
        """初始化弹性调用器。

        Args:
            breaker: 熔断器实例，为 None 时自动创建默认熔断器。
            max_retries: 最大重试次数（不含首次调用）。
            base_delay: 首次重试的基础延迟（秒），后续按指数退避增长。
            max_delay: 重试延迟上限（秒），防止退避时间过长。
            fallback_model: 回退模型名称，所有重试失败后尝试使用此模型调用。
        """
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
        """通过熔断器和重试机制调用 Agent。

        调用流程：
        1. 在熔断器保护下进行最多 max_retries 次重试，采用指数退避策略。
        2. 若熔断器打开则立即停止重试。
        3. 重试全部失败后，若配置了回退模型则尝试用回退模型调用。
        4. 以上均失败则返回兜底响应。

        Args:
            agent: pydantic_ai Agent 实例。
            prompt: 发送给 Agent 的提示文本。
            deps: Agent 运行时的依赖数据。

        Returns:
            Agent 的输出结果（LiveResponse 或 str），失败时返回兜底响应。
        """
        for attempt in range(self.max_retries):
            try:
                result = await self.breaker.call(agent.run, prompt, deps=deps)
                return _extract_output(result)
            except CircuitOpenError:
                break
            except Exception as exc:
                logger.warning("Agent call attempt %d failed: %s", attempt + 1, exc)
                if attempt < self.max_retries - 1:
                    # 指数退避：base_delay * 2^attempt，但不超过 max_delay
                    await asyncio.sleep(min(self.base_delay * (2**attempt), self.max_delay))
        if self.fallback_model is not None:
            try:
                result = await agent.run(prompt, deps=deps, model=self.fallback_model)
                return _extract_output(result)
            except Exception as exc:
                logger.warning("Fallback model call failed: %s", exc)
        return self.fallback_response


def _extract_output(result) -> LiveResponse | str:
    """从 Agent 运行结果中提取输出。

    优先使用 result.get_output() 方法（pydantic_ai 标准接口），
    若不存在则回退到 result.output 属性。

    Args:
        result: Agent.run() 或 Agent.run_stream() 的返回结果。

    Returns:
        解析后的 LiveResponse 或原始字符串输出。
    """
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
        model: 模型标识符，格式为 "provider:model_name"（如 "openai:gpt-4o"）。
        extra_tools: 额外注册到 Agent 的工具函数列表，为 None 时不注册额外工具。
        base_url: OpenAI 兼容 API 的自定义 base URL，用于接入第三方模型服务。
        api_key: OpenAI 兼容 API 的密钥。
        compat_mode: 兼容模式，用于不支持 tool calling 的 OpenAI 兼容 API，
            开启后 Agent 输出类型为 str 并在系统提示中要求 JSON 格式回复。

    Returns:
        配置好的 pydantic_ai Agent 实例。
    """
    model_obj = model
    if base_url or api_key:
        # 使用自定义 OpenAI 兼容 API 端点构建模型实例
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

    output_type = str if compat_mode else LiveResponse  # compat_mode 下输出为纯文本，后续手动解析

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


decision_agent: Agent | None = None  # 全局单例决策 Agent，延迟初始化


def _get_caller(ctx: AgentContext) -> ResilientCaller:
    """根据 AgentContext 中的配置创建或复用 ResilientCaller。"""
    return ResilientCaller(
        max_retries=3,
        base_delay=1.0,
        max_delay=30.0,
        fallback_model=None,
    )


def _get_agent(ctx: AgentContext) -> Agent:
    """获取或初始化全局决策 Agent 单例。

    首次调用时根据 AgentContext 配置创建 Agent 实例，后续调用直接复用。

    Args:
        ctx: Agent 上下文，提供模型、工具、API 配置等信息。

    Returns:
        已初始化的决策 Agent 实例。
    """
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
    """重建 Agent（用于工具变更时）。

    强制重新创建决策 Agent 实例，覆盖全局单例。
    适用于运行时工具集发生变更（如插件热加载）的场景。

    Args:
        ctx: Agent 上下文，提供模型、工具、API 配置等信息。

    Returns:
        新创建的决策 Agent 实例。
    """
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
    """根据当前状态构建发送给 Agent 的提示文本。

    若当前无事件则生成空闲提示，鼓励 Agent 主动活跃气氛；
    否则将事件内容、来源和元数据组装为结构化提示。

    Args:
        state: 当前 Agent 状态字典。

    Returns:
        构建好的提示文本字符串。
    """
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
    """从 Agent 状态中提取并构建 Agent 运行时依赖数据。

    仅保留最近 10 条行为历史以控制上下文长度。

    Args:
        state: 当前 Agent 状态字典。

    Returns:
        构建好的 LiveDeps 实例。
    """
    history = state.get("action_history", [])[-10:]  # 仅保留最近 10 条行为记录
    return LiveDeps(
        scene_context=state.get("scene_context", SceneContext()),
        emotion_state=state.get("emotion_state", EmotionState()),
        persona=state.get("persona", PersonaConfig()),
        action_history=history,
    )


async def think(state: AgentState) -> dict:
    """执行同步思考：调用决策 Agent 生成回复并更新状态。

    流程：
    1. 触发 pre_think 钩子。
    2. 构建提示和依赖，通过弹性调用器获取 Agent 响应。
    3. 兼容模式下解析文本响应为 LiveResponse。
    4. 更新情绪状态、行为历史和状态版本号。
    5. 触发 post_think 钩子。

    Args:
        state: 当前 Agent 状态字典。

    Returns:
        包含 live_response、emotion_state、action_history、state_version、idle_ticks 的状态更新字典。
    """
    ctx = get_context(state)
    if ctx.hook_manager:
        state = await ctx.hook_manager.fire("pre_think", state)

    agent = _get_agent(ctx)
    caller = _get_caller(ctx)
    deps = _build_deps(state)
    prompt = _build_prompt(state)
    raw_response = await caller.call_with_retry(agent, prompt, deps)

    response = _parse_compat_response(raw_response) if ctx.compat_mode else raw_response

    # 根据响应更新情绪状态（保留当前强度）
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
    history = history[-10:]  # 保留最近 10 条行为记录

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
    """将兼容模式下的文本响应解析为 LiveResponse。

    处理 LLM 可能返回的各种格式：
    - 纯 JSON 字符串
    - 包裹在 Markdown 代码块中的 JSON
    - 混合了其他文本的 JSON（提取第一个 { 到最后一个 } 之间的内容）

    解析失败时返回包含原始文本的默认 LiveResponse（neutral 情绪、idle 动作）。

    Args:
        raw: 原始响应，可能是 LiveResponse 实例（直接返回）或待解析的文本字符串。

    Returns:
        解析后的 LiveResponse 实例。
    """
    if isinstance(raw, LiveResponse):
        return raw
    try:
        text = raw.strip()
        if text.startswith("```"):
            # 去除 Markdown 代码块包裹
            lines = text.split("\n")
            text = "\n".join(lines[1:])
            if text.endswith("```"):
                text = text[:-3]
            text = text.strip()
        start = text.find("{")
        end = text.rfind("}") + 1
        if start >= 0 and end > start:
            # 提取文本中嵌入的 JSON 对象
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
        pass  # JSON 解析失败，回退到默认响应
    return LiveResponse(text=raw, emotion=EmotionEnum.neutral, motion=MotionEnum.idle)


_SENTENCE_PATTERN = re.compile(r"(.*?[。！？!?.])")  # 按中英文标点断句的正则模式


async def stream_think(state: AgentState) -> dict:
    """执行流式思考：通过流式输出实时推送 TTS 任务并生成回复。

    与 think 不同，stream_think 使用 Agent 的流式接口逐 token 接收文本，
    并按句子断句后立即推入 TTS 队列，实现边生成边播报的低延迟体验。
    流式调用失败时自动回退到弹性重试模式。

    流程：
    1. 触发 pre_think 钩子。
    2. 以流式方式调用 Agent，逐句推入 TTS 队列。
    3. 流结束后将 buffer 残留文本推入 TTS 队列。
    4. 流式失败时回退到 call_with_retry。
    5. 兼容模式下解析文本响应。
    6. 更新情绪状态、行为历史和状态版本号。
    7. 触发 post_think 钩子。

    Args:
        state: 当前 Agent 状态字典。

    Returns:
        包含 live_response、emotion_state、action_history、state_version、
        tts_queue、idle_ticks、_streaming_tts_pushed 的状态更新字典。
    """
    ctx = get_context(state)
    if ctx.hook_manager:
        state = await ctx.hook_manager.fire("pre_think", state)

    agent = _get_agent(ctx)
    caller = _get_caller(ctx)
    deps = _build_deps(state)
    prompt = _build_prompt(state)
    tts_queue = list(state.get("tts_queue", []))
    buffer = ""  # 累积流式文本片段，用于断句
    final_response: LiveResponse | None = None
    try:
        async with agent.run_stream(prompt, deps=deps) as stream:
            async for text_delta in stream.stream_text(delta=True):
                buffer += text_delta
                sentences = _SENTENCE_PATTERN.findall(buffer)
                if sentences:
                    for sentence in sentences:
                        buffer = buffer.replace(sentence, "", 1)  # 从缓冲区移除已推送的句子
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
        # 流式失败时，先将 buffer 中残留的文本推入 TTS 队列
        if buffer.strip():
            tts_queue.append(
                TTSTask(
                    text=buffer.strip(),
                    speed=1.0,
                    emotion=state.get("emotion_state", EmotionState()).current,
                )
            )
        final_response = await caller.call_with_retry(agent, prompt, deps)  # 回退到弹性重试模式

    # compat_mode 下解析文本响应为 LiveResponse
    if ctx.compat_mode:
        final_response = _parse_compat_response(final_response)
    if final_response is None:
        final_response = caller.fallback_response  # 所有调用均失败，使用兜底响应
    # 根据响应更新情绪状态（保留当前强度）
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
    history = history[-10:]  # 保留最近 10 条行为记录

    result = {
        "live_response": final_response,
        "emotion_state": new_emotion,
        "action_history": history,
        "state_version": state.get("state_version", 0) + 1,
        "tts_queue": tts_queue,
        "idle_ticks": 0,
        "_streaming_tts_pushed": True,  # 标记 TTS 已在流式过程中推送，避免 act 重复追加
    }

    if ctx.hook_manager:
        state = await ctx.hook_manager.fire("post_think", {**state, **result})
        result = {k: state[k] for k in result if k in state}

    return result
