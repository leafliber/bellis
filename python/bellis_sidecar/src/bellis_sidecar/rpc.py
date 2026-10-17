"""连接之上的 JSON-RPC 2.0 对端（D-21），行为与 `packages/channel` 的 RpcPeer 一致。

双方都可以请求和响应。每个请求都有截止时间；超时或被取消时向对端发 `rpc.cancel`。
收到 `rpc.cancel` 时取消对应的处理任务；应答照常发送，请求方会忽略。
连接关闭时，未完成的请求以 `closed` 失败，正在处理的请求被取消。
消息按 `packages/protocol` 生成的模型校验；处理函数的内部错误不外泄细节。
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from pydantic import BaseModel, ValidationError

from .channel import KIND_BINARY, ChannelError, Connection
from .protocol import RpcCancelParams, RpcFailure, RpcNotification, RpcRequest, RpcSuccess

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
SERVER_BUSY = -32000

RPC_CANCEL = 'rpc.cancel'
DEFAULT_MAX_INFLIGHT = 64

type Params = dict[str, Any]
type RpcId = str | int
type Handler = Callable[[Params], Awaitable[object]]
type NotificationHandler = Callable[[Params], None]

log = logging.getLogger('bellis_sidecar.rpc')


class RpcError(Exception):
    """对端返回的 JSON-RPC 错误；处理函数抛出它即可指定错误码。"""

    def __init__(self, code: int, message: str, data: object = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


def _parse[M: BaseModel](model: type[M], message: object) -> M | None:
    try:
        return model.model_validate(message, strict=True)
    except ValidationError:
        return None


def _with_params(message: dict[str, object], params: Params | None) -> dict[str, object]:
    return message if params is None else {**message, 'params': params}


class RpcPeer:
    """须在事件循环中创建；创建后即开始读取，处理函数应在下一次等待之前注册。"""

    def __init__(
        self,
        connection: Connection,
        *,
        timeout: float = 2.0,
        max_inflight: int = DEFAULT_MAX_INFLIGHT,
        on_binary: Callable[[bytes], None] | None = None,
    ) -> None:
        self.connection = connection
        self._timeout = timeout
        self._max_inflight = max_inflight
        self._on_binary = on_binary
        self._handlers: dict[str, Handler] = {}
        self._notification_handlers: dict[str, NotificationHandler] = {}
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._inflight: dict[RpcId, asyncio.Task[None]] = {}
        self._cancelled: set[RpcId] = set()
        self._next_id = 1
        loop = asyncio.get_running_loop()
        self.closed: asyncio.Future[ChannelError | None] = loop.create_future()
        self._reader = loop.create_task(self._read())

    def handle(self, method: str, handler: Handler) -> Callable[[], None]:
        """注册请求处理函数，返回撤销函数。同名方法只能有一个处理函数。"""
        _reserved(method)
        return _register(self._handlers, method, handler)

    def on_notification(self, method: str, handler: NotificationHandler) -> Callable[[], None]:
        _reserved(method)
        return _register(self._notification_handlers, method, handler)

    async def request(
        self, method: str, params: Params | None = None, *, timeout: float | None = None
    ) -> Any:
        if self.closed.done():
            raise ChannelError('closed', '连接已关闭')
        request_id = self._next_id
        self._next_id += 1
        future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        limit = self._timeout if timeout is None else timeout
        try:
            self.connection.send(
                _with_params({'jsonrpc': '2.0', 'id': request_id, 'method': method}, params)
            )
            async with asyncio.timeout(limit):
                return await future
        except TimeoutError as error:
            self._send_cancel(request_id)
            raise ChannelError('timeout', f'{method} 未在 {limit}s 内响应') from error
        except asyncio.CancelledError:
            self._send_cancel(request_id)
            raise
        finally:
            self._pending.pop(request_id, None)

    def notify(self, method: str, params: Params | None = None) -> None:
        self.connection.send(_with_params({'jsonrpc': '2.0', 'method': method}, params))

    async def send_binary(self, data: bytes) -> None:
        """发送一帧二进制数据，等写缓冲回落后才返回（背压）。"""
        self.connection.send_binary(data)
        await self.connection.drain()

    async def close(self) -> None:
        """取消正在处理的请求，正常关闭连接。"""
        for task in list(self._inflight.values()):
            task.cancel()
        await self.connection.close()
        await asyncio.gather(self._reader, return_exceptions=True)

    def _send_cancel(self, request_id: int) -> None:
        if self.connection.is_open:
            with contextlib.suppress(ChannelError):
                self.notify(RPC_CANCEL, {'id': request_id})

    async def _read(self) -> None:
        error: ChannelError | None = None
        try:
            while True:
                kind, message = await self.connection.receive()
                if kind == KIND_BINARY:
                    if self._on_binary is not None:
                        self._on_binary(message)
                    continue
                self._receive(message)
        except ChannelError as caught:
            error = None if caught.code == 'closed' else caught
        finally:
            await self.connection.close()
            self._on_close(error)

    def _receive(self, message: object) -> None:
        if (request := _parse(RpcRequest, message)) is not None:
            self._serve(request)
        elif (notification := _parse(RpcNotification, message)) is not None:
            self._notify(notification)
        elif (success := _parse(RpcSuccess, message)) is not None:
            future = self._pending.get(success.id) if isinstance(success.id, int) else None
            if future is not None and not future.done():
                future.set_result(success.result)
        elif (failure := _parse(RpcFailure, message)) is not None:
            if not isinstance(failure.id, int):
                return
            future = self._pending.get(failure.id)
            if future is not None and not future.done():
                error = failure.error
                future.set_exception(RpcError(error.code, error.message, error.data))
        else:
            self._reply(None, error={'code': INVALID_REQUEST, 'message': 'Invalid Request'})

    def _notify(self, notification: RpcNotification) -> None:
        if notification.method == RPC_CANCEL:
            cancel = _parse(RpcCancelParams, notification.params)
            task = self._inflight.get(cancel.id) if cancel is not None else None
            if cancel is not None and task is not None:
                self._cancelled.add(cancel.id)
                task.cancel()
            return
        handler = self._notification_handlers.get(notification.method)
        if handler is None:
            return
        try:
            handler(notification.params or {})
        except Exception:
            log.exception('通知 %s 的处理函数出错', notification.method)

    def _serve(self, request: RpcRequest) -> None:
        handler = self._handlers.get(request.method)
        if handler is None:
            message = f'Method not found: {request.method}'
            self._reply(request.id, error={'code': METHOD_NOT_FOUND, 'message': message})
        elif request.id in self._inflight:
            self._reply(
                request.id, error={'code': INVALID_REQUEST, 'message': 'Duplicate request id'}
            )
        elif len(self._inflight) >= self._max_inflight:
            self._reply(request.id, error={'code': SERVER_BUSY, 'message': 'Server busy'})
        else:
            task = asyncio.get_running_loop().create_task(
                self._run(request.id, handler, request.params or {})
            )
            self._inflight[request.id] = task

    async def _run(self, request_id: RpcId, handler: Handler, params: Params) -> None:
        try:
            result = await handler(params)
        except RpcError as error:
            failure: dict[str, object] = {'code': error.code, 'message': error.message}
            if error.data is not None:
                failure['data'] = error.data
            self._reply(request_id, error=failure)
        except asyncio.CancelledError:
            # 请求方取消：照常应答（请求方会忽略）；连接关闭或本端收尾导致的取消照常向上传播。
            if request_id not in self._cancelled:
                raise
            self._reply(request_id, error={'code': INTERNAL_ERROR, 'message': 'Request cancelled'})
        except Exception:
            log.exception('请求的处理函数出错')
            self._reply(request_id, error={'code': INTERNAL_ERROR, 'message': 'Internal error'})
        else:
            self._reply(request_id, result=result)
        finally:
            self._inflight.pop(request_id, None)
            self._cancelled.discard(request_id)

    def _reply(
        self,
        request_id: RpcId | None,
        *,
        result: object = None,
        error: dict[str, object] | None = None,
    ) -> None:
        message: dict[str, object] = {'jsonrpc': '2.0', 'id': request_id}
        if error is None:
            message['result'] = result
        else:
            message['error'] = error
        if self.connection.is_open:
            with contextlib.suppress(ChannelError):
                self.connection.send(message)

    def _on_close(self, error: ChannelError | None) -> None:
        for future in self._pending.values():
            if not future.done():
                future.set_exception(ChannelError('closed', '连接已关闭，请求未完成'))
        for task in self._inflight.values():
            task.cancel()
        if not self.closed.done():
            self.closed.set_result(error)


def _reserved(method: str) -> None:
    if method.startswith('rpc.'):
        raise ValueError('rpc. 前缀保留给协议自身')


def _register[T](table: dict[str, T], method: str, handler: T) -> Callable[[], None]:
    if method in table:
        raise ValueError(f'方法 {method} 已有处理函数')
    table[method] = handler

    def dispose() -> None:
        if table.get(method) is handler:
            del table[method]

    return dispose
