r"""探针 S-03 的 Python 端，由 spikes/s03-pipe.ts 拉起，结果以 JSON 行写到 stdout。

  rtt    以 sidecar 身份连接，测握手耗时与 `spike.echo` 往返时延
  probe  只连接一次，报告握手结果（成功，或 auth-failed 等错误码）
  squat  抢注者（仅 Windows）：在给定管道名上建实例，给连上来的客户端回伪造的 challenge，
         记录之后还收到多少字节；stdin 关闭时退出。`--reject-remote` 时实例带
         PIPE_REJECT_REMOTE_CLIENTS，作为判断 `\\localhost\pipe\…` 是否算远程连接的对照

会话密钥从环境变量 BELLIS_CHANNEL_KEY 读取（base64url）。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import secrets
import struct
import sys
import threading
import time
from typing import Any

from bellis_channel import (
    HANDSHAKE_MAX_FRAME_BYTES,
    KEY_ENV,
    KIND_HANDSHAKE,
    ChannelError,
    RpcClient,
    b64url,
    connect,
    decode_session_key,
    dumps,
    encode_frame,
)

ROLE = 'sidecar.s03'
_lock = threading.Lock()


def emit(record: dict[str, Any]) -> None:
    with _lock:
        sys.stdout.write(json.dumps(record, ensure_ascii=False) + '\n')
        sys.stdout.flush()


def percentile(sorted_values: list[float], q: float) -> float:
    """与 Node 侧相同的取法。"""
    index = min(len(sorted_values) - 1, int(q * len(sorted_values)))
    return sorted_values[index]


def summarize(values_us: list[float]) -> dict[str, float]:
    ordered = sorted(values_us)
    return {
        'count': len(ordered),
        'p50Us': round(percentile(ordered, 0.5), 1),
        'p90Us': round(percentile(ordered, 0.9), 1),
        'p99Us': round(percentile(ordered, 0.99), 1),
        'maxUs': round(ordered[-1], 1),
        'meanUs': round(sum(ordered) / len(ordered), 1),
    }


async def rtt(path: str, key: bytes, sizes: list[int], count: int, warmup: int, connects: int):
    handshakes: list[float] = []
    for _ in range(connects):
        started = time.perf_counter_ns()
        connection = await connect(path, ROLE, key)
        handshakes.append((time.perf_counter_ns() - started) / 1000)
        await connection.close()

    rpc = RpcClient(await connect(path, ROLE, key))
    results: list[dict[str, Any]] = []
    try:
        for size in sizes:
            params = {'data': 'x' * size}
            for _ in range(warmup):
                await rpc.request('spike.echo', params)
            samples: list[float] = []
            for _ in range(count):
                started = time.perf_counter_ns()
                reply = await rpc.request('spike.echo', params)
                samples.append((time.perf_counter_ns() - started) / 1000)
                if reply != params:
                    raise RuntimeError('回显内容不一致')
            results.append({'bytes': size, **summarize(samples)})
    finally:
        await rpc.close()
    emit({'event': 'rtt', 'handshake': summarize(handshakes), 'sizes': results})


async def probe(path: str, key: bytes) -> None:
    try:
        connection = await connect(path, ROLE, key)
    except ChannelError as error:
        emit({'event': 'probe', 'ok': False, 'code': error.code, 'message': str(error)})
        return
    except OSError as error:
        emit({'event': 'probe', 'ok': False, 'code': 'os-error', 'message': str(error)})
        return
    await connection.close()
    emit({'event': 'probe', 'ok': True})


def squat(path: str, reject_remote: bool) -> None:
    if sys.platform != 'win32':
        emit({'event': 'squat', 'ok': False, 'message': 'unsupported：只在 Windows 上测抢注'})
        return
    import _winapi

    # 字节模式：PIPE_TYPE_BYTE 与 PIPE_READMODE_BYTE 都是 0；_winapi 没有导出
    # PIPE_REJECT_REMOTE_CLIENTS（0x8）。
    pipe_mode = _winapi.PIPE_WAIT | (0x8 if reject_remote else 0)

    def read_exact(handle: int, n: int) -> bytes:
        data = b''
        while len(data) < n:
            chunk, _ = _winapi.ReadFile(handle, n - len(data))
            if not chunk:
                raise BrokenPipeError
            data += chunk
        return data

    def serve(handle: int, index: int) -> None:
        record: dict[str, Any] = {'event': 'client', 'index': index}
        try:
            length, kind = struct.unpack('>IB', read_exact(handle, 5))
            if kind != KIND_HANDSHAKE or length > HANDSHAKE_MAX_FRAME_BYTES:
                record['hello'] = None
            else:
                hello = json.loads(read_exact(handle, length))
                record['hello'] = {'role': hello.get('role'), 'type': hello.get('type')}
            fake = b64url(secrets.token_bytes(32))
            challenge = {'v': 1, 'type': 'challenge', 'nonce': fake, 'proof': fake}
            _winapi.WriteFile(handle, encode_frame(KIND_HANDSHAKE, dumps(challenge)))
            after = 0
            started = time.perf_counter()
            try:
                while True:
                    chunk, _ = _winapi.ReadFile(handle, 65536)
                    if not chunk:
                        break
                    after += len(chunk)
            except OSError:
                pass
            record['bytesAfterChallenge'] = after
            record['closedAfterMs'] = round((time.perf_counter() - started) * 1000, 1)
        except OSError as error:
            record['error'] = str(error)
        finally:
            _winapi.CloseHandle(handle)
        emit(record)

    def listen() -> None:
        index = 0
        while True:
            try:
                handle = _winapi.CreateNamedPipe(
                    path,
                    _winapi.PIPE_ACCESS_DUPLEX,
                    pipe_mode,
                    _winapi.PIPE_UNLIMITED_INSTANCES,
                    65536,
                    65536,
                    0,
                    _winapi.NULL,
                )
            except OSError as error:
                emit({'event': 'created', 'ok': False, 'index': index, 'message': str(error)})
                return
            if index == 0:
                emit({'event': 'created', 'ok': True})
            try:
                _winapi.ConnectNamedPipe(handle)
            except OSError as error:
                if error.winerror != _winapi.ERROR_PIPE_CONNECTED:
                    _winapi.CloseHandle(handle)
                    continue
            threading.Thread(target=serve, args=(handle, index), daemon=True).start()
            index += 1

    threading.Thread(target=listen, daemon=True).start()
    sys.stdin.read()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['rtt', 'probe', 'squat'])
    parser.add_argument('--path', required=True)
    parser.add_argument('--sizes', default='64,4096,65536')
    parser.add_argument('--count', type=int, default=2000)
    parser.add_argument('--warmup', type=int, default=200)
    parser.add_argument('--connects', type=int, default=50)
    parser.add_argument('--reject-remote', action='store_true')
    args = parser.parse_args()
    if args.mode == 'squat':
        squat(args.path, args.reject_remote)
        return
    key = decode_session_key(os.environ[KEY_ENV])
    if args.mode == 'probe':
        asyncio.run(probe(args.path, key))
        return
    sizes = [int(size) for size in args.sizes.split(',')]
    asyncio.run(rtt(args.path, key, sizes, args.count, args.warmup, args.connects))


if __name__ == '__main__':
    main()
