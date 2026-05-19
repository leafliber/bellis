from __future__ import annotations

from collections.abc import Awaitable, Callable

from bellis.core.state import AgentState

HookPoint = str
HookFn = Callable[[AgentState], Awaitable[AgentState]]

HOOK_POINTS = (
    "pre_perceive",
    "post_perceive",
    "pre_think",
    "post_think",
    "pre_act",
    "post_act",
)


class HookManager:
    """管理主循环 6 个挂载点的 hook 函数。"""

    def __init__(self) -> None:
        self._hooks: dict[HookPoint, list[HookFn]] = {p: [] for p in HOOK_POINTS}

    def register(self, point: HookPoint, fn: HookFn) -> None:
        if point not in self._hooks:
            raise ValueError(f"Unknown hook point: {point}. Available: {HOOK_POINTS}")
        self._hooks[point].append(fn)

    async def fire(self, point: HookPoint, state: AgentState) -> AgentState:
        for fn in self._hooks.get(point, []):
            state = await fn(state)
        return state

    def clear(self) -> None:
        for point in self._hooks:
            self._hooks[point].clear()
