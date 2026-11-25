import asyncio
import json
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import bellis_host as host_api
import pytest
from websockets.asyncio.client import ClientConnection, connect
from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import InvalidStatus
from websockets.typing import Origin

type Host = tuple[host_api.HostStore, host_api.SafetyCore, host_api.StageServer]


async def packet(ws: ClientConnection | ServerConnection) -> dict[str, Any]:
    return json.loads(await asyncio.wait_for(ws.recv(), 2))


def link(stage: host_api.StageServer, origin: str | None = None) -> connect:
    host = f"127.0.0.1:{stage.port}"
    return connect(f"ws://{host}/stage", origin=Origin(origin or f"http://{host}"), proxy=None)


@asynccontextmanager
async def page(stage: host_api.StageServer) -> AsyncGenerator[ClientConnection]:
    token = stage.issue_stage_url().split("#t=")[1]
    assert len(token) == 22
    async with link(stage) as ws:
        await ws.send(json.dumps({"kind": "hello", "token": token}))
        assert (await packet(ws))["kind"] == "welcome"
        await stage.wait_connected(1)
        yield ws


@pytest.fixture
async def host() -> AsyncIterator[Host]:
    with host_api.HostStore(":memory:") as store:
        safety = host_api.SafetyCore(store)
        stage = host_api.StageServer(safety, host_api.StageConfig(heartbeat_interval_s=0.02))
        await stage.start()
        try:
            yield store, safety, stage
        finally:
            await stage.close()
            safety.close()


async def test_http_and_auth(host: Host) -> None:
    _, safety, stage = host
    urls = [urlsplit(stage.issue_stage_url()) for _ in range(2)]
    assert all(
        url.path == "/" and url.query.startswith("n=") and url.fragment.startswith("t=")
        for url in urls
    )
    assert urls[0].query != urls[1].query
    for path, status, marker in [
        ("/", 200, "subtitle-hidden"),
        ("/?n=abc12345", 200, "subtitle-hidden"),
        ("/worklet.js", 200, "registerProcessor"),
        ("/stage.css", 200, "visibility: hidden"),
        ("/missing?n=1", 404, "Not found"),
        ("/stage?x=1", 404, "Not found"),
    ]:
        reader, writer = await asyncio.open_connection("127.0.0.1", stage.port)
        writer.write(f"GET {path} HTTP/1.1\r\nHost: localhost:{stage.port}\r\n\r\n".encode())
        response = (await reader.read()).decode()
        writer.close()
        await writer.wait_closed()
        assert response.startswith(f"HTTP/1.1 {status} ")
        assert marker in response and "Cache-Control: no-store" in response
        assert (
            "X-Content-Type-Options: nosniff" in response and "frame-ancestors 'none'" in response
        )
    reader, writer = await asyncio.open_connection("127.0.0.1", stage.port)
    writer.write(b"GET / HTTP/1.1\r\nHost: example.org\r\n\r\n")
    assert b"403" in await reader.readline()
    writer.close()
    await writer.wait_closed()
    with pytest.raises(InvalidStatus) as rejected:
        await link(stage, "http://example.org")
    assert rejected.value.response.status_code == 403

    reauth = asyncio.Event()
    server = host_api.StageServer(safety, on_reauth_needed=reauth.set)
    await server.start()
    try:
        token = server.issue_stage_url().split("#t=")[1]
        async with link(server) as ws:
            await ws.send(json.dumps({"kind": "hello", "token": token}))
            key = (await packet(ws))["sessionKey"]
        async with link(server) as ws:
            await ws.send(json.dumps({"kind": "resume", "sessionKey": key}))
            assert (await packet(ws)) == {"kind": "welcome", "sessionKey": key}
        async with link(server) as ws:
            await ws.send(json.dumps({"kind": "hello", "token": token}))
            await ws.wait_closed()
            assert ws.close_code == 4401 and reauth.is_set()
    finally:
        await server.close()


async def test_stage_wire(host: Host) -> None:
    _, safety, stage = host
    events: asyncio.Queue[host_api.StageEvent] = asyncio.Queue()
    stage.on_event(events.put_nowait)
    safety.start_live()
    async with page(stage) as ws:
        assert (await packet(ws))["token"] is None
        assert (await packet(ws))["delayMs"] == 0
        assert (await packet(ws))["kind"] == "heartbeat"
        lease = await asyncio.to_thread(safety.grant_lease, "stage.audio", "speech")
        while (message := await packet(ws))["kind"] == "heartbeat":
            pass
        assert message == {"kind": "token", "token": lease.token, "ttlMs": 2000}
        await stage.send_audio("句", lease.token, b"\x00\x80")
        while isinstance(raw := await asyncio.wait_for(ws.recv(), 2), str):
            assert json.loads(raw)["kind"] == "heartbeat"
        size = int.from_bytes(raw[:2], "big")
        assert json.loads(raw[2 : 2 + size]) == {"sentenceId": "句", "token": lease.token}
        assert raw[2 + size :] == b"\x00\x80"
        for kind in (
            "started",
            "cursor",
            "underrun",
            "ended",
            "truncated",
            "muted",
            "heartbeat-ack",
        ):
            await ws.send(json.dumps({"kind": kind, "sentenceId": "句", "played": 10}))
            assert await asyncio.wait_for(events.get(), 1) == host_api.StageEvent(kind, "句", 10)
        await asyncio.to_thread(safety.revoke_lease, "stage.audio", "test")
        while (message := await packet(ws))["kind"] == "heartbeat":
            pass
        assert message["token"] is None and message["ttlMs"] == 0
        await ws.send('{"kind":"cursor","sentenceId":"bad","played":-1}')
        await ws.wait_closed()
        assert ws.close_code == 1007
    with pytest.raises(ValueError):
        host_api.encode_audio_frame("x", 1, b"x")


@pytest.mark.parametrize("cancel_task", [False, True])
async def test_minimax_stream(cancel_task: bool) -> None:
    sessions: list[str] = []
    issued = asyncio.Event()

    async def provider(ws: ServerConnection) -> None:
        assert ws.request and ws.request.headers["Authorization"] == "Bearer offline-key"
        sessions.append("open")
        await ws.send('{"event":"connected_success"}')
        start = await packet(ws)
        assert start["event"] == "task_start" and start["subtitle_enable"]
        assert start["subtitle_type"] == "word_streaming"
        assert start["audio_setting"] == {"sample_rate": 24000, "channel": 1, "format": "pcm"}
        await ws.send('{"event":"task_started"}')
        for text in ("first", "cancel", "last"):
            assert await packet(ws) == {"event": "task_continue", "text": text}
            assert await packet(ws) == {"event": "task_flush"}
            if text == "cancel":
                issued.set()
                assert await packet(ws) == {"event": "task_cancel"}
                await ws.send('{"event":"task_canceled"}')
            else:
                await ws.send('{"event":"task_continued","data":{"audio":"01"}}')
                await ws.send('{"event":"task_continued","data":{"audio":"000200"}}')
                await ws.send('{"event":"sentence_start"}')
                word = {"word": text, "time_begin": 0, "time_end": 5}
                sub = {"timestamped_words": [word]}
                await ws.send(json.dumps({"event": "task_continued", "data": {"subtitle": sub}}))
            await ws.send('{"event":"task_flushed"}')
        await ws.wait_closed()

    async with serve(provider, "127.0.0.1", 0) as server:
        url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"
        async with host_api.MiniMaxTtsClient(
            host_api.MinimaxConfig(endpoint=url), api_key="offline-key"
        ) as tts:

            async def collect(
                text: str, cancel: asyncio.Event | None = None
            ) -> list[host_api.TtsChunk]:
                return [c async for c in tts.synthesize(text, cancel=cancel)]

            for text in ("first", "cancel", "last"):
                if text != "cancel":
                    audio, words = await collect(text)
                    assert audio.pcm == bytes.fromhex("01000200")
                    assert words.words == (host_api.WordStamp(text, 2 / 24, 5 + 2 / 24),)
                else:
                    cancel = asyncio.Event()
                    task = asyncio.create_task(collect(text, cancel))
                    await asyncio.wait_for(issued.wait(), 1)
                    if cancel_task:
                        task.cancel()
                        with pytest.raises(asyncio.CancelledError):
                            await task
                    else:
                        cancel.set()
                        assert await task == []
        assert sessions == ["open"]


@pytest.mark.parametrize("code", [1002, 1004])
async def test_minimax_errors(code: int) -> None:
    secret = "sensitive-unit-test-key"

    async def reject(ws: ServerConnection) -> None:
        await ws.send(json.dumps({"base_resp": {"status_code": code, "status_msg": secret}}))

    async with serve(reject, "127.0.0.1", 0) as server:
        url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"
        async with host_api.MiniMaxTtsClient(
            host_api.MinimaxConfig(endpoint=url), api_key=secret
        ) as tts:
            with pytest.raises(host_api.TtsError) as error:
                await anext(tts.synthesize("test"))
            assert secret not in str(error.value)
            assert (error.value.auth, error.value.rate_limited) == (code == 1004, code == 1002)


def test_segment_and_cursor() -> None:
    seg = host_api.Segmenter()
    assert seg.push("大家") == []
    assert seg.push("好呀，") == ["大家好呀，"]
    assert seg.push("Next.尾") == ["Next."]
    assert seg.flush() == ["尾"]
    assert seg.push("字" * 61) == ["字" * 60]
    text = "“12”"
    spoken, align = host_api.speakable(text)
    assert (spoken, align) == ("一二", [1, 2])
    starts = host_api.subtitle_starts(
        spoken, align, 4, 1000, [host_api.WordStamp(spoken, 4, 12)], 16
    )
    assert starts == [4, 4, 8, 8]
    assert host_api.heard_prefix(text, starts, 7, 16) == ""
    assert host_api.heard_prefix(text, starts, 8, 16) == "“1"
    assert host_api.heard_prefix(text, starts, 16, 16) == text


class Voice:
    sample_rate = 1000

    def __init__(self) -> None:
        self.stalled = asyncio.Event()
        self.canceled = asyncio.Event()

    async def synthesize(
        self, text: str, *, cancel: asyncio.Event | None = None
    ) -> AsyncIterator[host_api.TtsChunk]:
        yield host_api.TtsChunk(bytes(200), self.sample_rate, (host_api.WordStamp(text, 0, 100),))
        if text == "abcd":
            assert cancel
            self.stalled.set()
            try:
                await cancel.wait()
            finally:
                if cancel.is_set():
                    self.canceled.set()


async def playback(ws: ClientConnection, cursor: asyncio.Event, truncated: asyncio.Event) -> None:
    sid = ""
    async for frame in ws:
        if isinstance(frame, bytes):
            await ws.send(json.dumps({"kind": "started", "sentenceId": sid}))
            await ws.send(json.dumps({"kind": "cursor", "sentenceId": sid, "played": 25}))
            cursor.set()
            continue
        m = json.loads(frame)
        if m["kind"] == "begin":
            sid = m["sentenceId"]
        elif m["kind"] in {"end", "truncate"}:
            end = m["kind"] == "end"
            reply = {"kind": "ended" if end else "truncated", "sentenceId": sid}
            await ws.send(json.dumps({**reply, "played": 100 if end else 50}))
            if not end:
                truncated.set()


@pytest.mark.parametrize("reason", ["hotkey", "lease_lost", "preempted"])
async def test_speech_lifecycle(host: Host, reason: str) -> None:
    store, safety, stage = host
    voice = Voice()
    arb = host_api.SpeechArbiter(safety, store, stage, voice, max_history=1)

    async def response() -> AsyncIterator[str]:
        yield "你好。"
        yield "22"

    try:
        async with page(stage) as ws:
            cursor, truncated = asyncio.Event(), asyncio.Event()
            reader = asyncio.create_task(playback(ws, cursor, truncated))
            assert (await arb.speak(host_api.SpeechRequest("safe", "hi"))).status == "denied"
            safety.start_live()
            bad = host_api.SpeechRequest("bad", "hi", source=host_api.IntentSource.UNTRUSTED)
            assert (await arb.speak(bad)).status == "denied"
            first = asyncio.create_task(arb.speak(host_api.SpeechRequest("low", "abcd")))
            await asyncio.wait_for(voice.stalled.wait(), 1)
            await asyncio.wait_for(cursor.wait(), 1)
            intent = store.get_intent("low")
            assert intent and intent.state is host_api.IntentState.EXECUTING
            if reason == "hotkey":
                await asyncio.to_thread(safety.trigger_emergency, reason)
                assert not safety.snapshot().active_leases
            elif reason == "lease_lost":
                await asyncio.to_thread(safety.revoke_lease, "stage.audio", reason)
                await asyncio.wait_for(voice.canceled.wait(), 0.3)
            else:
                req = host_api.SpeechRequest("high", response(), host_api.SpeechPriority.OPERATOR)
                outcome = await asyncio.wait_for(arb.speak(req), 2)
                assert (outcome.status, outcome.heard_text, outcome.full_text) == (
                    "completed",
                    "你好。22",
                    "你好。22",
                )
                record = store.get_intent("high")
                assert record and record.state is host_api.IntentState.SUCCEEDED
            low = await asyncio.wait_for(first, 1)
            assert low.status == "interrupted" and low.heard_text == "ab"
            assert low.reason == reason
            assert truncated.is_set() and voice.canceled.is_set()
            assert arb.recent_heard() == (("你好。22",) if reason == "preempted" else ("ab",))
            assert not safety.snapshot().active_leases
        await reader
    finally:
        await arb.close()


async def test_speech_restart(tmp_path: Path) -> None:
    path = tmp_path / "host.db"
    with host_api.HostStore(path) as store:
        record, _ = store.create_intent(
            "crashed",
            "speech.say",
            "stage.audio",
            {"reply_to": None},
            host_api.IntentSource.AGENT,
            {"speech.output"},
        )
        store.mark_executing(record.id)
    with host_api.HostStore(path) as store:
        safety = host_api.SafetyCore(store)
        safety.start_live()
        arb = host_api.SpeechArbiter(safety, store, host_api.StageServer(safety), Voice())
        assert store.recovered_intents[0].state is host_api.IntentState.UNKNOWN
        outcome = await arb.speak(host_api.SpeechRequest("crashed", "previous speech"))
        assert outcome.status == "denied" and not arb.recent_heard()
        await arb.close()
        safety.close()
