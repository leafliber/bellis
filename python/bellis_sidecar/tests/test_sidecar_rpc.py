import asyncio
from collections.abc import Awaitable, Callable

import pytest

from bellis_sidecar.channel import KIND_BINARY, ChannelError, connect
from bellis_sidecar.rpc import (
    INTERNAL_ERROR,
    INVALID_REQUEST,
    METHOD_NOT_FOUND,
    SERVER_BUSY,
    Params,
    RpcError,
    RpcPeer,
)
from bellis_sidecar.testing import HostSide, fake_host

KEY = bytes([9]) * 32


def run(body: Callable[[RpcPeer, HostSide], Awaitable[None]], max_inflight: int = 64) -> None:
    async def main() -> None:
        async with fake_host(KEY) as (path, accepted):
            connection = await connect(path, 'sidecar.test', KEY)
            peer = RpcPeer(connection, max_inflight=max_inflight)
            host = await accepted.get()
            try:
                await body(peer, host)
            finally:
                await peer.close()
                await host.close()

    asyncio.run(main())


def test_serves_host_requests_and_hides_internal_errors():
    async def body(peer: RpcPeer, host: HostSide) -> None:
        async def echo(params: Params) -> object:
            return params

        async def refuse(_params: Params) -> object:
            raise RpcError(-32001, '不行', {'why': 'test'})

        async def broken(_params: Params) -> object:
            raise ValueError('内部细节')

        peer.handle('echo.say', echo)
        peer.handle('test.refuse', refuse)
        peer.handle('test.broken', broken)

        assert (await host.request(1, 'echo.say', {'text': '你好'}))['result'] == {'text': '你好'}
        assert (await host.request(2, 'echo.say'))['result'] == {}
        refused = await host.request(3, 'test.refuse')
        assert refused['error'] == {'code': -32001, 'message': '不行', 'data': {'why': 'test'}}
        assert (await host.request(4, 'test.broken'))['error'] == {
            'code': INTERNAL_ERROR,
            'message': 'Internal error',
        }
        assert (await host.request(5, 'no.such'))['error']['code'] == METHOD_NOT_FOUND

        host.send({'jsonrpc': '2.0', 'id': 6, 'method': 'nodots'})
        invalid = await host.receive_json()
        assert invalid['id'] is None
        assert invalid['error']['code'] == INVALID_REQUEST
        # 只接受按名传参的对象。
        host.send({'jsonrpc': '2.0', 'id': 7, 'method': 'echo.say', 'params': [1]})
        assert (await host.receive_json())['error']['code'] == INVALID_REQUEST

    run(body)


def test_rpc_cancel_cancels_the_handler():
    async def body(peer: RpcPeer, host: HostSide) -> None:
        cancelled = asyncio.Event()

        async def wait(_params: Params) -> object:
            try:
                await asyncio.sleep(60)
            except asyncio.CancelledError:
                cancelled.set()
                raise
            return None

        peer.handle('test.wait', wait)
        host.send({'jsonrpc': '2.0', 'id': 1, 'method': 'test.wait'})
        await asyncio.sleep(0.05)
        host.send({'jsonrpc': '2.0', 'method': 'rpc.cancel', 'params': {'id': 1}})
        reply = await host.receive_json()
        assert reply['id'] == 1
        assert reply['error']['message'] == 'Request cancelled'
        assert cancelled.is_set()

    run(body)


def test_server_busy_beyond_inflight_limit():
    async def body(peer: RpcPeer, host: HostSide) -> None:
        release = asyncio.Event()

        async def hold(_params: Params) -> object:
            await release.wait()
            return 'done'

        peer.handle('test.hold', hold)
        host.send({'jsonrpc': '2.0', 'id': 1, 'method': 'test.hold'})
        await asyncio.sleep(0.05)
        assert (await host.request(2, 'test.hold'))['error']['code'] == SERVER_BUSY
        release.set()
        assert (await host.receive_json())['result'] == 'done'

    run(body, max_inflight=1)


def test_requests_to_host_resolve_fail_and_time_out():
    async def body(peer: RpcPeer, host: HostSide) -> None:
        pending = asyncio.ensure_future(peer.request('host.ask', {'q': 1}))
        request = await host.receive_json()
        assert request['method'] == 'host.ask'
        assert request['params'] == {'q': 1}
        host.send({'jsonrpc': '2.0', 'id': request['id'], 'result': 42})
        assert await pending == 42

        failing = asyncio.ensure_future(peer.request('host.ask'))
        request = await host.receive_json()
        host.send({'jsonrpc': '2.0', 'id': request['id'], 'error': {'code': 7, 'message': 'no'}})
        with pytest.raises(RpcError) as caught:
            await failing
        assert caught.value.code == 7

        with pytest.raises(ChannelError) as timeout:
            await peer.request('host.slow', timeout=0.1)
        assert timeout.value.code == 'timeout'
        slow = await host.receive_json()
        cancel = await host.receive_json()
        assert cancel == {'jsonrpc': '2.0', 'method': 'rpc.cancel', 'params': {'id': slow['id']}}

    run(body)


def test_binary_frames_both_ways():
    async def main() -> None:
        received: list[bytes] = []
        async with fake_host(KEY) as (path, accepted):
            peer = RpcPeer(await connect(path, 'sidecar.test', KEY), on_binary=received.append)
            host = await accepted.get()
            await peer.send_binary(b'\x00\x01pcm')
            assert await host.receive() == (KIND_BINARY, b'\x00\x01pcm')
            host.send_raw(KIND_BINARY, b'from-host')
            await asyncio.sleep(0.05)
            assert received == [b'from-host']
            await peer.close()
            await host.close()

    asyncio.run(main())


def test_host_closing_fails_pending_requests_and_cancels_handlers():
    async def main() -> None:
        async with fake_host(KEY) as (path, accepted):
            peer = RpcPeer(await connect(path, 'sidecar.test', KEY))
            host = await accepted.get()
            cancelled = asyncio.Event()

            async def wait(_params: Params) -> object:
                try:
                    await asyncio.sleep(60)
                except asyncio.CancelledError:
                    cancelled.set()
                    raise
                return None

            peer.handle('test.wait', wait)
            host.send({'jsonrpc': '2.0', 'id': 1, 'method': 'test.wait'})
            pending = asyncio.ensure_future(peer.request('host.ask', timeout=10))
            await host.receive_json()
            await host.close()
            with pytest.raises(ChannelError) as caught:
                await pending
            assert caught.value.code == 'closed'
            assert await asyncio.wait_for(peer.closed, 5) is None
            await asyncio.sleep(0)
            assert cancelled.is_set()
            await peer.close()

    asyncio.run(main())
