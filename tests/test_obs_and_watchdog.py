import asyncio
import json
import os
import subprocess
from collections.abc import AsyncGenerator, AsyncIterator, Callable, Iterator
from contextlib import asynccontextmanager
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from bellis_common.channel import RpcPeer
from bellis_host import (
    HostMode,
    HostStore,
    ObsClient,
    ObsConfig,
    ObsError,
    SafetyCore,
    WatchdogLink,
    obs_auth_string,
    resolve_obs_password,
)
from bellis_host.watchdog import ENV_CHANNEL_KEY, ENV_CHANNEL_PATH, ENV_OBS_PASSWORD
from websockets.asyncio.server import ServerConnection, serve
from websockets.typing import Subprotocol

ROOT = Path(__file__).resolve().parents[1]
AUTH = "zTM5ki6L2vVvBQiTG9ckH1Lh64AbnCf6XZ226UmnkIA="
MUTE = "InputMuteStateChanged"
SCENE = "CurrentProgramSceneChanged"
type Packet = dict[str, Any]


class ObsServer:
    def __init__(self) -> None:
        self.config = ObsConfig(stop_stream=True)
        self.connections: list[ServerConnection] = []
        self.identify: list[Packet] = []
        self.calls: list[Packet] = []
        self.batches: list[Packet] = []
        self.challenge: Packet = {"authentication": {"salt": "salt", "challenge": "challenge"}}
        self.scenes: object = [{"sceneName": "Safe"}]
        self.inputs: object = [{"inputName": "浏览器"}]
        self.batch_seen = asyncio.Event()

    async def event(self, name: str, data: object) -> None:
        await self.connections[-1].send(
            json.dumps({"op": 5, "d": {"eventType": name, "eventData": data}})
        )

    async def handle(self, ws: ServerConnection) -> None:
        self.connections.append(ws)
        assert ws.subprotocol == "obswebsocket.json"
        await ws.send(json.dumps({"op": 0, "d": {"rpcVersion": 1, **self.challenge}}))
        identify = json.loads(await ws.recv())
        assert identify["op"] == 1
        self.identify.append(identify["d"])
        await ws.send(json.dumps({"op": 2, "d": {"negotiatedRpcVersion": 1}}))
        async for raw in ws:
            frame = json.loads(raw)
            op, data = frame["op"], frame["d"]
            if op == 6:
                reply = await self.execute(data)
            else:
                assert op == 8 and data["executionType"] == 0 and data["haltOnFailure"] is False
                self.batches.append(data)
                reply = {"results": [await self.execute(r) for r in data["requests"]]}
                self.batch_seen.set()
            await ws.send(
                json.dumps({"op": op + 1, "d": {"requestId": data["requestId"], **reply}})
            )

    async def execute(self, request: Packet) -> Packet:
        self.calls.append(request)
        name = request["requestType"]
        data = request.get("requestData", {})
        reply: Packet = {}
        if name == "GetSceneList":
            reply["scenes"] = self.scenes
        elif name == "GetInputList":
            reply["inputs"] = self.inputs
        elif name == "SetInputMute":
            await self.event(MUTE, data)
        elif name == "SetCurrentProgramScene":
            await self.event(SCENE, data)
        else:
            assert name in ("StopStream", "SetInputSettings")
        return {
            "requestType": name,
            "requestStatus": {
                "result": name != "StopStream",
                "code": 501 if name == "StopStream" else 100,
            },
            "responseData": reply,
        }


@pytest.fixture
async def obs() -> AsyncIterator[ObsServer]:
    obs = ObsServer()
    async with serve(
        obs.handle, "127.0.0.1", 0, subprotocols=[Subprotocol("obswebsocket.json")]
    ) as server:
        port = server.sockets[0].getsockname()[1]
        obs.config = replace(obs.config, url=f"ws://localhost:{port}")
        yield obs


@pytest.fixture
def safety() -> Iterator[SafetyCore]:
    with HostStore(":memory:") as store:
        core = SafetyCore(store)
        core.start_live()
        yield core
        core.close()


def test_credentials_and_loopback(monkeypatch: pytest.MonkeyPatch) -> None:
    assert obs_auth_string("password", "salt", "challenge") == AUTH
    config = ObsConfig(cred_targets=("unused", "obs.bellis"))
    monkeypatch.setenv(config.password_env, "env")
    assert resolve_obs_password(config, "") == ""
    assert resolve_obs_password(config) == "env"
    monkeypatch.delenv(config.password_env)
    monkeypatch.setattr("bellis_host.obs.read_secret_text", {"obs.bellis": "credential"}.get)
    assert resolve_obs_password(config) == "credential"
    assert resolve_obs_password(replace(config, cred_targets=())) == ""
    for url in (
        "wss://localhost:4455",
        "ws://example.org:4455",
        "ws://localhost:0",
        "ws://localhost:65536",
        "ws://localhost:4455@other",
        "ws://localhost:3/path",
    ):
        with pytest.raises(ValueError):
            ObsConfig(url=url)


def assert_batch(obs: ObsServer) -> None:
    assert len(obs.batches) == 1
    assert obs.batches[0]["requests"] == [
        {"requestType": "SetInputMute", "requestData": {"inputName": "浏览器", "inputMuted": True}},
        {"requestType": "SetCurrentProgramScene", "requestData": {"sceneName": "Safe"}},
        {"requestType": "StopStream"},
    ]


async def test_obs_controls_and_external_hotkeys(obs: ObsServer, safety: SafetyCore) -> None:
    async with ObsClient(
        obs.config, password="password", on_external_emergency=safety.reconcile_obs_external
    ) as client:
        assert obs.identify == [{"rpcVersion": 1, "eventSubscriptions": 12, "authentication": AUTH}]
        await obs.event(SCENE, None)
        await obs.event(MUTE, "malformed")
        await client.preflight()
        assert safety.snapshot().mode == HostMode.LIVE
        await client.set_stage_url("http://127.0.0.1/stage")
        assert obs.calls[-1]["requestData"] == {
            "inputName": "浏览器",
            "inputSettings": {"url": "http://127.0.0.1/stage"},
            "overlay": True,
        }
        await client.set_stage_muted(True)
        await client.set_stage_muted(False)
        outcome = await client.run_emergency()
        assert outcome.ok and outcome.results[-1].code == 501
        assert_batch(obs)
        assert safety.snapshot().mode == HostMode.LIVE
        for event, data in [
            (SCENE, {"sceneName": "Safe"}),
            (MUTE, {"inputName": "浏览器", "inputMuted": True}),
        ]:
            await obs.event(event, data)
            await client.preflight()  # Replies on this socket follow the hotkey event.
            snapshot = safety.snapshot()
            assert snapshot.mode == HostMode.EMERGENCY_STOP
            assert snapshot.emergency_reason == f"obs_external:{event}"
            safety.clear_emergency()
            safety.start_live()


@pytest.mark.parametrize("challenge", [{}, {"authentication": None}])
async def test_no_auth_and_preflight_validation(obs: ObsServer, challenge: Packet) -> None:
    obs.challenge = challenge
    async with ObsClient(obs.config) as client:
        assert "authentication" not in obs.identify[0]
        for obs.scenes, obs.inputs in [
            ([], []),
            ("Safe", []),
            ([{}], []),
            ([{"sceneName": "Safe"}], [42]),
        ]:
            with pytest.raises(ObsError):
                await client.preflight()


@pytest.fixture(scope="session")
def watchdog_exe() -> Path:
    # Cargo's incremental build also refreshes a stale executable.
    subprocess.run(
        [
            "cargo",
            "build",
            "--offline",
            "--manifest-path",
            "core/Cargo.toml",
            "-p",
            "bellis-watchdog",
        ],
        cwd=ROOT,
        check=True,
    )
    return ROOT / "core/target/debug/bellis-watchdog.exe"


@asynccontextmanager
async def watchdog(
    exe: Path, obs: ObsServer, link: WatchdogLink, timeout_ms: int
) -> AsyncGenerator[asyncio.subprocess.Process]:
    await link.start()
    env = {k: os.environ[k] for k in ("SYSTEMROOT", "TEMP", "TMP") if k in os.environ}
    env.update(
        {
            ENV_CHANNEL_PATH: link.credentials.path,
            ENV_CHANNEL_KEY: link.credentials.encoded_key,
            ENV_OBS_PASSWORD: "password",
        }
    )
    proc = await asyncio.create_subprocess_exec(
        str(exe),
        "--obs-url",
        obs.config.url,
        "--heartbeat-timeout-ms",
        str(timeout_ms),
        "--reconnect-delay-ms",
        "40",
        "--exit-on-stop",
        "--stop-stream",
        env=env,
    )
    try:
        await link.wait_connected(5)
        yield proc
    finally:
        await link.close()
        try:
            await asyncio.wait_for(proc.wait(), 3)
        except TimeoutError:
            proc.kill()
            await proc.wait()


@pytest.fixture
def reports(monkeypatch: pytest.MonkeyPatch) -> asyncio.Queue[Packet]:
    received: asyncio.Queue[Packet] = asyncio.Queue()
    register = RpcPeer.on_notification

    def capture(
        peer: RpcPeer, method: str, handler: Callable[[Packet], None]
    ) -> Callable[[], None]:
        def observe(data: Packet) -> None:
            handler(data)
            received.put_nowait(data)

        return register(peer, method, observe if method == "watchdog.acted" else handler)

    monkeypatch.setattr(RpcPeer, "on_notification", capture)
    return received


async def test_live_heartbeats_and_planned_exit(
    watchdog_exe: Path, obs: ObsServer, safety: SafetyCore
) -> None:
    link = WatchdogLink(safety, heartbeat_interval_s=0.04)
    async with watchdog(watchdog_exe, obs, link, 400) as proc:
        await asyncio.sleep(1.25)
        assert link.connected and proc.returncode is None and not obs.connections
        await link.close(planned=True)
        assert await asyncio.wait_for(proc.wait(), 3) == 0
        assert not obs.connections and safety.snapshot().mode == HostMode.LIVE


async def test_planned_close_after_watchdog_dies(
    watchdog_exe: Path, obs: ObsServer, safety: SafetyCore
) -> None:
    link = WatchdogLink(safety)
    async with watchdog(watchdog_exe, obs, link, 1000) as proc:
        proc.kill()
        # Begin teardown before the Host reader gets a turn to observe EOF.
        await link.close(planned=True)
        assert not link.connected


async def test_starvation_latches_and_reports_once(
    watchdog_exe: Path, obs: ObsServer, safety: SafetyCore, reports: asyncio.Queue[Packet]
) -> None:
    link = WatchdogLink(safety, heartbeat_interval_s=30)
    async with watchdog(watchdog_exe, obs, link, 150):
        report = await asyncio.wait_for(reports.get(), 5)
        assert report["reason"] == "heartbeat_lost" and report["ok"] is True
        assert report["acted_at_ms"] > 0
        assert obs.identify == [{"rpcVersion": 1, "eventSubscriptions": 0, "authentication": AUTH}]
        snapshot = safety.snapshot()
        assert snapshot.mode == HostMode.EMERGENCY_STOP and snapshot.watchdog_acted
        assert snapshot.emergency_reason == "watchdog:heartbeat_lost"
        await asyncio.sleep(0.4)
        assert_batch(obs)
        assert reports.empty()


async def test_unplanned_disconnect_reports_on_reconnect(
    watchdog_exe: Path, obs: ObsServer, safety: SafetyCore, reports: asyncio.Queue[Packet]
) -> None:
    obs.challenge = {"authentication": None}
    link = WatchdogLink(safety)
    async with watchdog(watchdog_exe, obs, link, 1000) as proc:
        await link.close(planned=False)
        await asyncio.wait_for(obs.batch_seen.wait(), 5)
        await link.start()
        report = await asyncio.wait_for(reports.get(), 5)
        assert report["reason"] == "connection_lost" and report["ok"] is True
        assert safety.snapshot().emergency_reason == "watchdog:connection_lost"
        assert obs.identify == [{"rpcVersion": 1, "eventSubscriptions": 0}]
        await link.close(planned=True)
        assert await asyncio.wait_for(proc.wait(), 3) == 0
        assert_batch(obs)
