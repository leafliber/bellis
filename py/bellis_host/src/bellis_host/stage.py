"""Loopback OBS browser source and its fenced media transport."""

import asyncio
import hmac
import json
import math
import secrets
from collections.abc import Callable, Sequence
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from websockets.asyncio.server import Server, ServerConnection, serve
from websockets.exceptions import ConnectionClosed
from websockets.http11 import Request, Response

from .safety import Lease, LeaseUpdate, SafetyCore

_ASSETS = {"index.html", "stage.css", "page.js", "audio.js", "subtitle.js", "worklet.js"}
_CURSORS = {"cursor", "underrun", "ended", "truncated"}
_EVENTS = _CURSORS | {"started", "muted", "heartbeat-ack"}


def _delay(ms: int) -> None:
    if type(ms) is not int or not 0 <= ms <= 300:
        raise ValueError("invalid presentation delay")


@dataclass(frozen=True)
class StageConfig:
    host: str = "127.0.0.1"
    port: int = 0
    heartbeat_interval_s: float = 0.25
    presentation_delay_ms: int = 0
    static_dir: Path | None = None

    def __post_init__(self) -> None:
        if self.host != "127.0.0.1" or type(self.port) is not int or not 0 <= self.port <= 65535:
            raise ValueError("expected IPv4 loopback and valid port")
        if not 0 < self.heartbeat_interval_s < math.inf:
            raise ValueError("invalid heartbeat interval")
        _delay(self.presentation_delay_ms)


@dataclass(frozen=True)
class StageEvent:
    kind: str
    sentence_id: str | None = None
    played: int = 0
    reason: str = ""


def encode_audio_frame(sentence_id: str, token: int, pcm: bytes) -> bytes:
    if len(pcm) % 2:
        raise ValueError("unaligned PCM")
    header = json.dumps(
        {"sentenceId": sentence_id, "token": token}, ensure_ascii=False, separators=(",", ":")
    ).encode()
    return len(header).to_bytes(2, "big") + header + pcm


def _object(frame: str | bytes) -> dict[str, object]:
    data = json.loads(frame)
    if not isinstance(frame, str) or not isinstance(data, dict):
        raise ValueError("expected Stage JSON object")
    return cast(dict[str, object], data)


def _matches(candidate: object, secret: str | None) -> bool:
    return bool(
        secret
        and isinstance(candidate, str)
        and candidate.isascii()
        and hmac.compare_digest(candidate, secret)
    )


class StageServer:
    def __init__(
        self,
        safety: SafetyCore,
        config: StageConfig = StageConfig(),
        *,
        on_event: Callable[[StageEvent], None] | None = None,
        on_reauth_needed: Callable[[], None] | None = None,
    ) -> None:
        self._safety, self.config = safety, config
        self._dir = config.static_dir or Path(__file__).resolve().parents[4] / "web" / "stage"
        self._events = [on_event] if on_event else list[Callable[[StageEvent], None]]()
        self._reauth = on_reauth_needed
        self._server: Server | None = None
        self._ws: ServerConnection | None = None
        self._token: str | None = None
        self._session: str | None = None
        self._ready = asyncio.Event()
        self._changed = asyncio.Event()
        self._sent: Lease | None = None
        self._unsubscribe: Callable[[], None] | None = None
        self._delay = config.presentation_delay_ms

    @property
    def port(self) -> int:
        if self._server is None:
            raise RuntimeError("Stage is stopped")
        return int(self._server.sockets[0].getsockname()[1])

    @property
    def connected(self) -> bool:
        return self._ready.is_set()

    def issue_stage_url(self) -> str:
        self._token = secrets.token_urlsafe(16)
        return f"http://127.0.0.1:{self.port}/#t={self._token}"

    def on_event(self, cb: Callable[[StageEvent], None]) -> Callable[[], None]:
        self._events.append(cb)
        return lambda: self._events.remove(cb)

    def _emit(self, event: StageEvent) -> None:
        for callback in tuple(self._events):
            callback(event)

    async def wait_connected(self, timeout: float) -> None:
        await asyncio.wait_for(self._ready.wait(), timeout)

    async def start(self) -> None:
        if self._server:
            return
        loop = asyncio.get_running_loop()

        def update(change: LeaseUpdate) -> None:
            if change.resource == "stage.audio":
                loop.call_soon_threadsafe(self._changed.set)

        self._server = await serve(
            self._handle,
            self.config.host,
            self.config.port,
            process_request=self._http,
            process_response=self._headers,
            max_size=8192,
            server_header=None,
        )
        self._unsubscribe = self._safety.on_lease_update(update)

    def _http(self, ws: ServerConnection, req: Request) -> Response | None:
        hosts = (f"127.0.0.1:{self.port}", f"localhost:{self.port}")
        if req.headers.get_all("Host") not in ([h] for h in hosts):
            return ws.respond(403, "Forbidden")
        if req.path == "/stage":
            if req.headers.get_all("Origin") not in (["http://" + h] for h in hosts):
                return ws.respond(403, "Forbidden")
            return None
        name = "index.html" if req.path == "/" else req.path.removeprefix("/")
        if name not in _ASSETS:
            return ws.respond(404, "Not found")
        try:
            response = ws.respond(200, (self._dir / name).read_text(encoding="utf-8"))
        except OSError:
            return ws.respond(404, "Not found")
        mime = {"css": "text/css", "js": "text/javascript", "html": "text/html"}
        del response.headers["Content-Type"]
        response.headers["Content-Type"] = mime[name.split(".")[-1]] + "; charset=utf-8"
        return response

    def _headers(self, ws: ServerConnection, req: Request, response: Response) -> Response:
        response.headers["Content-Security-Policy"] = (
            f"default-src 'self'; connect-src 'self' ws://127.0.0.1:{self.port} "
            f"ws://localhost:{self.port}; frame-ancestors 'none'"
        )
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Cache-Control"] = "no-store"
        return response

    async def _sync(self, ws: ServerConnection, *, force: bool = False) -> None:
        lease = next(
            (
                item
                for item in self._safety.snapshot().active_leases
                if item.resource == "stage.audio"
            ),
            None,
        )
        if force or self._sent != lease:
            self._sent = lease
            token = lease.token if lease else None
            ttl = int(lease.ttl_s * 1000) if lease else 0
            await ws.send(json.dumps({"kind": "token", "token": token, "ttlMs": ttl}))

    async def _heartbeat(self, ws: ServerConnection) -> None:
        loop = asyncio.get_running_loop()
        due = loop.time()
        while self._ws is ws:
            self._changed.clear()
            await self._sync(ws)
            if loop.time() >= due:
                await ws.send('{"kind":"heartbeat"}')
                due = loop.time() + self.config.heartbeat_interval_s
            with suppress(TimeoutError):
                await asyncio.wait_for(self._changed.wait(), max(0, due - loop.time()))

    async def _handle(self, ws: ServerConnection) -> None:
        pulse = None
        try:
            hello = _object(await asyncio.wait_for(ws.recv(), 5))
            if hello.get("kind") == "hello" and _matches(hello.get("token"), self._token):
                self._token, self._session = None, secrets.token_urlsafe(32)
            elif hello.get("kind") != "resume" or not _matches(
                hello.get("sessionKey"), self._session
            ):
                if self._reauth:
                    self._reauth()
                await ws.close(4401, "Stage authentication required")
                return
            elif self._ws:
                await ws.close(4408, "Stage session in use")
                return
            old, self._ws = self._ws, ws
            if old:
                self._ready.clear()
                self._emit(StageEvent("muted", reason="stage_replaced"))
                await old.close(4408)
                if self._ws is not ws:
                    return
            await ws.send(json.dumps({"kind": "welcome", "sessionKey": self._session}))
            await self._sync(ws, force=True)
            await ws.send(json.dumps({"kind": "presentation", "delayMs": self._delay}))
            self._ready.set()
            pulse = asyncio.create_task(self._heartbeat(ws))
            async for raw in ws:
                if self._ws is not ws:
                    break
                msg = _object(raw)
                kind, sid = msg.get("kind"), msg.get("sentenceId")
                played, reason = msg.get("played", 0), msg.get("reason", "")
                if (
                    not isinstance(kind, str)
                    or kind not in _EVENTS
                    or type(played) is not int
                    or played < 0
                    or (kind in _CURSORS and "played" not in msg)
                    or not isinstance(reason, str)
                    or (sid is not None and not isinstance(sid, str))
                    or (kind not in {"muted", "heartbeat-ack"} and not sid)
                ):
                    raise ValueError("invalid Stage report")
                self._emit(StageEvent(kind, sid, played, reason))
        except ConnectionClosed:
            pass
        except TimeoutError:
            await ws.close(4408)
        except (ValueError, RecursionError):
            if self._ws is not ws and self._reauth:
                self._reauth()
            await ws.close(4401 if self._ws is not ws else 1007)
        finally:
            if self._ws is ws:
                self._ready.clear()
                self._ws = None
                self._emit(StageEvent("muted", reason="stage_disconnected"))
            if pulse:
                pulse.cancel()
                await asyncio.gather(pulse, return_exceptions=True)

    async def _media(self, token: int, frame: bytes | str) -> None:
        ws = self._ws
        if ws is None or not self.connected:
            raise RuntimeError("Stage is disconnected")
        await self._sync(ws)
        if not self._safety.is_lease_valid("stage.audio", token):
            raise RuntimeError("Stage lease lost")
        await ws.send(frame)

    async def begin_sentence(self, sentence_id: str, token: int, subtitle: str, sample_rate: int):
        packet = {
            "kind": "begin",
            "sentenceId": sentence_id,
            "token": token,
            "subtitle": subtitle,
            "sampleRate": sample_rate,
        }
        await self._media(token, json.dumps(packet))

    async def send_audio(self, sentence_id: str, token: int, pcm: bytes) -> None:
        await self._media(token, encode_audio_frame(sentence_id, token, pcm))

    async def send_timing(self, sentence_id: str, token: int, starts: Sequence[int]) -> None:
        packet = {
            "kind": "timing",
            "sentenceId": sentence_id,
            "token": token,
            "starts": list(starts),
        }
        await self._media(token, json.dumps(packet))

    async def end_sentence(self, sentence_id: str, token: int) -> None:
        await self._media(
            token, json.dumps({"kind": "end", "sentenceId": sentence_id, "token": token})
        )

    async def truncate_sentence(self, sentence_id: str) -> None:
        if self._ws:
            await self._ws.send(json.dumps({"kind": "truncate", "sentenceId": sentence_id}))

    async def set_presentation_delay(self, delay_ms: int) -> None:
        _delay(delay_ms)
        self._delay = delay_ms
        if self._ws:
            await self._ws.send(json.dumps({"kind": "presentation", "delayMs": delay_ms}))

    async def close(self) -> None:
        if self._server:
            self._server.close()
            await self._server.wait_closed()
            self._server = None
        if self._unsubscribe:
            self._unsubscribe()
            self._unsubscribe = None
        self._token = self._session = None
