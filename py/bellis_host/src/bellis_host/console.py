"""Loopback operator HTTP console. Manual say waits for its own playback outcome."""

import asyncio
import json
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import asdict
from pathlib import Path
from uuid import uuid4

from bellis_common.agent_events import GoalSet
from bellis_common.channel import ChannelError

from .audience import AudienceHub, VoteSnapshot
from .console_http import (
    ASSETS,
    ConsoleSessionAuth,
    Data,
    HttpError,
    read_http_request,
    require_text,
    write_http_response,
)
from .console_http import ConsoleConfig as ConsoleConfig
from .director import SlowDirector
from .game_control import GameController, parse_game_directive
from .game_permit import HostGamePermit
from .safety import SafetyCore, SafetyError
from .speech import SpeechArbiter, SpeechPriority, SpeechRequest
from .stage import StageServer
from .store import IntentSource

_DEFAULT_CONFIG = ConsoleConfig()


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
        config: ConsoleConfig = _DEFAULT_CONFIG,
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
        self._auth = ConsoleSessionAuth(config.session_ttl_s)
        self._tasks: set[asyncio.Task[None]] = set()

    @property
    def port(self) -> int:
        if self._server is None:
            raise RuntimeError("console is stopped")
        return int(self._server.sockets[0].getsockname()[1])

    def issue_login_url(self) -> str:
        return self._auth.issue_login_url(self.port)

    async def start(self) -> None:
        if not self._server:
            self._server = await asyncio.start_server(
                self._handle, self.config.host, self.config.port, limit=16384
            )

    async def _say(self, text: str) -> Data:
        if not self.speech:
            raise HttpError(503)
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
                "game_queued_goal": self.game.queued_goal_snapshot() if self.game else None,
                "stage_connected": bool(self.stage and self.stage.connected),
                "pending_danmaku": self.audience.pending_count() if self.audience else 0,
                "active_vote": vote and asdict(vote),
                "recent_heard": self.speech.recent_heard() if self.speech else (),
            }
        if method != "POST":
            raise HttpError(405)
        controls = self.director or self.speech
        if path in {"/api/game/arm", "/api/game/disarm"}:
            return await self._game_permit_api(path, data)
        if path == "/api/game/auto-resume":
            return self._game_auto_resume_api(data)
        if path == "/api/game/decision":
            return await self._game_decision_api(data)
        if path in {"/api/game/goal", "/api/game/cancel", "/api/game/pause", "/api/game/resume"}:
            return await self._game_command(path.rsplit("/", 1)[1], data)
        if path == "/api/game/objective":
            return await self._game_objective_api(data)
        if path == "/api/control/live":
            self.safety.start_live(actor="operator")
        elif path == "/api/control/pause":
            reason = require_text(data, "reason", "operator_pause")
            self.safety.pause_live(reason=reason)
            if self.game_permit:
                self.game_permit.cancel_pending_arm()
            if controls:
                controls.interrupt(reason)
            if self.game:
                await self.game.cancel_for_stop(reason)
        elif path == "/api/control/emergency":
            reason = require_text(data, "reason", "operator_emergency")
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
                raise HttpError(502)
        elif path == "/api/control/clear-emergency":
            self.safety.clear_emergency(actor="operator")
        elif path == "/api/speech/say":
            return await self._say(require_text(data, "text"))
        elif path == "/api/speech/interrupt" and controls:
            controls.interrupt(require_text(data, "reason", "operator_interrupt"))
        elif path == "/api/danmaku" and (self.director or self.audience):
            args = tuple(require_text(data, key) for key in ("viewer_id", "viewer_name", "text"))
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
                    raise HttpError(409)
                vote, line = end
            if self.speech:
                await self._say(line)
            if self.director and path == "/api/vote/close":
                self.director.notify_vote_ended()
            return {"ok": True, "vote": asdict(vote)}
        else:
            raise HttpError(404)
        return {"ok": True}

    async def _game_permit_api(self, path: str, data: Data) -> Data:
        if self.game_permit is None:
            raise HttpError(503)
        if path == "/api/game/arm":
            if data.keys() - {"wait_for_focus", "settle_s"}:
                raise HttpError(400)
            wait_focus = data.get("wait_for_focus", False)
            raw_settle = data.get("settle_s", 2.0)
            if type(wait_focus) is not bool or not (
                type(raw_settle) is int or type(raw_settle) is float
            ):
                raise HttpError(400)
            try:
                status, token = await self.game_permit.request_arm(
                    actor="operator", wait_for_focus=wait_focus, settle_s=float(raw_settle)
                )
            except ChannelError:
                raise HttpError(503) from None
            if status == "armed" and wait_focus and self.game is not None:
                if (queued := self.game.take_queued_goal()) is not None:
                    self.game.dispatch_queued(queued)
                elif self.director is not None and self.game.resume_objective_after_takeover():
                    self.director.notify_objective_resumed()
            if wait_focus:
                return {"ok": True, "status": status, "token": token}
            return {"ok": True, "token": token}
        if self.game is not None:
            self.game.clear_queued_goal()
        token = await self.game_permit.disarm_input(
            reason=require_text(data, "reason", "operator_disarm")
        )
        return {"ok": True, "token": token}

    def _game_auto_resume_api(self, data: Data) -> Data:
        if self.game_permit is None:
            raise HttpError(503)
        if data.keys() - {"enabled", "idle_s"}:
            raise HttpError(400)
        enabled = data.get("enabled")
        raw_idle = data.get("idle_s")
        if type(enabled) is not bool:
            raise HttpError(400)
        idle_s: float | None = None
        if raw_idle is not None:
            if type(raw_idle) is int or type(raw_idle) is float:
                idle_s = float(raw_idle)
            else:
                raise HttpError(400)
        active, wait_s = self.game_permit.set_auto_resume(enabled, idle_s=idle_s)
        return {"ok": True, "auto_resume": active, "auto_resume_idle_s": wait_s}

    async def _game_decision_api(self, data: Data) -> Data:
        if self.game is None:
            raise HttpError(503)
        index, reason = data.get("chosen_index"), data.get("reason", "")
        if (
            data.keys() - {"chosen_index", "decision_id", "reason"}
            or type(index) is not int
            or not isinstance(reason, str)
        ):
            raise HttpError(400)
        decision_id = require_text(data, "decision_id") if "decision_id" in data else None
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
            raise HttpError(503) from None
        return {"ok": ack.accepted, "reason": ack.reason}

    async def _game_objective_api(self, data: Data) -> Data:
        if self.game is None:
            raise HttpError(503)
        allowed = {"description", "auto_continue", "max_auto_steps", "clear", "cancel_active"}
        if data.keys() - allowed:
            raise HttpError(400)
        desc = data.get("description", "")
        if data.get("clear") is True or (isinstance(desc, str) and not desc.strip()):
            self.game.clear_objective()
            if data.get("cancel_active") is True:
                await self.game.cancel_for_stop("operator_stop")
            return {"ok": True, "objective": None}
        auto_continue = data.get("auto_continue", True)
        max_auto = data.get("max_auto_steps", 12)
        if type(auto_continue) is not bool or type(max_auto) is not int:
            raise HttpError(400)
        self.game.clear_queued_goal()
        obj = self.game.set_objective(
            require_text(data, "description"),
            auto_continue=auto_continue,
            max_auto_steps=max_auto,
        )
        if (
            obj.auto_continue
            and self.director is not None
            and self.game_permit is not None
            and self.game_permit.armed
            and self.game.link.connected
            and self.game.link.snapshot().active_goal_id is None
        ):
            self.director.notify_objective_resumed()
        return {"ok": True, "objective": asdict(obj)}

    async def _game_command(self, action: str, data: Data) -> Data:
        if self.game is None:
            raise HttpError(503)
        if action == "goal":
            if data.keys() - {"description", "max_steps", "timeout_s", "wait_for_arm"}:
                raise HttpError(400)
            wait_for_arm = data.get("wait_for_arm", False)
            if type(wait_for_arm) is not bool:
                raise HttpError(400)
            fields = {k: v for k, v in data.items() if k != "wait_for_arm"}
            command = parse_game_directive({"command": "set_goal", **fields})
            if (
                wait_for_arm
                and isinstance(command, GoalSet)
                and self.game_permit is not None
                and not self.game_permit.armed
                and self.game_permit.snapshot().arm_pending
            ):
                try:
                    self.game.queue_goal(command)
                except ChannelError:
                    raise HttpError(503) from None
                return {"ok": True, "goal_id": command.goal_id, "queued": True}
        else:
            if data.keys() - {"reason"}:
                raise HttpError(400)
            name = {"cancel": "cancel_goal", "pause": "pause_pacing", "resume": "resume_pacing"}
            command = parse_game_directive(
                {"command": name[action], "reason": data.get("reason", f"operator_{action}")}
            )
        try:
            ack = await self.game.dispatch(command, source=IntentSource.OPERATOR, holder="operator")
        except ChannelError:
            raise HttpError(503) from None
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
                    method, path, headers, data = await read_http_request(reader, self.port)
                if path.startswith("/api/"):
                    result = self._auth.authenticate(path, method, headers, data, extra)
                    if result is None:
                        result = await self._api(method, path, data)
                    body = json.dumps(result).encode()
                elif method == "GET" and path in ASSETS:
                    name, mime = ASSETS[path]
                    body = (self._dir / name).read_bytes()
                else:
                    raise HttpError(404)
            except HttpError as exc:
                status = exc.status
            except SafetyError:
                status = 409
            except FileNotFoundError:
                status = 404
            except (ValueError, EOFError, TimeoutError, asyncio.LimitOverrunError, RecursionError):
                status = 400
            except Exception:
                status = 500
            await write_http_response(writer, status, mime, body, extra)
        finally:
            writer.close()
            with suppress(ConnectionError):
                await writer.wait_closed()
            self._tasks.discard(task)

    async def close(self) -> None:
        self._auth.clear()
        if self._server:
            self._server.close()
            tasks = tuple(self._tasks)
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await self._server.wait_closed()
            self._server = None
