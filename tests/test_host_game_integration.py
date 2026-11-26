import asyncio
import json
import sqlite3
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import asynccontextmanager, closing
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from bellis_common import agent_events as ev
from bellis_common.permit import PermitMethods, ReleaseReason
from bellis_game.loop import GameSession, GameSessionConfig, LoopConfig
from bellis_host import (
    ConsoleConfig,
    DirectorConfig,
    HostApp,
    HostConfig,
    HostMode,
    IntentSource,
    SafetyError,
    StageConfig,
    parse_game_directive,
)
from test_console_and_slow_agent import Browser, Model
from test_fast_loop import DONE, PROFILE, Frames
from test_fast_loop import Model as Vision
from test_game_agent_session import Core, connect
from test_host_game_permit import pipe, respond, until
from test_obs_and_watchdog import ObsServer, assert_batch
from test_obs_and_watchdog import obs as obs
from test_realtime_interop import released
from test_stage_and_speech import Voice, page
from websockets.asyncio.client import ClientConnection

GOAL = {"command": "set_goal", "description": "观察当前画面"}
LINE = "我来看看画面。"
COMMENT = "画面观察完毕。"


def test_parse_game_directives() -> None:
    first = parse_game_directive(GOAL)
    second = parse_game_directive(GOAL)
    assert isinstance(first, ev.GoalSet) and isinstance(second, ev.GoalSet)
    assert first.goal_id and first.goal_id != second.goal_id
    assert (first.description, first.max_steps, first.timeout_s) == (GOAL["description"], 8, 90.0)
    for steps, timeout in ((1, 5), (20, 180)):
        raw = dict(GOAL, goal_id="obs", max_steps=steps, timeout_s=timeout)
        assert parse_game_directive(raw) == ev.GoalSet("obs", GOAL["description"], steps, timeout)
    for command, expected in (
        ("cancel_goal", ev.GoalCancel()),
        ("pause_pacing", ev.PacingPause()),
        ("resume_pacing", ev.PacingResume()),
    ):
        assert parse_game_directive({"command": command}) == expected
    assert parse_game_directive(
        {"command": "cancel_goal", "goal_id": "a", "reason": "changed"}
    ) == (ev.GoalCancel("a", "changed"))


@pytest.mark.parametrize("raw", [
    None, [], {}, {"command": []}, {"command": "unknown"}, {"command": "set_goal"},
    dict(GOAL, description=" "), dict(GOAL, goal_id=None), dict(GOAL, goal_id=""),
    dict(GOAL, extra=True), dict(GOAL, type="goal_set"), dict(GOAL, max_steps=True),
    dict(GOAL, max_steps=1.5), dict(GOAL, max_steps=0), dict(GOAL, max_steps=21),
    dict(GOAL, timeout_s=True), dict(GOAL, timeout_s="10"), dict(GOAL, timeout_s=4.99),
    dict(GOAL, timeout_s=181), dict(GOAL, timeout_s=float("nan")),
    dict(GOAL, timeout_s=float("inf")), dict(GOAL, timeout_s=10**400),
    {"command": "cancel_goal", "goal_id": False}, {"command": "pause_pacing", "reason": 4},
    {"command": "resume_pacing", "goal_id": None},
])  # fmt: skip
def test_invalid_directive(raw: object) -> None:
    with pytest.raises(ValueError):
        parse_game_directive(raw)


@dataclass
class Studio:
    app: HostApp
    browser: Browser
    model: Model

    def context(self) -> dict[str, Any]:
        system, user = self.model.messages[-1]
        assert "不可逆" in system["content"] and "game.permit_armed" in system["content"]
        body = user["content"]
        assert body.startswith("<untrusted-data>") and body.endswith("</untrusted-data>")
        return json.loads(body.removeprefix("<untrusted-data>").removesuffix("</untrusted-data>"))


@pytest.fixture
async def studio(
    tmp_path: Path, obs: ObsServer, monkeypatch: pytest.MonkeyPatch
) -> AsyncIterator[Studio]:
    monkeypatch.setenv("BELLIS_OBS_PASSWORD", "password")
    cfg = HostConfig(
        db_path=tmp_path / "host.db",
        obs=obs.config,
        enable_watchdog=False,
        stage=StageConfig(),
        console=ConsoleConfig(),
        director=DirectorConfig(batch_window_s=0),
    )
    model = Model()
    app = HostApp(cfg, tts=Voice(), llm=model)
    try:
        info = await app.start()
        browser = Browser(app.console)
        assert (await browser.api("/api/login", {"token": info.console_login_url.split("=")[1]}))[
            0
        ] == 200
        yield Studio(app, browser, model)
    finally:
        await app.close()


@asynccontextmanager
async def agent(app: HostApp, vision: Vision) -> AsyncGenerator[GameSession]:
    core = Core()  # Rejects every physical action block.
    config = GameSessionConfig(
        link_credentials=app.game_link.credentials, loop_config=LoopConfig(max_frame_age_s=30)
    )
    core.session = GameSession(core, Frames(), vision, PROFILE, config)
    run = asyncio.create_task(core.session.run())
    try:
        async with asyncio.timeout(6):
            await app.game_link.wait_connected(2)
            yield core.session
    finally:
        await core.session.close()
        await run


async def hear(ws: ClientConnection, line: str) -> str:
    sid = ""
    async for frame in ws:
        if isinstance(frame, bytes):
            assert sid
            header = int.from_bytes(frame[:2], "big")
            assert json.loads(frame[2 : 2 + header])["sentenceId"] == sid
            assert frame[2 + header :] == bytes(200)
            await ws.send(json.dumps(dict(kind="cursor", sentenceId=sid, played=25)))
            return sid
        msg = json.loads(frame)
        if msg["kind"] == "begin":
            assert msg["subtitle"] == line
            sid = msg["sentenceId"]
    pytest.fail("Stage disconnected before audio")


async def acknowledge(ws: ClientConnection, sid: str, *, interrupted: bool = False) -> None:
    async for frame in ws:
        msg = json.loads(frame)
        if msg["kind"] == ("truncate" if interrupted else "end"):
            assert msg["sentenceId"] == sid
            kind, played = ("truncated", 25) if interrupted else ("ended", 100)
            await ws.send(json.dumps(dict(kind=kind, sentenceId=sid, played=played)))
            return
    pytest.fail("Stage disconnected before acknowledgement")


async def test_streamed_speech_and_observation(studio: Studio) -> None:
    app, browser, model = studio.app, studio.browser, studio.model
    vision = Vision((DONE,))
    vision.gate = asyncio.Event()
    model.parts = ['{"action":"speak","text":"' + LINE, '","game":' + json.dumps(GOAL) + "}"]
    async with agent(app, vision), pipe(app.game_permit), page(app.stage) as ws:
        app.safety.start_live()
        data = {"viewer_id": "v", "viewer_name": "观众", "text": "画面怎么样？"}
        assert await browser.api("/api/danmaku", data) == (200, {"ok": True})
        sid = await hear(ws, LINE)
        assert not vision.called.is_set() and not model.closed.is_set()
        game = studio.context()["game"]
        assert game["snapshot"]["connected"] and game["permit_armed"] is False
        assert game["events"] == []
        model.release.set()
        await vision.called.wait()
        assert not app.speech.recent_heard()
        goal_id = app.game_link.snapshot().active_goal_id
        assert goal_id and json.loads(vision.prompts[0])["step"] == 1
        with pytest.raises(SafetyError, match="untrusted_source_denied"):
            await app.game.dispatch(ev.GoalCancel(), source=IntentSource.UNTRUSTED)
        model.parts = [json.dumps(dict(action="speak", text=COMMENT), ensure_ascii=False)]
        vision.gate.set()
        await until(lambda: isinstance(app.game_link.last_event, ev.GoalCompleted))
        assert len(model.messages) == 1
        await acknowledge(ws, sid)
        await acknowledge(ws, await hear(ws, COMMENT))
        await until(lambda: app.speech.recent_heard() == (LINE, COMMENT))
        event = ev.GoalCompleted(goal_id, str(DONE["evidence"]), 1, 1)
        assert studio.context()["game"]["events"] == [event.to_dict()]
        assert str(DONE["evidence"]) not in model.messages[-1][0]["content"]
        with closing(sqlite3.connect(app.config.db_path)) as db:
            assert db.execute("PRAGMA journal_mode").fetchone() == ("wal",)
            (key,) = db.execute("SELECT key FROM intents WHERE type='game.goal_set'").fetchone()
        record = app.store.get_intent(key)
        assert record and record.state == "succeeded" and record.source == IntentSource.AGENT
        assert record.result == ev.CommandAck(True).to_dict()


async def test_operator_game_controls(studio: Studio) -> None:
    app, browser = studio.app, studio.browser
    data = {"description": "查看地图"}
    assert not (await browser.api("/api/status"))[1]["game_link"]["connected"]
    for route in ("goal", "pause", "resume", "cancel"):
        assert (await browser.api("/api/game/" + route, data if route == "goal" else {}))[0] == 503
    vision = Vision((DONE,))
    vision.gate = asyncio.Event()
    async with agent(app, vision):
        for invalid in (dict(data, goal_id="override"), dict(data, command="resume_pacing"), {}):
            assert (await browser.api("/api/game/goal", invalid))[0] == 400
        assert (await browser.api("/api/game/pause", {"reason": None}))[0] == 400
        assert (await browser.api("/api/game/goal", data))[0] == 409
        assert (await browser.api("/api/game/resume", {}))[0] == 409
        assert await browser.api("/api/game/pause", {}) == (200, {"ok": True, "reason": ""})
        assert (await browser.api("/api/status"))[1]["game_link"]["paused"]
        assert await browser.api("/api/game/cancel", {}) == (200, {"ok": False, "reason": "idle"})
        app.safety.start_live()
        assert (await browser.api("/api/game/resume", {}))[1]["ok"]
        status, reply = await browser.api("/api/game/goal", data)
        assert status == 200 and reply["ok"] and reply["goal_id"]
        await vision.called.wait()
        snap = (await browser.api("/api/status"))[1]["game_link"]
        assert snap["active_goal_id"] == reply["goal_id"] and not snap["paused"]
        assert (await browser.api("/api/game/goal", data))[1]["reason"] == "busy"
        assert (await browser.api("/api/control/pause", {}))[0] == 200
        await until(lambda: app.game_link.last_event is not None)
        assert app.game_link.last_event == ev.GoalStuck(
            reply["goal_id"], "cancelled", "operator_pause", 1, 1
        )
        assert vision.cancelled and app.safety.snapshot().mode == HostMode.SAFE_STOP
        with closing(sqlite3.connect(app.config.db_path)) as db:
            rows = db.execute(
                "SELECT source,state,error FROM intents WHERE type='game.goal_set' ORDER BY id"
            )
            assert rows.fetchall() == [
                ("operator", "succeeded", None),
                ("operator", "failed", "busy"),
            ]


async def test_takeover_requests_commentary(studio: Studio) -> None:
    app, model = studio.app, studio.model
    vision = Vision((DONE,))
    vision.gate = asyncio.Event()
    async with agent(app, vision) as session, pipe(app.game_permit) as peer, page(app.stage) as ws:
        app.safety.start_live()
        respond(peer, PermitMethods.LEASE_RENEW)
        token = await app.game_permit.arm_input()
        model.parts = [json.dumps(dict(action="silence", game=GOAL))]
        result = await app.director.run_once()
        assert result.game_ack == ev.CommandAck(True) and studio.context()["game"]["permit_armed"]
        await vision.called.wait()
        rel = released(peer, ReleaseReason.TAKEOVER, token=token)
        await until(lambda: app.game_permit.active_token is None)
        model.parts = [json.dumps(dict(action="speak", text=COMMENT), ensure_ascii=False)]
        session.on_released(rel)
        await acknowledge(ws, await hear(ws, COMMENT))
        (event,) = studio.context()["game"]["events"]
        assert event["type"] == "control_released" and event["reason"] == "takeover"
        assert not studio.context()["game"]["permit_armed"] and vision.cancelled
        assert app.safety.snapshot().mode == HostMode.LIVE


@pytest.mark.parametrize("source", ["console", "core"])
async def test_emergency_cancels_active_game_and_speech(
    studio: Studio, obs: ObsServer, source: str
) -> None:
    app, model = studio.app, studio.model
    vision = Vision((DONE,))
    vision.gate = asyncio.Event()
    async with agent(app, vision), pipe(app.game_permit) as peer, page(app.stage) as ws:
        app.safety.start_live()
        respond(peer, PermitMethods.LEASE_RENEW)
        stop = respond(peer, PermitMethods.INPUT_STOP, release_id=None)
        token = await app.game_permit.arm_input()
        model.parts = [json.dumps(dict(action="speak", text=LINE, game=GOAL), ensure_ascii=False)]
        turn = asyncio.create_task(app.director.run_once())
        sid = await hear(ws, LINE)
        await vision.called.wait()
        if source == "core":
            released(peer, ReleaseReason.EMERGENCY_STOP, token=token)
        else:
            assert (await studio.browser.api("/api/control/emergency", {}))[0] == 200
            stop.assert_called_once_with({"through_token": None})
        await acknowledge(ws, sid, interrupted=True)
        await obs.batch_seen.wait()
        assert_batch(obs)
        await until(lambda: isinstance(app.game_link.last_event, ev.GoalStuck))
        assert isinstance(app.game_link.last_event, ev.GoalStuck)
        assert app.game_link.last_event.reason == "cancelled" and vision.cancelled
        assert (await turn).action == "interrupted" and app.game_permit.active_token is None
        assert app.safety.snapshot().mode == HostMode.EMERGENCY_STOP
        with pytest.raises(SafetyError, match="emergency_stop"):
            await app.game.cancel_goal()


async def test_emergency_during_unacknowledged_goal(studio: Studio) -> None:
    app = studio.app
    app.safety.start_live()
    received, cancelled = asyncio.Event(), asyncio.Event()

    async def handle(raw: object) -> dict[str, object]:
        cmd = ev.parse_slow_command(raw)
        if isinstance(cmd, ev.GoalSet):
            received.set()
            await asyncio.Event().wait()
        assert isinstance(cmd, ev.GoalCancel) and cmd.goal_id is None
        cancelled.set()
        return ev.CommandAck(False, "idle").to_dict()

    peer = await connect(app.game_link)
    try:
        peer.handle(ev.AgentLinkMethods.HOST_COMMAND, handle)
        hello = ev.AgentHelloParams(PROFILE.game_id, PROFILE.display_name)
        await peer.request(ev.AgentLinkMethods.AGENT_HELLO, hello.to_dict())
        studio.model.parts = [json.dumps(dict(action="silence", game=GOAL))]
        turn = asyncio.create_task(app.director.run_once())
        async with asyncio.timeout(3):
            await received.wait()
            await asyncio.to_thread(app.safety.trigger_emergency, "hotkey")
            assert (await turn).action == "interrupted"
            await cancelled.wait()
            await until(lambda: app.game_link.snapshot().active_goal_id is None)
        with closing(sqlite3.connect(app.config.db_path)) as db:
            row = db.execute(
                "SELECT state,error FROM intents WHERE type='game.goal_set'"
            ).fetchone()
            assert row == ("unknown", "CancelledError")
    finally:
        await peer.close()


async def test_rate_limit_preserves_stop_controls(studio: Studio) -> None:
    app = studio.app
    app.safety.start_live()
    async with agent(app, Vision(())):
        for _ in range(20):
            assert (await app.game.resume_pacing()).accepted
        with pytest.raises(SafetyError, match="rate_limited"):
            await app.game.set_goal(ev.GoalSet("observation", "查看画面"))
        assert (await app.game.pause_pacing()).accepted
