"""sidecar 子进程一侧（见插件内核“sidecar 代理”）：以代理分配的角色连接宿主，应答握手与健康检查。

宿主经环境变量传入通道地址、会话密钥与角色（与 `packages/protocol` 的 `ChildEnv` 一致）。
收到 `process.shutdown`、stdin 读到 EOF 或与宿主的连接断开时，`serve_sidecar` 返回，
调用方收尾后退出；超时仍不退出时由宿主强制终止（R-06）。
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import sys
import threading
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass

from pydantic import ValidationError

from .channel import ChannelError, connect, decode_session_key
from .protocol import ProcessShutdownParams, SidecarDescription, SidecarHealthResult
from .rpc import Params, RpcPeer

ENV_CHANNEL_PATH = 'BELLIS_CHANNEL_PATH'
ENV_CHANNEL_KEY = 'BELLIS_CHANNEL_KEY'
ENV_ROLE = 'BELLIS_ROLE'

SIDECAR_DESCRIBE = 'sidecar.describe'
SIDECAR_HEALTH = 'sidecar.health'
PROCESS_SHUTDOWN = 'process.shutdown'

log = logging.getLogger('bellis_sidecar')


@dataclass(frozen=True)
class SidecarOptions:
    """`provides` 须与宿主代理插件清单中的 provides 一致，申请的权限须已在 profile 中授予。"""

    provides: Sequence[str]
    permissions: Sequence[str] = ()
    health: Callable[[], Awaitable[SidecarHealthResult]] | None = None
    #: 在握手之前注册业务方法。
    setup: Callable[[RpcPeer], None] | None = None


def watch_lifeline(on_end: Callable[[], None], fd: int = 0) -> None:
    """stdin 只作生命线，不传数据：读到 EOF（宿主要求停止或已经退出）时在事件循环里调用 on_end。

    阻塞读放在守护线程里：Windows 上宿主给的 stdin 管道不支持重叠 I/O，事件循环读不了。
    直接读文件描述符，不经 `sys.stdin` 的缓冲区，退出时不会因缓冲区的锁卡住。
    """
    loop = asyncio.get_running_loop()

    def watch() -> None:
        with contextlib.suppress(OSError):
            while os.read(fd, 65536):
                pass
        with contextlib.suppress(RuntimeError):
            loop.call_soon_threadsafe(on_end)

    threading.Thread(target=watch, name='lifeline', daemon=True).start()


async def serve_sidecar(
    options: SidecarOptions, env: Mapping[str, str] | None = None, *, lifeline: bool = True
) -> str:
    """连接宿主并应答握手，直到停止；返回停止的原因：`shutdown`、`stdin-eof` 或 `closed`。"""
    source = os.environ if env is None else env
    role = source.get(ENV_ROLE)
    path = source.get(ENV_CHANNEL_PATH)
    key = source.get(ENV_CHANNEL_KEY)
    if not role or not path or not key:
        raise RuntimeError(f'缺少环境变量 {ENV_ROLE}、{ENV_CHANNEL_PATH} 或 {ENV_CHANNEL_KEY}')
    description = SidecarDescription(
        protocol=1, provides=list(options.provides), permissions=list(options.permissions)
    ).model_dump(mode='json')

    connection = await connect(path, role, decode_session_key(key))
    loop = asyncio.get_running_loop()
    stopped: asyncio.Future[str] = loop.create_future()

    def stop(reason: str) -> None:
        if not stopped.done():
            stopped.set_result(reason)

    async def describe(_params: Params) -> object:
        return description

    async def health(_params: Params) -> object:
        result = await options.health() if options.health else SidecarHealthResult(ok=True)
        return result.model_dump(mode='json', exclude_none=True)

    async def shutdown(params: Params) -> object:
        # 先应答，再在下一轮事件循环开始收尾，避免应答被退出打断。
        reason = None
        with contextlib.suppress(ValidationError):
            reason = ProcessShutdownParams.model_validate(params, strict=True).reason
        log.info('收到停止请求：%s', reason)
        loop.call_soon(stop, 'shutdown')
        return {'accepted': True}

    # 创建对端后到注册完处理函数之间没有等待，宿主的握手请求不会先于处理函数到达。
    peer = RpcPeer(connection)
    peer.handle(SIDECAR_DESCRIBE, describe)
    peer.handle(SIDECAR_HEALTH, health)
    peer.handle(PROCESS_SHUTDOWN, shutdown)
    if options.setup is not None:
        options.setup(peer)
    if lifeline:
        watch_lifeline(lambda: stop('stdin-eof'))
    peer.closed.add_done_callback(lambda _: stop('closed'))

    reason = await stopped
    await peer.close()
    return reason


def run_sidecar(options: SidecarOptions) -> int:
    """sidecar 进程的入口：返回退出码。日志写到 stderr（宿主继承）。"""
    logging.basicConfig(
        level=logging.WARNING, stream=sys.stderr, format='%(name)s %(levelname)s %(message)s'
    )
    try:
        reason = asyncio.run(serve_sidecar(options))
    except (ChannelError, RuntimeError) as error:
        log.error('sidecar 无法运行：%s', error)
        return 1
    log.info('sidecar 停止：%s', reason)
    return 0
