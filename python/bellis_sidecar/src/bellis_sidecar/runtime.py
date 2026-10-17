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


def run_blocking[**P, T](fn: Callable[P, T], *args: P.args, **kwargs: P.kwargs) -> Awaitable[T]:
    """在守护线程里运行阻塞调用（例如模型加载与推理），等待它的结果。

    不用 `asyncio.to_thread`：它的线程池在解释器退出时要等全部任务结束，按 R-06 停止时会被拖住。
    等待方被取消时线程照常跑完，结果丢弃。
    """
    loop = asyncio.get_running_loop()
    future: asyncio.Future[T] = loop.create_future()

    def resolve(result: T) -> None:
        if not future.done():
            future.set_result(result)

    def reject(error: BaseException) -> None:
        if not future.done():
            future.set_exception(error)

    def work() -> None:
        # 事件循环已关闭（进程正在退出）时 call_soon_threadsafe 抛 RuntimeError：结果丢弃。
        try:
            result = fn(*args, **kwargs)
        except BaseException as error:
            with contextlib.suppress(RuntimeError):
                loop.call_soon_threadsafe(reject, error)
        else:
            with contextlib.suppress(RuntimeError):
                loop.call_soon_threadsafe(resolve, result)

    threading.Thread(target=work, name='blocking', daemon=True).start()
    return future


#: Windows 上查看 stdin 管道是否已断开的间隔（秒）。
LIFELINE_POLL_S = 0.1


def _wait_eof_posix(fd: int) -> None:
    with contextlib.suppress(OSError):
        while os.read(fd, 65536):
            pass


def watch_lifeline(on_end: Callable[[], None], fd: int = 0) -> None:
    """stdin 只作生命线，不传数据：宿主关闭它（要求停止或已经退出）时在事件循环里调用 on_end。

    放在守护线程里：Windows 上宿主给的 stdin 管道不支持重叠 I/O，事件循环读不了。
    Windows 上不能让读一直挂着：同一文件对象上的同步 I/O 是串行的，挂着的 ReadFile 会让其它线程对
    stdin 的查询（例如原生库加载时 C 运行时初始化标准流）一直等下去——实测 `import torch` 因此卡死。
    所以 Windows 上用 PeekNamedPipe 轮询，管道断开即视为 EOF；其它平台照常阻塞读到 EOF。
    """
    loop = asyncio.get_running_loop()

    def watch() -> None:
        if sys.platform == 'win32':
            _wait_eof_windows(fd)
        else:
            _wait_eof_posix(fd)
        with contextlib.suppress(RuntimeError):
            loop.call_soon_threadsafe(on_end)

    threading.Thread(target=watch, name='lifeline', daemon=True).start()


if sys.platform == 'win32':
    import _winapi
    import msvcrt
    import time

    def _wait_eof_windows(fd: int) -> None:
        handle = msvcrt.get_osfhandle(fd)
        while True:
            try:
                peeked = _winapi.PeekNamedPipe(handle, 0)
            except BrokenPipeError:
                return
            except OSError:
                # 不是管道（例如手工在控制台里运行）：没有生命线可看，只靠 RPC 与连接断开退出。
                log.warning('stdin 不是管道，不看生命线')
                threading.Event().wait()
                return
            # size 为 0 时返回（可读字节数, 消息剩余字节数）。
            available = peeked[0]
            if isinstance(available, int) and available > 0:
                # 宿主不往 stdin 写数据；有数据时读掉（此时不会阻塞）。
                os.read(fd, available)
            time.sleep(LIFELINE_POLL_S)


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
