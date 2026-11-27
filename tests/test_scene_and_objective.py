"""Unit and integration tests for Step 6c transitions, scene narrative, and session objectives."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Sequence
from dataclasses import replace
from pathlib import Path
from time import perf_counter_ns
from unittest.mock import AsyncMock, Mock

import pytest
from bellis_common import agent_events as ev
from bellis_common.permit_messages import ReleaseReason, ReleaseVerification
from bellis_common.wire_codec import ProtocolError
from bellis_game.io import RingFrame
from bellis_game.loop import GoalCompleted, SceneObserved
from bellis_game.perception import detect_transition, frame_luma
from bellis_game.skills import ProposalError, parse_agent_decision
from bellis_host import DirectorConfig, HostApp, HostConfig
from bellis_host.speech import TtsSynthesizer
from test_console_and_slow_agent import Browser
from test_fast_loop import CONFIG, DONE, GOAL, WAIT, Session


def _frame(w: int, h: int, gray: int, *, num: int = 1, ts: int | None = None) -> RingFrame:
    px = bytes([gray, gray, gray, 255]) * (w * h)
    return RingFrame(num, perf_counter_ns() if ts is None else ts, 1, w, h, w * 4, px)


def test_luma_and_transition_detection() -> None:
    dark = _frame(128, 72, 4, num=1)
    bright = _frame(128, 72, 250, num=2)
    normal = _frame(128, 72, 120, num=3)
    normal_other = _frame(128, 72, 180, num=4)
    tiny_dark = _frame(8, 4, 0, num=5)

    assert frame_luma(dark).is_dark and not frame_luma(dark).is_bright
    assert frame_luma(bright).is_bright and not frame_luma(bright).is_dark
    assert detect_transition(dark) == "dark_transition"
    assert detect_transition(bright) == "bright_transition"
    assert detect_transition(normal) is None
    assert detect_transition(normal_other, normal) == "fast_motion"
    assert detect_transition(normal, normal) is None
    assert detect_transition(tiny_dark) is None


def test_scene_observed_and_vlm_narrative_fields() -> None:
    parsed = parse_agent_decision(
        {
            "observation": "Dialogue box open",
            "action": "done",
            "evidence": "line visible",
            "screen_kind": "Dialogue",
            "dialogue_line": "  三月七：前面好像有宝箱！  ",
        }
    )
    assert parsed.screen_kind == "dialogue"
    assert parsed.dialogue_line == "三月七：前面好像有宝箱！"
    with pytest.raises(ProposalError):
        parse_agent_decision(
            {"observation": "x", "action": "done", "evidence": "ok", "screen_kind": "invalid"}
        )
    event = ev.SceneObserved("g1", "dialogue", "你好", 2, 10)
    assert ev.parse_fast_event(event.to_dict()) == event
    with pytest.raises(ProtocolError):
        ev.SceneObserved("g1", "bad_kind")


async def test_fast_loop_skips_dark_transition_and_emits_deduped_scene_events() -> None:
    events: list[object] = []
    s = Session(
        dict(WAIT, screen_kind="dialogue", dialogue_line="台词A"),
        dict(WAIT, screen_kind="dialogue", dialogue_line="台词A"),
        dict(DONE, screen_kind="menu", dialogue_line="台词B"),
        config=replace(CONFIG, max_transition_wait_s=1.0),
        on_event=events.append,
    )
    s.frames.frame = _frame(128, 72, 0, num=10)

    async def finish_fade() -> None:
        await asyncio.sleep(0.05)
        assert not s.model.called.is_set()
        s.frames.frame = _frame(128, 72, 128, num=11)

    async with asyncio.timeout(2):
        fade = asyncio.create_task(finish_fade())
        outcome = await s.loop.run_goal(GOAL)
        await fade
    assert isinstance(outcome, GoalCompleted)
    assert events == [
        SceneObserved(GOAL.goal_id, "dialogue", "台词A", 1, 11),
        SceneObserved(GOAL.goal_id, "menu", "台词B", 3, 11),
    ]


class _ContinuationLlm:
    def __init__(self) -> None:
        self.contexts: list[dict[str, object]] = []
        self.called = asyncio.Event()

    async def stream_chat(
        self, messages: Sequence[dict[str, str]], *, cancel: asyncio.Event | None = None
    ) -> AsyncIterator[str]:
        user = messages[-1]["content"]
        body = user.removeprefix("<untrusted-data>").removesuffix("</untrusted-data>")
        self.contexts.append(json.loads(body))
        self.called.set()
        yield json.dumps(
            {
                "action": "silence",
                "reason": "next step",
                "game": {"command": "set_goal", "description": "第二步任务", "max_steps": 6},
            }
        )


async def test_narrative_history_objective_continuation_and_fail_closed_halt(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cfg = HostConfig(
        db_path=tmp_path / "host.sqlite3",
        enable_obs=False,
        enable_watchdog=False,
        director=DirectorConfig(batch_window_s=0.02),
    )
    llm = _ContinuationLlm()
    app = HostApp(cfg, tts=Mock(spec=TtsSynthesizer), llm=llm)
    info = await app.start()
    try:
        app.safety.start_live()
        browser = Browser(app.console)
        token = info.console_login_url.split("#token=")[1]
        assert (await browser.api("/api/login", {"token": token}))[0] == 200

        # Connect simulated game peer to HostGameLink
        sent_commands: list[dict[str, object]] = []

        async def request(method: str, params: dict[str, object]) -> dict[str, object]:
            sent_commands.append(params)
            return ev.CommandAck(True).to_dict()

        app.game_link._hello = ev.AgentHelloParams("hsr", "HSR")  # pyright: ignore[reportPrivateUsage]
        app.game_link._peer = Mock(  # pyright: ignore[reportPrivateUsage]
            connection=Mock(is_open=True),
            request=AsyncMock(side_effect=request),
            close=AsyncMock(),
        )
        app.game_link._goal = ev.GoalSet("g1", "第一步任务")  # pyright: ignore[reportPrivateUsage]

        # Set session objective via console API
        code, resp = await browser.api(
            "/api/game/objective",
            {"description": "完成今日每日实训", "auto_continue": True, "max_auto_steps": 2},
        )
        assert code == 200 and resp["ok"] is True
        assert resp["objective"]["completed_steps"] == 0

        # SceneObserved updates narrative quietly without triggering LLM
        app.game_link._receive_event(  # pyright: ignore[reportPrivateUsage]
            ev.SceneObserved("g1", "dialogue", "开拓者，出发吧！", 1, 20).to_dict()
        )
        app.game_link._receive_event(  # pyright: ignore[reportPrivateUsage]
            ev.SceneObserved("g1", "dialogue", "开拓者，出发吧！", 2, 21).to_dict()
        )
        await asyncio.sleep(0.06)
        assert not llm.contexts
        snap = app.game_link.snapshot()
        assert snap.screen_kind == "dialogue"
        assert snap.recent_narrative == ("开拓者，出发吧！",)

        # GoalCompleted wakes director with narrative + objective context -> dispatches next goal
        app.game_link._receive_event(  # pyright: ignore[reportPrivateUsage]
            ev.GoalCompleted("g1", "第一步完成", 2, 21).to_dict()
        )
        await asyncio.wait_for(llm.called.wait(), timeout=1.0)
        await asyncio.sleep(0.05)
        game_ctx = llm.contexts[0]["game"]
        assert isinstance(game_ctx, dict)
        assert game_ctx["objective"]["completed_steps"] == 1
        assert game_ctx["objective"]["auto_continue"] is True
        assert game_ctx["snapshot"]["recent_narrative"] == ["开拓者，出发吧！"]
        assert any(cmd.get("description") == "第二步任务" for cmd in sent_commands)

        # ControlReleased (takeover) halts auto_continue immediately, marking paused_for_takeover
        app.game_link._receive_event(  # pyright: ignore[reportPrivateUsage]
            ev.ControlReleased(
                "g2", ReleaseReason.TAKEOVER, ReleaseVerification.VERIFIED, 1
            ).to_dict()
        )
        obj = app.game.objective_snapshot()
        assert obj is not None and obj["auto_continue"] is False
        assert obj["paused_for_takeover"] is True

        # When permit auto-resumes after takeover, objective resumes & triggers director
        llm.called.clear()
        app.game_link._goal = None  # pyright: ignore[reportPrivateUsage]
        app._on_permit_auto_resumed()  # pyright: ignore[reportPrivateUsage]
        obj = app.game.objective_snapshot()
        assert obj is not None and obj["auto_continue"] is True
        await asyncio.wait_for(llm.called.wait(), timeout=1.0)

        # Emergency stop permanently clears paused_for_takeover (never auto-resumes)
        app.game_link._receive_event(  # pyright: ignore[reportPrivateUsage]
            ev.ControlReleased(
                "g3", ReleaseReason.EMERGENCY_STOP, ReleaseVerification.VERIFIED, 1
            ).to_dict()
        )
        assert app.game.resume_objective_after_takeover() is False

        # Console clear removes objective; let pending ControlReleased director turn drain first
        code, cleared = await browser.api("/api/game/objective", {"clear": True})
        assert code == 200 and cleared["objective"] is None
        await asyncio.sleep(0.06)

        # StepProgress updates phase/recent_steps without waking LLM or clobbering last_event
        llm.called.clear()
        app.game_link._goal = ev.GoalSet("g4", "打开指南", max_steps=6)  # pyright: ignore[reportPrivateUsage]
        prev_last = app.game_link.last_event
        app.game_link._receive_event(  # pyright: ignore[reportPrivateUsage]
            ev.StepProgress("g4", 1, 6, "thinking").to_dict()
        )
        assert app.game_link.snapshot().phase == "thinking"
        assert app.game_link.snapshot().current_step == 1
        app.game_link._receive_event(  # pyright: ignore[reportPrivateUsage]
            ev.StepProgress(
                "g4", 1, 6, "step_done", "key_press", "f4", "verified_changed", "打开了指南"
            ).to_dict()
        )
        snap = app.game_link.snapshot()
        assert snap.phase == "step_done" and len(snap.recent_steps) == 1
        assert snap.recent_steps[0]["summary"] == "f4"
        assert app.game_link.last_event == prev_last
        await asyncio.sleep(0.05)
        assert not llm.called.is_set()

        # Setting objective while idle and armed wakes SlowDirector immediately
        llm.called.clear()
        app.game_link._goal = None  # pyright: ignore[reportPrivateUsage]
        with monkeypatch.context() as mp:
            mp.setattr(type(app.game_permit), "armed", property(lambda _: True))
            code, oresp = await browser.api(
                "/api/game/objective",
                {"description": "立刻开跑总目标", "auto_continue": True, "max_auto_steps": 4},
            )
            assert code == 200 and oresp["ok"] is True
            await asyncio.wait_for(llm.called.wait(), timeout=1.0)

        # Queueing a single-shot goal while arm_pending dispatches automatically when armed
        app.game_link._goal = None  # pyright: ignore[reportPrivateUsage]
        app.game_permit._arm_pending = True  # pyright: ignore[reportPrivateUsage]
        code, qresp = await browser.api(
            "/api/game/goal", {"description": "排队目标", "max_steps": 5, "wait_for_arm": True}
        )
        assert code == 200 and qresp["queued"] is True
        assert (await browser.api("/api/status"))[1]["game_queued_goal"][
            "description"
        ] == "排队目标"
        app._on_permit_auto_resumed()  # pyright: ignore[reportPrivateUsage]
        await asyncio.sleep(0.05)
        assert any(cmd.get("description") == "排队目标" for cmd in sent_commands)
        assert (await browser.api("/api/status"))[1]["game_queued_goal"] is None

        # Clear objective with cancel_active stops active goal cleanly
        app.game_link._goal = ev.GoalSet("g5", "进行中")  # pyright: ignore[reportPrivateUsage]
        code, resp = await browser.api(
            "/api/game/objective", {"clear": True, "cancel_active": True}
        )
        assert code == 200 and resp["objective"] is None
        assert any(cmd.get("type") == "goal_cancel" for cmd in sent_commands)
    finally:
        await app.close()
