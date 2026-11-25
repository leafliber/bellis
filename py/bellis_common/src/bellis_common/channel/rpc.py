"""Minimal JSON-RPC 2.0 peer over ``bellis-channel/1`` (V2 single/multi-segment methods)."""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import re
from collections.abc import Awaitable, Callable
from typing import Any, cast

from .connection import BinaryMessage, Connection
from .wire import ChannelError

type RpcId = str | int
type RpcParams = dict[str, Any]
type RpcHandler = Callable[[RpcParams], Awaitable[object] | object]
type NotificationHandler = Callable[[RpcParams], None]

RPC_CANCEL = "rpc.cancel"
DEFAULT_MAX_INFLIGHT = 64
_MISSING = object()
_METHOD = re.compile(r"[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*")
_MAX_SAFE_INT = 2**53 - 1
_NONE: frozenset[str] = frozenset()
_PARAMS = frozenset({"params"})


class RpcErrorCode:
    PARSE_ERROR = -32700
    INVALID_REQUEST = -32600
    METHOD_NOT_FOUND = -32601
    INVALID_PARAMS = -32602
    INTERNAL_ERROR = -32603
    SERVER_BUSY = -32000


class RpcError(Exception):
    def __init__(self, code: int, message: str, data: object = _MISSING) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = None if data is _MISSING else data
        self._has_data = data is not _MISSING

    def to_object(self) -> dict[str, object]:
        obj: dict[str, object] = {"code": self.code, "message": self.message}
        if self._has_data:
            obj["data"] = self.data
        return obj


def _is_int(value: object) -> bool:
    if isinstance(value, bool):
        return False
    return isinstance(value, int) or (isinstance(value, float) and value.is_integer())


def _rpc_id(value: object) -> RpcId | None:
    if isinstance(value, str):
        return value if 1 <= len(value) <= 128 else None
    if _is_int(value):
        n = int(cast("int | float", value))
        return n if -_MAX_SAFE_INT <= n <= _MAX_SAFE_INT else None
    return None


def _fields(msg: object, req: frozenset[str], opt: frozenset[str]) -> dict[str, Any]:
    if not isinstance(msg, dict):
        return {}
    d = cast("dict[str, Any]", msg)
    return d if req <= d.keys() <= (req | opt) else {}


def is_method(value: object) -> bool:
    """Return True iff ``value`` matches single- or multi-segment lowercase RPC method syntax."""
    return isinstance(value, str) and _METHOD.fullmatch(value) is not None


def _params_ok(d: dict[str, Any]) -> bool:
    return "params" not in d or isinstance(d["params"], dict)


def _error_ok(val: object) -> bool:
    d = _fields(val, frozenset({"code", "message"}), frozenset({"data"}))
    return bool(d) and _is_int(d["code"]) and isinstance(d["message"], str)


def classify(message: object) -> str:
    """Classify JSON-RPC 2.0 envelope: request | notification | success | failure | invalid."""
    req = _fields(message, frozenset({"jsonrpc", "id", "method"}), _PARAMS)
    if (
        req
        and req["jsonrpc"] == "2.0"
        and _rpc_id(req["id"]) is not None
        and is_method(req["method"])
        and _params_ok(req)
    ):
        return "request"
    noti = _fields(message, frozenset({"jsonrpc", "method"}), _PARAMS)
    if noti and noti["jsonrpc"] == "2.0" and is_method(noti["method"]) and _params_ok(noti):
        return "notification"
    ok = _fields(message, frozenset({"jsonrpc", "id", "result"}), _NONE)
    if ok and ok["jsonrpc"] == "2.0" and _rpc_id(ok["id"]) is not None:
        return "success"
    fail = _fields(message, frozenset({"jsonrpc", "id", "error"}), _NONE)
    if (
        fail
        and fail["jsonrpc"] == "2.0"
        and (fail["id"] is None or _rpc_id(fail["id"]) is not None)
        and _error_ok(fail["error"])
    ):
        return "failure"
    return "invalid"


def cancel_target(params: object) -> RpcId | None:
    d = _fields(params, frozenset({"id"}), _NONE)
    return _rpc_id(d["id"]) if d else None


def _with_params(msg: dict[str, object], params: RpcParams | None) -> dict[str, object]:
    if params is not None:
        msg["params"] = params
    return msg


def _register[T](reg: dict[str, T], method: str, handler: T) -> Callable[[], None]:
    if method.startswith("rpc."):
        raise ValueError("the 'rpc.' method prefix is reserved")
    if method in reg:
        raise ValueError(f"handler already registered for {method}")
    reg[method] = handler

    def dispose() -> None:
        if reg.get(method) is handler:
            del reg[method]

    return dispose


class RpcPeer:
    """Bidirectional JSON-RPC 2.0 peer over an authenticated ``Connection``."""

    def __init__(
        self,
        connection: Connection,
        *,
        timeout: float,
        max_inflight: int = DEFAULT_MAX_INFLIGHT,
        json_decoder: Callable[[bytes], object] | None = None,
    ) -> None:
        self.connection = connection
        self._timeout = timeout
        self._max_inflight = max_inflight
        self._json_decoder = json_decoder
        self._loop = asyncio.get_running_loop()
        self._pending: dict[RpcId, asyncio.Future[object]] = {}
        self._handlers: dict[str, RpcHandler] = {}
        self._notifications: dict[str, NotificationHandler] = {}
        self._inflight: dict[RpcId, asyncio.Task[None]] = {}
        self._next_id = 1
        self.closed: asyncio.Task[ChannelError | None] = self._loop.create_task(self._read())

    def handle(self, method: str, handler: RpcHandler) -> Callable[[], None]:
        return _register(self._handlers, method, handler)

    def on_notification(self, method: str, handler: NotificationHandler) -> Callable[[], None]:
        return _register(self._notifications, method, handler)

    async def request(
        self, method: str, params: RpcParams | None = None, *, timeout: float | None = None
    ) -> object:
        rid = self._next_id
        self._next_id += 1
        deadline = self._timeout if timeout is None else timeout
        fut: asyncio.Future[object] = self._loop.create_future()
        self._pending[rid] = fut
        try:
            self.connection.send(
                _with_params({"jsonrpc": "2.0", "id": rid, "method": method}, params)
            )
            async with asyncio.timeout(deadline):
                return await fut
        except TimeoutError:
            self._cancel(rid)
            raise ChannelError("timeout", f"{method} timed out") from None
        except asyncio.CancelledError:
            self._cancel(rid)
            raise
        finally:
            self._pending.pop(rid, None)

    def notify(self, method: str, params: RpcParams | None = None) -> None:
        self.connection.send(_with_params({"jsonrpc": "2.0", "method": method}, params))

    async def close(self) -> None:
        await self.connection.close()
        await asyncio.wait({self.closed})

    def _cancel(self, rid: RpcId) -> None:
        if self.connection.is_open:
            with contextlib.suppress(ChannelError):
                self.notify(RPC_CANCEL, {"id": rid})

    async def _read(self) -> ChannelError | None:
        err: ChannelError | None = None
        try:
            while True:
                msg = (
                    await self.connection.receive()
                    if self._json_decoder is None
                    else await self.connection.receive(json_decoder=self._json_decoder)
                )
                if not isinstance(msg, BinaryMessage):
                    self._receive(msg.value)
        except ChannelError as caught:
            err = None if caught.code == "closed" else caught
        finally:
            for fut in list(self._pending.values()):
                if not fut.done():
                    fut.set_exception(ChannelError("closed", "connection closed before reply"))
            for task in list(self._inflight.values()):
                task.cancel("connection closed")
        return err

    def _receive(self, message: object) -> None:
        kind = classify(message)
        if kind == "invalid":
            self._fail(None, RpcErrorCode.INVALID_REQUEST, "Invalid Request")
            return
        d = cast("dict[str, Any]", message)
        if kind == "request":
            self._serve(d)
        elif kind == "notification":
            self._dispatch_notification(d["method"], d.get("params"))
        elif kind == "success":
            fut = self._pending.get(cast("RpcId", _rpc_id(d["id"])))
            if fut is not None and not fut.done():
                fut.set_result(d["result"])
        elif d["id"] is not None:
            fut = self._pending.get(cast("RpcId", _rpc_id(d["id"])))
            if fut is not None and not fut.done():
                e: dict[str, Any] = d["error"]
                code = int(e["code"])
                exc = (
                    RpcError(code, e["message"], e["data"])
                    if "data" in e
                    else RpcError(code, e["message"])
                )
                fut.set_exception(exc)

    def _dispatch_notification(self, method: str, params: object) -> None:
        if method == RPC_CANCEL:
            target = cancel_target(params)
            if target is not None and (task := self._inflight.get(target)) is not None:
                task.cancel("cancelled by peer")
            return
        handler = self._notifications.get(method)
        if handler is not None:
            try:
                handler(cast("RpcParams", params) if params is not None else {})
            except Exception as err:
                self._loop.call_exception_handler({"message": f"notify {method}", "exception": err})

    def _serve(self, req: dict[str, Any]) -> None:
        rid = cast("RpcId", _rpc_id(req["id"]))
        method: str = req["method"]
        handler = self._handlers.get(method)
        if handler is None:
            self._fail(rid, RpcErrorCode.METHOD_NOT_FOUND, f"Method not found: {method}")
        elif rid in self._inflight:
            self._fail(rid, RpcErrorCode.INVALID_REQUEST, "Duplicate request id")
        elif len(self._inflight) >= self._max_inflight:
            self._fail(rid, RpcErrorCode.SERVER_BUSY, "Server busy")
        else:
            params = cast("RpcParams", req.get("params", {}))
            self._inflight[rid] = self._loop.create_task(self._run(rid, handler, params))

    async def _run(self, rid: RpcId, handler: RpcHandler, params: RpcParams) -> None:
        try:
            result = handler(params)
            if inspect.isawaitable(result):
                result = await result
            if self.connection.is_open:
                self.connection.send({"jsonrpc": "2.0", "id": rid, "result": result})
        except RpcError as err:
            self._reply({"jsonrpc": "2.0", "id": rid, "error": err.to_object()})
        except asyncio.CancelledError:
            pass
        except Exception:
            self._fail(rid, RpcErrorCode.INTERNAL_ERROR, "Internal error")
        finally:
            self._inflight.pop(rid, None)

    def _fail(self, rid: RpcId | None, code: int, message: str) -> None:
        self._reply({"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}})

    def _reply(self, message: dict[str, object]) -> None:
        if self.connection.is_open:
            with contextlib.suppress(ChannelError):
                self.connection.send(message)
