import asyncio
import json
import sqlite3
from collections.abc import AsyncGenerator, AsyncIterator, Sequence
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
from test_console_and_slow_agent import Browser, Model, Player
from test_fast_loop import ASK, DONE, PROFILE, WAIT, Frames
from test_fast_loop import Model as Vision
from test_game_agent_session import NEEDED, RESOLVED, Core, connect
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
    directive = {"command": "resolve_decision", "chosen_index": 1}
    assert parse_game_directive(directive, pending_decision=NEEDED) == RESOLVED
    full = dict(directive, goal_id="map", decision_id="id", chosen_option="B")
    assert parse_game_directive(full) == parse_game_directive(full, pending_decision=NEEDED)
    assert parse_game_directive(full) == RESOLVED
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
    {"command": "resolve_decision", "chosen_index": 1},
    *(dict(command="resolve_decision", goal_id="a", decision_id="d", chosen_option="B",
           chosen_index=i) for i in (True, -1, 4, 0.5)),
])  # fmt: skip
def test_invalid_directive(raw: object) -> None:
    with pytest.raises(ValueError):
        parse_game_directive(raw)


@pytest.mark.parametrize(
    ("fields", "error"),
    [
        ({"goal_id": None}, "goal_mismatch"),
        ({"decision_id": "old"}, "decision_mismatch"),
        ({"chosen_index": 2}, "chosen_index out of range"),
        ({"chosen_index": True}, "chosen_index"),
        ({"chosen_option": "A"}, "option_mismatch"),
        ({"reason": None}, "expected str"),
        ({"extra": 1}, "key mismatch"),
    ],
)
def test_invalid_pending_directive(fields: dict[str, object], error: str) -> None:
    with pytest.raises(ValueError, match=error):
        parse_game_directive(
            {"command": "resolve_decision", "chosen_index": 1, **fields}, pending_decision=NEEDED
        )


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
async def agent(app: HostApp, vision: Vision, *, timeout: float = 6) -> AsyncGenerator[GameSession]:
    core = Core()  # Rejects every physical action block.
    config = GameSessionConfig(
        link_credentials=app.game_link.credentials, loop_config=LoopConfig(max_frame_age_s=30)
    )
    core.session = GameSession(core, Frames(), vision, PROFILE, config)
    run = asyncio.create_task(core.session.run())
    try:
        async with asyncio.timeout(timeout):
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


def assert_journaled_decision(app: HostApp, source: IntentSource) -> None:
    with closing(sqlite3.connect(app.config.db_path)) as db:
        assert db.execute("PRAGMA journal_mode").fetchone() == ("wal",)
        ((key,),) = db.execute("SELECT key FROM intents WHERE type='game.decision_resolved'")
    record = app.store.get_intent(key)
    assert record and record.source == source and record.capabilities == {"game.control"}
    assert record.state == "succeeded" and record.result == ev.CommandAck(True).to_dict()


async def test_operator_decision_and_highlight(studio: Studio) -> None:
    app, api = studio.app, studio.browser.api
    path = "/api/game/decision"
    assert (await api(path, {"chosen_index": 0}))[0] == 503
    vision = Vision((dict(WAIT, highlight="发现了岔路"), ASK, DONE))
    async with agent(app, vision), page(app.stage) as ws:
        app.safety.start_live()
        studio.model.parts = [
            json.dumps(dict(action="speak", text="前面有岔路。"), ensure_ascii=False)
        ]
        status, goal = await api("/api/game/goal", {"description": "查看路线"})
        assert status == 200 and goal["ok"]
        sid = await hear(ws, "前面有岔路。")
        context = studio.context()["game"]
        assert context["events"][0]["type"] == "highlight_observed"
        assert context["snapshot"]["active_goal_id"] == goal["goal_id"]
        studio.model.parts = ['{"action":"silence"}']
        await acknowledge(ws, sid)
        await until(lambda: app.game_link.pending_decision is not None)
        snap = (await api("/api/status"))[1]["game_link"]
        decision = snap["pending_decision"]
        assert decision["question"] == ASK["question"] and decision["options"] == ["A", "B"]
        assert snap["active_goal_id"] == goal["goal_id"] and snap["last_outcome"] is None
        assert snap["last_highlight"] == "发现了岔路"
        for invalid in (
            {},
            {"chosen_index": True},
            {"chosen_index": 2},
            {"chosen_index": 0.5},
            {"chosen_index": 0, "reason": None},
            {"chosen_index": 0, "decision_id": 1},
            {"chosen_index": 0, "chosen_option": "A"},
        ):
            assert (await api(path, invalid))[0] == 400
        args = {"chosen_index": 1, "decision_id": decision["decision_id"], "reason": "右侧"}
        assert (await api(path, dict(args, decision_id="old")))[1]["reason"] == "decision_mismatch"
        app.safety.pause_live(reason="test")
        assert (await api(path, args))[0] == 409
        app.safety.start_live()
        assert await api(path, args) == (200, {"ok": True, "reason": ""})
        await until(lambda: isinstance(app.game_link.last_event, ev.GoalCompleted))
        assert json.loads(vision.prompts[-1])["history"][-1]["summary"] == "Which route? -> B"
        assert app.game_link.pending_decision is None
        assert (await api(path, args))[1]["reason"] == "no_pending_decision"
        for index in (-1, 4, 99):
            assert (await api(path, {"chosen_index": index}))[0] == 400
        assert_journaled_decision(app, IntentSource.OPERATOR)


async def test_vote_end_during_safe_stop_expires_with_decision(studio: Studio) -> None:
    app = studio.app
    async with agent(app, Vision((ASK,))):
        app.safety.start_live()
        assert (await app.game.set_goal(ev.GoalSet("fork", "Choose a route"))).accepted
        await until(lambda: app.game_link.pending_decision is not None)
        app.safety.pause_live(reason="operator")
        app.director.notify_vote_ended()
        assert (await app.game.cancel_goal()).accepted
        await until(lambda: isinstance(app.game_link.last_event, ev.GoalStuck))
        assert app.game_link.pending_decision is None
        turns = len(studio.model.messages)
        app.safety.start_live()
        assert app.director.submit_danmaku("v", "viewer", "hello")
        await until(lambda: len(studio.model.messages) > turns)
        assert studio.context()["trigger"] == "danmaku"


@pytest.mark.parametrize(
    ("close", "ballots", "outcome"),
    [
        ("deadline", ["2"], "winner"),
        ("manual", ["2"], "winner"),
        ("manual", ["1", "2"], "tie"),
        ("manual", [], "none"),
    ],
)
async def test_vote_resolves_parked_decision(
    studio: Studio, monkeypatch: pytest.MonkeyPatch, close: str, ballots: list[str], outcome: str
) -> None:
    app, api, model = studio.app, studio.browser.api, studio.model
    vision = Vision((ASK, DONE))
    voting_turn, release_turn = asyncio.Event(), asyncio.Event()
    selected = 1 if outcome == "winner" else 0
    line = f"那就走{NEEDED.options[selected]}吧。"
    resolution_contexts: list[dict[str, Any]] = []

    async def respond_to_context(
        messages: Sequence[dict[str, str]], *, cancel: asyncio.Event | None = None
    ) -> AsyncIterator[str]:
        model.messages.append(messages)
        context = studio.context()
        game = context["game"]
        pending = game["snapshot"]["pending_decision"]
        if context["trigger"] == "vote_ended" and pending:
            resolution_contexts.append(context)
            winners = context["ended_vote"]["winners"]
            yield json.dumps(
                dict(
                    action="speak",
                    text=line,
                    game={
                        "command": "resolve_decision",
                        "chosen_index": winners[0] if winners else 0,
                    },
                ),
                ensure_ascii=False,
            )
        elif any(e["type"] == "decision_needed" for e in game["events"]):
            yield json.dumps(
                dict(
                    action="vote",
                    question=pending["question"],
                    options=pending["options"],
                    duration_s=10,
                )
            )
        else:
            if context["active_vote"] and close == "manual" and ballots:
                voting_turn.set()
                await release_turn.wait()
            yield '{"action":"silence"}'

    monkeypatch.setattr(model, "stream_chat", respond_to_context)
    async with agent(app, vision, timeout=18), page(app.stage) as ws:
        player = asyncio.create_task(Player().play(ws))
        try:
            app.safety.start_live()
            assert (await api("/api/game/goal", {"description": "查看岔路"}))[1]["ok"]
            await until(lambda: app.audience.active_vote() is not None)
            for i, ballot in enumerate(ballots):
                assert (
                    await api(
                        "/api/danmaku", dict(viewer_id=str(i), viewer_name="观众", text=ballot)
                    )
                )[1]["ok"]
            if close == "manual":
                if ballots:
                    await voting_turn.wait()
                assert (await api("/api/vote/close", {}))[1]["vote"]["outcome"] == outcome
                release_turn.set()
            else:
                await asyncio.wait_for(_wait_for_vote_close(app), 12)
            await until(lambda: isinstance(app.game_link.last_event, ev.GoalCompleted))
            await until(lambda: line in app.speech.recent_heard())
            (context,) = resolution_contexts
            assert context["game"]["snapshot"]["pending_decision"]["options"] == ["A", "B"]
            assert context["ended_vote"]["outcome"] == outcome and context["active_vote"] is None
            (record,) = json.loads(vision.prompts[-1])["history"]
            assert record["summary"] == f"Which route? -> {NEEDED.options[selected]}"
            assert app.game_link.pending_decision is None
            assert_journaled_decision(app, IntentSource.AGENT)
        finally:
            player.cancel()
            await asyncio.gather(player, return_exceptions=True)


async def _wait_for_vote_close(app: HostApp) -> None:
    while app.audience.active_vote() is not None:
        await asyncio.sleep(0.05)
