"""Hook 管理模块 — 提供主循环感知-思考-行动各阶段的挂载点机制。

本模块定义了 Agent 主循环的 6 个标准 hook 挂载点，允许插件在感知、思考、
行动阶段的前后注入自定义逻辑。Hook 函数接收并返回 AgentState，
形成链式处理管道。
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

from bellis.core.state import AgentState

logger = logging.getLogger(__name__)

# Hook 挂载点类型别名，对应 HOOK_POINTS 中的字符串值
HookPoint = str
# Hook 函数类型：接收 AgentState，异步返回变换后的 AgentState
HookFn = Callable[[AgentState], Awaitable[AgentState]]

# 主循环的 6 个标准挂载点，分别对应感知、思考、行动的前后阶段
HOOK_POINTS = (
    "pre_perceive",
    "post_perceive",
    "pre_think",
    "post_think",
    "pre_act",
    "post_act",
)


class HookManager:
    """管理主循环 6 个挂载点的 hook 函数。

    每个挂载点维护一个有序的 hook 函数列表，fire 时按注册顺序依次执行。
    单个 hook 执行失败不会中断后续 hook 的执行，仅记录异常日志。

    Attributes:
        _hooks: 以挂载点名称为键、hook 函数列表为值的字典。
    """

    def __init__(self) -> None:
        self._hooks: dict[HookPoint, list[HookFn]] = {p: [] for p in HOOK_POINTS}

    def register(self, point: HookPoint, fn: HookFn) -> None:
        """向指定挂载点注册一个 hook 函数。

        Args:
            point: 挂载点名称，必须为 HOOK_POINTS 中的合法值。
            fn: Hook 函数，签名为 ``async (AgentState) -> AgentState``。

        Raises:
            ValueError: 当 point 不是合法的挂载点名称时抛出。
        """
        if point not in self._hooks:
            raise ValueError(f"Unknown hook point: {point}. Available: {HOOK_POINTS}")
        self._hooks[point].append(fn)

    async def fire(self, point: HookPoint, state: AgentState) -> AgentState:
        """触发指定挂载点的所有 hook 函数，按注册顺序依次执行。

        每个 hook 接收上一个 hook 的输出作为输入，形成链式处理。
        单个 hook 异常不会中断链路，仅记录日志后继续执行后续 hook。

        Args:
            point: 挂载点名称。
            state: 当前 Agent 状态。

        Returns:
            经过所有 hook 处理后的 AgentState。
        """
        for fn in self._hooks.get(point, []):
            try:
                state = await fn(state)
            except Exception:
                logger.exception("Hook %s 在 %s 点执行失败", fn.__name__, point)
        return state

    def clear(self) -> None:
        """清空所有挂载点上已注册的 hook 函数。"""
        for point in self._hooks:
            self._hooks[point].clear()
