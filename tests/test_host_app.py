import asyncio
import json
import os
import subprocess
import sys
from collections.abc import AsyncIterator
from dataclasses import replace
from pathlib import Path

import pytest
from bellis_host import HostApp, HostConfig, HostMode, ObsError
from test_console_and_slow_agent import Browser, Model
from test_obs_and_watchdog import SCENE, ObsServer, assert_batch
from test_obs_and_watchdog import obs as obs
from test_obs_and_watchdog import watchdog_exe as watchdog_exe
from test_stage_and_speech import link, packet
from websockets.asyncio.client import ClientConnection
from websockets.asyncio.server import ServerConnection, serve

LINE = "欢迎来到直播间。"
PCM = bytes.fromhex("20001000") * 64


async def provider(ws: ServerConnection) -> None:
    assert ws.request and ws.request.headers["Authorization"] == "Bearer offline-tts"
    await ws.send('{"event":"connected_success"}')
    assert (await packet(ws))["event"] == "task_start"
    await ws.send('{"event":"task_started"}')
    assert (await packet(ws))["text"] == LINE
    assert await packet(ws) == {"event": "task_flush"}
    word = {"word": LINE, "time_begin": 0, "time_end": 4}
    data = {"audio": PCM.hex(), "subtitle": {"timestamped_words": [word]}}
    await ws.send(json.dumps({"event": "task_continued", "data": data}))
    await ws.send('{"event":"task_flushed"}')
    await ws.wait_closed()


async def play_sentence(ws: ClientConnection) -> None:
    token, sid = None, None
    frames: list[str] = []
    async with asyncio.timeout(5):
        async for raw in ws:
            if isinstance(raw, bytes):
                size = int.from_bytes(raw[:2], "big")
                assert json.loads(raw[2 : 2 + size]) == {"sentenceId": sid, "token": token}
                assert raw[2 + size :] == PCM
                frames.append("pcm")
                continue
            msg = json.loads(raw)
            kind = msg["kind"]
            if kind == "token" and msg["token"]:
                token = msg["token"]
            elif kind == "begin":
                assert token and msg["token"] == token and msg["subtitle"] == LINE
                sid = msg["sentenceId"]
            elif kind == "timing":
                assert msg["sentenceId"] == sid and len(msg["starts"]) == len(LINE)
            elif kind == "end":
                assert msg["sentenceId"] == sid and msg["token"] == token
                assert frames.index("begin") < frames.index("pcm")
                assert frames[-1] == "timing"
                await ws.send(
                    json.dumps({"kind": "ended", "sentenceId": sid, "played": len(PCM) // 2})
                )
                return
            frames.append(kind)
    pytest.fail("Stage disconnected before end")


@pytest.fixture
async def running(
    obs: ObsServer, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> AsyncIterator[tuple[HostApp, Browser]]:
    monkeypatch.setenv("BELLIS_MINIMAX_API_KEY", "offline-tts")
    monkeypatch.setenv("BELLIS_OBS_PASSWORD", "password")
    async with serve(provider, "127.0.0.1", 0) as server:
        cfg, model = HostConfig(), Model()
        model.parts = ['{"action":"speak","text":"', LINE + '"}']
        model.release.set()
        cfg = replace(
            cfg,
            db_path=tmp_path / "host.db",
            telemetry_path=tmp_path / "events.jsonl",
            enable_watchdog=False,
            obs=obs.config,
            stage=replace(cfg.stage, port=0),
            console=replace(cfg.console, port=0),
            director=replace(cfg.director, batch_window_s=0.01),
            tts=replace(cfg.tts, endpoint=f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"),
        )
        app = HostApp(cfg, llm=model)
        try:
            info = await app.start()
            browser = Browser(app.console)
            login = {"token": info.console_login_url.split("#token=")[1]}
            assert (await browser.api("/api/login", login))[0] == 200
            yield app, browser
        finally:
            await app.quiesce()
            await app.close()


async def test_danmaku_reaches_obs_stage(running: tuple[HostApp, Browser], obs: ObsServer) -> None:
    app, browser = running
    info = await app.start()
    assert {r["requestType"] for r in obs.calls[:2]} == {"GetSceneList", "GetInputList"}
    assert obs.calls[2]["requestType"] == "SetInputSettings"
    assert obs.calls[2]["requestData"]["inputSettings"]["url"] == info.stage_url
    async with link(app.stage) as ws:
        await ws.send(json.dumps({"kind": "hello", "token": info.stage_url.split("#t=")[1]}))
        assert (await packet(ws))["kind"] == "welcome"
        assert (await browser.api("/api/control/live", {}))[0] == 200
        data = {"viewer_id": "42", "viewer_name": "观众", "text": "大家好！"}
        assert await browser.api("/api/danmaku", data) == (200, {"ok": True})
        await play_sentence(ws)
        async with asyncio.timeout(3):
            while not (status := (await browser.api("/api/status"))[1])["recent_heard"]:
                await asyncio.sleep(0.01)
        assert status["recent_heard"] == [LINE] and status["stage_connected"]
    async with link(app.stage) as ws:
        await ws.send('{"kind":"resume","sessionKey":"expired"}')
        await ws.wait_closed()
        assert ws.close_code == 4401
    async with asyncio.timeout(2):
        while len(obs.calls) < 4:
            await asyncio.sleep(0.01)
    assert obs.calls[-1]["requestData"]["inputSettings"]["url"] != info.stage_url


async def test_emergency_sources(running: tuple[HostApp, Browser], obs: ObsServer) -> None:
    app, browser = running
    assert (await browser.api("/api/control/live", {}))[0] == 200
    assert (await browser.api("/api/control/emergency", {}))[0] == 200
    assert app.safety.snapshot().mode == HostMode.EMERGENCY_STOP
    assert_batch(obs)
    assert (await browser.api("/api/control/clear-emergency", {}))[0] == 200
    assert (await browser.api("/api/control/live", {}))[0] == 200
    await obs.event(SCENE, {"sceneName": "Safe"})
    assert app.obs
    await app.obs.preflight()
    assert app.safety.snapshot().emergency_reason == f"obs_external:{SCENE}"
    app.safety.record_watchdog_acted("heartbeat_lost")
    await app.obs.preflight()
    assert_batch(obs)
    obs.batch_seen.clear()
    await asyncio.to_thread(
        app.safety.trigger_emergency, "watchdog:operator-entered", source="host"
    )
    await asyncio.wait_for(obs.batch_seen.wait(), 2)
    assert len(obs.batches) == 2


async def test_close_drains_host_emergency(
    running: tuple[HostApp, Browser], obs: ObsServer
) -> None:
    app, _ = running
    app.safety.trigger_emergency("shutdown", source="host")
    await app.close()
    assert_batch(obs)


async def test_failed_start_releases_resources(
    obs: ObsServer, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("BELLIS_OBS_PASSWORD", "password")
    db = tmp_path / "host.db"
    app = HostApp(HostConfig(db_path=db, obs=obs.config), llm=Model())
    obs.scenes = []
    with pytest.raises(ObsError):
        await app.start()
    await asyncio.gather(app.close(), app.quiesce())
    db.unlink()
    assert not obs.batches


def test_config(tmp_path: Path) -> None:
    path = tmp_path / "host.toml"
    path.write_text(
        'db_path="state/test.db"\ntelemetry_path="spans.jsonl"\nenable_obs=false\n'
        "enable_watchdog=false\nwatchdog_heartbeat_s=0.1\nwatchdog_timeout_ms=550\n"
        '[obs]\nsafe_scene="Offline"\ncred_targets=["custom"]\n'
        '[stage]\nstatic_dir="assets"\n[console]\nport=0\n[tts]\nvoice_id="test"\n'
        "[director]\nbatch_window_s=0.5\n",
        encoding="utf-8",
    )
    cfg = HostConfig.from_toml(path)
    assert (
        cfg.db_path == tmp_path / "state/test.db" and cfg.telemetry_path == tmp_path / "spans.jsonl"
    )
    assert not cfg.enable_obs and not cfg.enable_watchdog
    assert cfg.watchdog_heartbeat_s == 0.1 and cfg.watchdog_timeout_ms == 550
    assert cfg.obs.safe_scene == "Offline" and cfg.obs.cred_targets == ("custom",)
    assert cfg.stage.port == 18765 and cfg.stage.static_dir == tmp_path / "assets"
    assert cfg.console.port == 0 and HostConfig().console.port == 18766
    assert cfg.tts.voice_id == "test" and cfg.director.batch_window_s == 0.5
    assert cfg.director.max_tokens == 2048
    path.write_text('[obs]\nstop_stream="false"\n', encoding="utf-8")
    with pytest.raises(ValueError, match="booleans"):
        HostConfig.from_toml(path)


async def test_live_siblings_after_host_crash(
    obs: ObsServer,
    tmp_path: Path,
    watchdog_exe: Path,
) -> None:
    assert watchdog_exe.is_file()
    config = tmp_path / "live.toml"
    config.write_text(f'[obs]\nurl="{obs.config.url}"\nstop_stream=true\n', encoding="utf-8")
    env = {**os.environ, "BELLIS_OBS_PASSWORD": "password", "BELLIS_VLM_API_KEY": "offline"}
    launcher = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "bellis_host.app",
        "live",
        "--config",
        str(config),
        "--db",
        str(tmp_path / "host.db"),
        "--stage-port",
        "0",
        "--console-port",
        "0",
        "--watchdog-timeout-ms",
        "30000",
        stdout=asyncio.subprocess.PIPE,
        env=env,
    )
    try:
        assert launcher.stdout
        async with asyncio.timeout(20):
            fields: dict[str, str] = {}
            while "Console Login URL" not in fields:
                line = await launcher.stdout.readline()
                assert line, "launcher exited before readiness"
                name, value = line.decode().strip().split(": ", 1)
                fields[name] = value
        host, watchdog = int(fields["Host PID"]), int(fields["Watchdog PID"])
        assert len({launcher.pid, host, watchdog}) == 3
        assert not obs.batches
        os.kill(host, 77)  # Windows reserves exit codes 0 and 1 for console signals.
        await asyncio.wait_for(obs.batch_seen.wait(), 4)
        assert await asyncio.wait_for(launcher.wait(), 8) == 77
        assert obs.identify[-1]["eventSubscriptions"] == 0
        assert_batch(obs)
    finally:
        if launcher.returncode is None:
            subprocess.run(["taskkill", "/PID", str(launcher.pid), "/T", "/F"], capture_output=True)
            await launcher.wait()
