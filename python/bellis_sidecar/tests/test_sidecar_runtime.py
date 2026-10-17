import asyncio
import os
import subprocess
import sys
from pathlib import Path

import pytest

from bellis_sidecar.channel import b64url
from bellis_sidecar.protocol import SidecarHealthResult
from bellis_sidecar.runtime import (
    ENV_CHANNEL_KEY,
    ENV_CHANNEL_PATH,
    ENV_ROLE,
    SidecarOptions,
    serve_sidecar,
)
from bellis_sidecar.testing import fake_host

KEY = bytes([5]) * 32
SRC = Path(__file__).resolve().parents[1] / 'src'


def env_for(path: str) -> dict[str, str]:
    return {ENV_CHANNEL_PATH: path, ENV_CHANNEL_KEY: b64url(KEY), ENV_ROLE: 'sidecar.tts-local'}


def test_answers_handshake_and_stops_on_shutdown():
    async def main() -> None:
        async def health() -> SidecarHealthResult:
            return SidecarHealthResult(ok=True, detail='ready')

        options = SidecarOptions(provides=['tts@1'], permissions=['speech.output'], health=health)
        async with fake_host(KEY) as (path, accepted):
            serving = asyncio.ensure_future(serve_sidecar(options, env_for(path), lifeline=False))
            host = await accepted.get()
            assert host.role == 'sidecar.tts-local'
            describe = await host.request(1, 'sidecar.describe')
            assert describe['result'] == {
                'protocol': 1,
                'provides': ['tts@1'],
                'permissions': ['speech.output'],
            }
            health_reply = await host.request(2, 'sidecar.health')
            assert health_reply['result'] == {'ok': True, 'detail': 'ready'}
            shutdown = await host.request(3, 'process.shutdown', {'reason': 'unload'})
            assert shutdown['result'] == {'accepted': True}
            assert await asyncio.wait_for(serving, 5) == 'shutdown'
            await host.close()

    asyncio.run(main())


def test_stops_when_the_host_disconnects():
    async def main() -> None:
        async with fake_host(KEY) as (path, accepted):
            serving = asyncio.ensure_future(
                serve_sidecar(SidecarOptions(provides=['tts@1']), env_for(path), lifeline=False)
            )
            host = await accepted.get()
            assert (await host.request(1, 'sidecar.health'))['result'] == {'ok': True}
            await host.close()
            assert await asyncio.wait_for(serving, 5) == 'closed'

    asyncio.run(main())


def test_missing_environment_is_an_error():
    with pytest.raises(RuntimeError):
        asyncio.run(serve_sidecar(SidecarOptions(provides=['tts@1']), {}, lifeline=False))


LIFELINE_SCRIPT = """
import asyncio
from bellis_sidecar.runtime import watch_lifeline

async def main():
    ended = asyncio.Event()
    watch_lifeline(ended.set)
    print('ready', flush=True)
    await ended.wait()
    print('eof', flush=True)

asyncio.run(main())
"""


#: 看着生命线的同时，另一个线程查询 stdin 的读写位置：Windows 上若有挂着的同步读，这一步会一直等下去
#: （原生库加载时 C 运行时初始化标准流就会这样查询，实测 `import torch` 因此卡死）。
LIFELINE_QUERY_SCRIPT = """
import asyncio, os, threading
from bellis_sidecar.runtime import watch_lifeline

async def main():
    ended = asyncio.Event()
    watch_lifeline(ended.set)
    await asyncio.sleep(0.3)
    done = threading.Event()
    def query():
        try:
            os.lseek(0, 0, os.SEEK_CUR)
        except OSError:
            pass
        done.set()
    threading.Thread(target=query, daemon=True).start()
    print('returned' if done.wait(3) else 'blocked', flush=True)
    await ended.wait()

asyncio.run(main())
"""


def test_lifeline_does_not_block_other_stdin_queries():
    env = {**os.environ, 'PYTHONPATH': str(SRC)}
    child = subprocess.Popen(
        [sys.executable, '-c', LIFELINE_QUERY_SCRIPT],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        env=env,
    )
    assert child.stdin is not None
    assert child.stdout is not None
    try:
        assert child.stdout.readline().strip() == b'returned'
        child.stdin.close()
        assert child.wait(10) == 0
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()


def test_lifeline_ends_when_stdin_closes():
    env = {**os.environ, 'PYTHONPATH': str(SRC)}
    child = subprocess.Popen(
        [sys.executable, '-c', LIFELINE_SCRIPT],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        env=env,
    )
    assert child.stdin is not None
    assert child.stdout is not None
    try:
        assert child.stdout.readline().strip() == b'ready'
        child.stdin.close()
        assert child.wait(10) == 0
        assert child.stdout.read().strip() == b'eof'
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
