"""Loopback operator HTTP console. Manual say waits for its own playback outcome."""

import asyncio
import hmac
import json
import math
import re
import secrets
import time
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import asdict, dataclass
from http import HTTPStatus
from http.cookies import CookieError, SimpleCookie
from pathlib import Path
from typing import cast
from uuid import uuid4

from bellis_common.agent_events import GoalSet
from bellis_common.channel import ChannelError

from .audience import AudienceHub, VoteSnapshot
from .director import SlowDirector
from .game_control import GameController, parse_game_directive
from .game_permit import HostGamePermit
from .safety import SafetyCore, SafetyError
from .speech import SpeechArbiter, SpeechPriority, SpeechRequest
from .stage import StageServer
from .store import IntentSource

_ASSETS = {
    "/": ("index.html", "text/html"),
    "/index.html": ("index.html", "text/html"),
    "/console.js": ("console.js", "text/javascript"),
    "/console.css": ("console.css", "text/css"),
}
_COOKIE = "bellis_console"
_FLAGS = "; HttpOnly; SameSite=Strict; Path=/"
_JSON_TYPE = re.compile(r'application/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?', re.I)
type Data = dict[str, object]


@dataclass(frozen=True)
class ConsoleConfig:
    host: str = "127.0.0.1"
    port: int = 0
    session_ttl_s: float = 43200.0
    static_dir: Path | None = None

    def __post_init__(self) -> None:
        if self.host != "127.0.0.1" or type(self.port) is not int or not 0 <= self.port <= 65535:
            raise ValueError("expected IPv4 loopback and valid port")
        if not 0 < self.session_ttl_s < math.inf:
            raise ValueError("expected finite positive session TTL")


class _HttpError(Exception):
    def __init__(self, status: int):
        self.status = status


def _matches(value: object, secret: str | None) -> bool:
    return bool(
        secret and isinstance(value, str) and value.isascii() and hmac.compare_digest(value, secret)
    )


def _string(data: Data, key: str, default: str = "") -> str:
    value = data.get(key, default)
    if not isinstance(value, str) or not value.strip():
        raise ValueError("expected non-empty text")
    value.encode("utf-8")
    return value


class ConsoleServer:
    def __init__(
        self,
        safety: SafetyCore,
        *,
        stage: StageServer | None = None,
        speech: SpeechArbiter | None = None,
        audience: AudienceHub | None = None,
        director: SlowDirector | None = None,
        game_permit: HostGamePermit | None = None,
        game: GameController | None = None,
        on_emergency_obs: Callable[[], Awaitable[object]] | None = None,
        config: ConsoleConfig = ConsoleConfig(),
    ):
        self.game_permit = game_permit
        self.game = game
        self.safety, self.director = safety, director
        self.speech = speech or (director and director.speech)
        self.stage = stage or (self.speech and self.speech.stage)
        self.audience = audience or (director and director.audience)
        self._obs, self.config = on_emergency_obs, config
        self._dir = config.static_dir or Path(__file__).resolve().parents[4] / "web" / "console"
        self._server: asyncio.Server | None = None
        self._token: str | None = None
        self._sessions: dict[str, tuple[str, float]] = {}
        self._tasks: set[asyncio.Task[None]] = set()

    @property
    def port(self) -> int:
        if self._server is None:
            raise RuntimeError("console is stopped")
        return int(self._server.sockets[0].getsockname()[1])

    def issue_login_url(self) -> str:
        self._token = secrets.token_urlsafe(32)
        return f"http://127.0.0.1:{self.port}/#token={self._token}"

    async def start(self) -> None:
        if not self._server:
            self._server = await asyncio.start_server(
                self._handle, self.config.host, self.config.port, limit=16384
            )

    async def _read(self, reader: asyncio.StreamReader) -> tuple[str, str, dict[str, str], Data]:
        block = (await reader.readuntil(b"\r\n\r\n"))[:-4].decode("ascii")
        line, *lines = block.split("\r\n")
        match = re.fullmatch(r"(GET|POST) (/[\x21-\x7e]*) HTTP/1\.1", line)
        if not match:
            raise _HttpError(400)
        method, path = match.groups()
        headers: dict[str, str] = {}
        for line in lines:
            match = re.fullmatch(r"([!#$%&'*+.^_|\x60~A-Za-z0-9-]+):[ \t]*([\x20-\x7e\t]*)", line)
            if not match or match[1].lower() in headers:
                raise _HttpError(400)
            headers[match[1].lower()] = match[2].strip()
        host = headers.get("host")
        if host not in (f"127.0.0.1:{self.port}", f"localhost:{self.port}"):
            raise _HttpError(403)
        length = headers.get("content-length", "0")
        if "transfer-encoding" in headers or not re.fullmatch("[0-9]+", length):
            raise _HttpError(400)
        if len(length) > 6 or int(length) > 65536:
            raise _HttpError(413)
        if method == "GET":
            if int(length):
                raise _HttpError(400)
            return method, path, headers, {}
        if headers.get("origin") != f"http://{host}":
            raise _HttpError(403)
        if not _JSON_TYPE.fullmatch(headers.get("content-type", "")):
            raise _HttpError(415)
        if "content-length" not in headers:
            raise _HttpError(411)
        obj = json.loads((await reader.readexactly(int(length))).decode("utf-8"))
        if not isinstance(obj, dict):
            raise _HttpError(400)
        return method, path, headers, cast(Data, obj)

    def _auth(
        self, path: str, method: str, headers: dict[str, str], data: Data, response: dict[str, str]
    ) -> Data | None:
        if path == "/api/login" and method == "POST":
            if not _matches(data.get("token"), self._token):
                raise _HttpError(401)
            self._token = None
            sid, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            now = time.monotonic()
            self._sessions = {k: v for k, v in self._sessions.items() if v[1] > now}
            self._sessions[sid] = csrf, now + self.config.session_ttl_s
            response["Set-Cookie"] = f"{_COOKIE}={sid}{_FLAGS}"
            return {"ok": True, "csrf": csrf}
        cookie = SimpleCookie()
        with suppress(CookieError):
            cookie.load(headers.get("cookie", ""))
        sid = cookie[_COOKIE].value if _COOKIE in cookie else ""
        session = self._sessions.get(sid)
        if not session or session[1] <= time.monotonic():
            self._sessions.pop(sid, None)
            raise _HttpError(401)
        if method == "POST" and not _matches(headers.get("x-bellis-csrf"), session[0]):
            raise _HttpError(403)
        if method == "POST" and path == "/api/logout":
            del self._sessions[sid]
            response["Set-Cookie"] = f"{_COOKIE}=; Max-Age=0{_FLAGS}"
            return {"ok": True}
        if method == "GET" and path == "/api/status":
            response["X-Bellis-Csrf"] = session[0]
        return None

    async def _say(self, text: str) -> Data:
        if not self.speech:
            raise _HttpError(503)
        req = SpeechRequest(
            uuid4().hex, text, SpeechPriority.OPERATOR, IntentSource.OPERATOR, holder="operator"
        )
        return asdict(await self.speech.speak(req))

    async def _end_vote(self, vote: VoteSnapshot) -> None:
        if self.audience and (end := await self.audience.close_at_deadline(vote)) and self.speech:
            await self._say(end[1])
            if self.director:
                self.director.notify_vote_ended()

    async def _api(self, method: str, path: str, data: Data) -> Data:
        if method == "GET" and path == "/api/status":
            vote = self.audience and self.audience.active_vote()
            return {
                **asdict(self.safety.snapshot()),
                "game_permit": asdict(self.game_permit.snapshot()) if self.game_permit else None,
                "game_link": asdict(self.game.link.snapshot()) if self.game else None,
                "game_objective": self.game.objective_snapshot() if self.game else None,
                "stage_connected": bool(self.stage and self.stage.connected),
                "pending_danmaku": self.audience.pending_count() if self.audience else 0,
                "active_vote": vote and asdict(vote),
                "recent_heard": self.speech.recent_heard() if self.speech else (),
            }
        if method != "POST":
            raise _HttpError(405)
        controls = self.director or self.speech
        if path in {"/api/game/arm", "/api/game/disarm"}:
            if self.game_permit is None:
                raise _HttpError(503)
            if path == "/api/game/arm":
                try:
                    token = await self.game_permit.arm_input(actor="operator")
                except ChannelError:
                    raise _HttpError(503) from None
            else:
                token = await self.game_permit.disarm_input(
                    reason=_string(data, "reason", "operator_disarm")
                )
            return {"ok": True, "token": token}
        if path == "/api/game/auto-resume":
            if self.game_permit is None:
                raise _HttpError(503)
            if data.keys() - {"enabled", "idle_s"}:
                raise _HttpError(400)
            enabled = data.get("enabled")
            raw_idle = data.get("idle_s")
            if type(enabled) is not bool:
                raise _HttpError(400)
            idle_s: float | None = None
            if raw_idle is not None:
                if type(raw_idle) is int or type(raw_idle) is float:
                    idle_s = float(raw_idle)
                else:
                    raise _HttpError(400)
            active, wait_s = self.game_permit.set_auto_resume(enabled, idle_s=idle_s)
            return {"ok": True, "auto_resume": active, "auto_resume_idle_s": wait_s}
        if path == "/api/game/decision":
            if self.game is None:
                raise _HttpError(503)
            index, reason = data.get("chosen_index"), data.get("reason", "")
            if (
                data.keys() - {"chosen_index", "decision_id", "reason"}
                or type(index) is not int
                or not isinstance(reason, str)
            ):
                raise _HttpError(400)
            decision_id = _string(data, "decision_id") if "decision_id" in data else None
            reason.encode("utf-8")
            try:
                ack = await self.game.resolve_decision(
                    index,
                    decision_id=decision_id,
                    reason=reason,
                    source=IntentSource.OPERATOR,
                    holder="operator",
                )
            except ChannelError:
                raise _HttpError(503) from None
            return {"ok": ack.accepted, "reason": ack.reason}
        if path in {"/api/game/goal", "/api/game/cancel", "/api/game/pause", "/api/game/resume"}:
            return await self._game_command(path.rsplit("/", 1)[1], data)
        if path == "/api/game/objective":
            if self.game is None:
                raise _HttpError(503)
            if data.keys() - {"description", "auto_continue", "max_auto_steps", "clear"}:
                raise _HttpError(400)
            desc = data.get("description", "")
            if data.get("clear") is True or (isinstance(desc, str) and not desc.strip()):
                self.game.clear_objective()
                return {"ok": True, "objective": None}
            auto_continue = data.get("auto_continue", True)
            max_auto = data.get("max_auto_steps", 12)
            if type(auto_continue) is not bool or type(max_auto) is not int:
                raise _HttpError(400)
            obj = self.game.set_objective(
                _string(data, "description"),
                auto_continue=auto_continue,
                max_auto_steps=max_auto,
            )
            return {"ok": True, "objective": asdict(obj)}
        if path == "/api/control/live":
            self.safety.start_live(actor="operator")
        elif path == "/api/control/pause":
            reason = _string(data, "reason", "operator_pause")
            self.safety.pause_live(reason=reason)
            if controls:
                controls.interrupt(reason)
            if self.game:
                await self.game.cancel_for_stop(reason)
        elif path == "/api/control/emergency":
            reason = _string(data, "reason", "operator_emergency")
            self.safety.trigger_emergency(reason, source="operator")
            stops: list[Awaitable[object]] = []
            if self._obs:
                stops.append(self._obs())
            if self.game_permit:
                stops.append(self.game_permit.emergency_stop())
            if self.game:
                stops.append(self.game.cancel_for_stop(reason))
            results = await asyncio.gather(*stops, return_exceptions=True)
            if any(isinstance(result, BaseException) for result in results):
                raise _HttpError(502)
        elif path == "/api/control/clear-emergency":
            self.safety.clear_emergency(actor="operator")
        elif path == "/api/speech/say":
            return await self._say(_string(data, "text"))
        elif path == "/api/speech/interrupt" and controls:
            controls.interrupt(_string(data, "reason", "operator_interrupt"))
        elif path == "/api/danmaku" and (self.director or self.audience):
            args = tuple(_string(data, key) for key in ("viewer_id", "viewer_name", "text"))
            if self.director:
                accepted = self.director.submit_danmaku(*args)
            else:
                assert self.audience
                accepted = self.audience.ingest(*args)
            return {"ok": accepted}
        elif path in {"/api/vote/start", "/api/vote/close"} and self.audience:
            if path.endswith("/start"):
                vote, line = self.audience.start_vote_fields(
                    data, holder="operator", source=IntentSource.OPERATOR
                )
                timer = asyncio.create_task(self._end_vote(vote))
                self._tasks.add(timer)
                timer.add_done_callback(self._tasks.discard)
            else:
                if not (end := self.audience.close_vote()):
                    raise _HttpError(409)
                vote, line = end
            if self.speech:
                await self._say(line)
            if self.director and path == "/api/vote/close":
                self.director.notify_vote_ended()
            return {"ok": True, "vote": asdict(vote)}
        else:
            raise _HttpError(404)
        return {"ok": True}

    async def _game_command(self, action: str, data: Data) -> Data:
        if self.game is None:
            raise _HttpError(503)
        if action == "goal":
            if data.keys() - {"description", "max_steps", "timeout_s"}:
                raise _HttpError(400)
            command = parse_game_directive({"command": "set_goal", **data})
        else:
            if data.keys() - {"reason"}:
                raise _HttpError(400)
            name = {"cancel": "cancel_goal", "pause": "pause_pacing", "resume": "resume_pacing"}
            command = parse_game_directive(
                {"command": name[action], "reason": data.get("reason", f"operator_{action}")}
            )
        try:
            ack = await self.game.dispatch(command, source=IntentSource.OPERATOR, holder="operator")
        except ChannelError:
            raise _HttpError(503) from None
        result: Data = {"ok": ack.accepted, "reason": ack.reason}
        if isinstance(command, GoalSet):
            result["goal_id"] = command.goal_id
        return result

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.current_task()
        assert task is not None
        self._tasks.add(task)
        try:
            status, mime, body = 200, "application/json", b""
            extra: dict[str, str] = {}
            try:
                async with asyncio.timeout(5):
                    method, path, headers, data = await self._read(reader)
                if path.startswith("/api/"):
                    result = self._auth(path, method, headers, data, extra)
                    if result is None:
                        result = await self._api(method, path, data)
                    body = json.dumps(result).encode()
                elif method == "GET" and path in _ASSETS:
                    name, mime = _ASSETS[path]
                    body = (self._dir / name).read_bytes()
                else:
                    raise _HttpError(404)
            except _HttpError as exc:
                status = exc.status
            except SafetyError:
                status = 409
            except FileNotFoundError:
                status = 404
            except (ValueError, EOFError, TimeoutError, asyncio.LimitOverrunError, RecursionError):
                status = 400
            except Exception:
                status = 500
            if status != 200:
                mime, body = (
                    "application/json",
                    json.dumps({"error": HTTPStatus(status).phrase}).encode(),
                )
            fields = {
                "Content-Type": mime + "; charset=utf-8",
                "Content-Length": str(len(body)),
                "Connection": "close",
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'",
                **extra,
            }
            head = f"HTTP/1.1 {status} {HTTPStatus(status).phrase}\r\n"
            writer.write(
                (head + "".join(f"{k}: {v}\r\n" for k, v in fields.items()) + "\r\n").encode()
                + body
            )
            await writer.drain()
        finally:
            writer.close()
            with suppress(ConnectionError):
                await writer.wait_closed()
            self._tasks.discard(task)

    async def close(self) -> None:
        self._sessions.clear()
        self._token = None
        if self._server:
            self._server.close()
            tasks = tuple(self._tasks)
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await self._server.wait_closed()
            self._server = None
