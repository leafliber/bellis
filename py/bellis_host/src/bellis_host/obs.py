"""Loopback obs-websocket v5 control and external emergency notifications."""

import asyncio
import base64
import hashlib
import json
import math
import os
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Self, cast
from uuid import uuid4

from bellis_common.cred import read_secret_text
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import WebSocketException
from websockets.typing import Subprotocol

type Packet = dict[str, Any]
_MUTE = "InputMuteStateChanged"
_SCENE = "CurrentProgramSceneChanged"


class ObsError(RuntimeError):
    """OBS transport, protocol or request failure."""


def _object(value: object) -> Packet:
    if not isinstance(value, dict):
        raise ObsError("expected OBS JSON object")
    return cast(Packet, value)


@dataclass(frozen=True)
class ObsConfig:
    url: str = "ws://127.0.0.1:4455"
    stage_source: str = "浏览器"
    safe_scene: str = "Safe"
    stop_stream: bool = False
    password_env: str = "BELLIS_OBS_PASSWORD"
    cred_targets: tuple[str, ...] = ("obs.bellis",)
    rpc_timeout_s: float = 2.0

    def __post_init__(self) -> None:
        match = re.fullmatch(r"ws://(?:127\.0\.0\.1|localhost):([0-9]{1,5})/?", self.url)
        if not match or not 0 < int(match[1]) <= 65535:
            raise ValueError("expected a loopback ws:// URL with a valid port")
        if not 0 < self.rpc_timeout_s < math.inf:
            raise ValueError("expected finite positive OBS timeout")


def obs_auth_string(password: str, salt: str, challenge: str) -> str:
    def digest(value: str) -> str:
        return base64.b64encode(hashlib.sha256(value.encode()).digest()).decode("ascii")

    return digest(digest(password + salt) + challenge)


def _extract_obs_password(raw: str) -> str:
    if raw.lstrip().startswith("{"):
        try:
            data = json.loads(raw)
        except (ValueError, RecursionError):
            return raw
        if isinstance(data, dict):
            fields = cast(dict[str, object], data)
            if isinstance(password := fields.get("password"), str) and isinstance(
                fields.get("url", ""), str
            ):
                return password
    return raw


def resolve_obs_password(config: ObsConfig, explicit: str | None = None) -> str:
    if explicit is not None:
        return explicit
    if (value := os.getenv(config.password_env)) is not None:
        return value
    for target in config.cred_targets:
        if (value := read_secret_text(target)) is not None:
            return _extract_obs_password(value)
    return ""


@dataclass(frozen=True)
class ObsRequestResult:
    request_type: str
    ok: bool
    code: int
    data: Packet

    @classmethod
    def parse(cls, raw: object, expected: str) -> Self:
        reply = _object(raw)
        status = _object(reply.get("requestStatus"))
        ok, code = status.get("result"), status.get("code")
        if reply.get("requestType") != expected or type(ok) is not bool or type(code) is not int:
            raise ObsError("invalid OBS request result")
        return cls(expected, ok, code, _object(reply.get("responseData", {})))


@dataclass(frozen=True)
class EmergencyOutcome:
    results: tuple[ObsRequestResult, ...]

    @property
    def ok(self) -> bool:
        return all(r.ok or (r.request_type == "StopStream" and r.code == 501) for r in self.results)


async def _receive(ws: ClientConnection) -> tuple[int, Packet]:
    frame = _object(json.loads(await ws.recv()))
    if type(frame.get("op")) is not int:
        raise ObsError("invalid OBS envelope")
    return frame["op"], _object(frame.get("d"))


class ObsClient:
    def __init__(
        self,
        config: ObsConfig = ObsConfig(),
        *,
        password: str | None = None,
        on_external_emergency: Callable[[str], object] | None = None,
    ) -> None:
        self.config = config
        self._password = password
        self._external = on_external_emergency
        self._ws: ClientConnection | None = None
        self._reader: asyncio.Task[None] | None = None
        self._pending: dict[str, tuple[int, asyncio.Future[Packet]]] = {}
        self._echo: dict[str, float] = {}
        self._lifecycle = asyncio.Lock()
        self._control = asyncio.Lock()

    async def connect(self) -> None:
        async with self._lifecycle:
            if self._ws is not None:
                return
            ws = None
            try:
                async with asyncio.timeout(self.config.rpc_timeout_s):
                    ws = await connect(
                        self.config.url,
                        subprotocols=[Subprotocol("obswebsocket.json")],
                        host="127.0.0.1",
                        proxy=None,
                        close_timeout=self.config.rpc_timeout_s,
                    )
                    op, hello = await _receive(ws)
                    if op != 0:
                        raise ObsError("expected OBS Hello")
                    identify: Packet = {"rpcVersion": 1, "eventSubscriptions": (1 << 2) | (1 << 3)}
                    if isinstance(hello.get("authentication"), dict):
                        auth = _object(hello["authentication"])
                        password = resolve_obs_password(self.config, self._password)
                        identify["authentication"] = obs_auth_string(
                            password, auth["salt"], auth["challenge"]
                        )
                    await ws.send(json.dumps({"op": 1, "d": identify}))
                    op, reply = await _receive(ws)
                    if op != 2 or reply.get("negotiatedRpcVersion") != 1:
                        raise ObsError("expected Identified for OBS RPC v1")
                    self._ws = ws
                    self._reader = asyncio.create_task(self._read(ws))
            except (WebSocketException, OSError, KeyError, TypeError, ValueError) as exc:
                raise ObsError("OBS connection failed") from exc
            finally:
                if ws is not None and self._ws is None:
                    await ws.close()

    def _event(self, name: str, data: Packet) -> None:
        if name == _SCENE:
            matched = data.get("sceneName") == self.config.safe_scene
        elif name == _MUTE and data.get("inputName") == self.config.stage_source:
            matched = data.get("inputMuted") is True
        else:
            return
        # OBS omits the origin. Consume at most one expected echo, and discard it
        # on an intervening opposite transition (including a hotkey unmute).
        expiry = self._echo.pop(name, 0)
        if matched and expiry < asyncio.get_running_loop().time() and self._external:
            self._external(name)

    async def _read(self, ws: ClientConnection) -> None:
        try:
            while True:
                op, data = await _receive(ws)
                if op == 5:
                    event_data = data.get("eventData")
                    if isinstance(event_data, dict):
                        self._event(data["eventType"], cast(Packet, event_data))
                elif op in (7, 9) and (pending := self._pending.get(data["requestId"])):
                    expected, future = pending
                    if not future.done():
                        if op != expected:
                            raise ObsError("unexpected OBS reply opcode")
                        future.set_result(data)
        except (WebSocketException, OSError, ValueError, TypeError, KeyError, ObsError):
            pass
        finally:
            self._ws = None
            self._echo.clear()
            for _, future in self._pending.values():
                if not future.done():
                    future.set_exception(ObsError("OBS reader disconnected"))
            await ws.close()

    async def _rpc(self, op: int, data: Packet) -> Packet:
        ws = self._ws
        if ws is None:
            raise ObsError("OBS is disconnected")
        rid = str(uuid4())
        future: asyncio.Future[Packet] = asyncio.get_running_loop().create_future()
        self._pending[rid] = op + 1, future
        try:
            async with asyncio.timeout(self.config.rpc_timeout_s):
                await ws.send(json.dumps({"op": op, "d": {"requestId": rid, **data}}))
                return await future
        except (WebSocketException, OSError) as exc:
            raise ObsError("OBS request failed") from exc
        finally:
            self._pending.pop(rid, None)

    async def request(self, request_type: str, data: Packet | None = None) -> ObsRequestResult:
        reply = await self._rpc(6, {"requestType": request_type, "requestData": data or {}})
        result = ObsRequestResult.parse(reply, request_type)
        if not result.ok:
            raise ObsError(f"{request_type} failed with OBS code {result.code}")
        return result

    async def batch(self, requests: Sequence[Packet]) -> tuple[ObsRequestResult, ...]:
        reply = await self._rpc(
            8, {"haltOnFailure": False, "executionType": 0, "requests": requests}
        )
        results: Any = reply.get("results")
        if type(results) is not list or len(cast(list[object], results)) != len(requests):
            raise ObsError("incomplete OBS batch response")
        return tuple(
            ObsRequestResult.parse(r, q["requestType"])
            for r, q in zip(cast(list[object], results), requests, strict=True)
        )

    def _expect(self, name: str) -> None:
        self._echo[name] = asyncio.get_running_loop().time() + self.config.rpc_timeout_s

    async def run_emergency(self, timeout: float = 1.0) -> EmergencyOutcome:
        requests: list[Packet] = [
            {
                "requestType": "SetInputMute",
                "requestData": {"inputName": self.config.stage_source, "inputMuted": True},
            },
            {
                "requestType": "SetCurrentProgramScene",
                "requestData": {"sceneName": self.config.safe_scene},
            },
        ]
        if self.config.stop_stream:
            requests.append({"requestType": "StopStream"})
        async with asyncio.timeout(timeout), self._control:
            self._expect(_MUTE)
            self._expect(_SCENE)
            try:
                results = await self.batch(requests)
            except BaseException:
                self._echo.clear()
                raise
            for event, result in zip((_MUTE, _SCENE), results[:2], strict=True):
                if not result.ok:
                    self._echo.pop(event, None)
            return EmergencyOutcome(results)

    async def set_stage_url(self, url: str) -> ObsRequestResult:
        return await self.request(
            "SetInputSettings",
            {"inputName": self.config.stage_source, "inputSettings": {"url": url}, "overlay": True},
        )

    async def set_stage_muted(self, muted: bool) -> ObsRequestResult:
        async with self._control:
            if muted:
                self._expect(_MUTE)
            else:
                self._echo.pop(_MUTE, None)
            try:
                return await self.request(
                    "SetInputMute", {"inputName": self.config.stage_source, "inputMuted": muted}
                )
            except BaseException:
                self._echo.pop(_MUTE, None)
                raise

    async def preflight(self) -> None:
        scenes, inputs = await asyncio.gather(
            self.request("GetSceneList"), self.request("GetInputList")
        )
        for result, field, key, expected in (
            (scenes, "scenes", "sceneName", self.config.safe_scene),
            (inputs, "inputs", "inputName", self.config.stage_source),
        ):
            rows = result.data.get(field)
            if not isinstance(rows, list):
                raise ObsError(f"invalid OBS {field}")
            names = [_object(row).get(key) for row in cast(list[object], rows)]
            if any(not isinstance(name, str) for name in names) or expected not in names:
                raise ObsError(f"invalid or missing {key} in OBS {field}")

    async def close(self) -> None:
        async with self._lifecycle:
            if self._ws is not None:
                await self._ws.close()
            if self._reader is not None:
                await self._reader
                self._reader = None

    async def __aenter__(self) -> Self:
        await self.connect()
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.close()
