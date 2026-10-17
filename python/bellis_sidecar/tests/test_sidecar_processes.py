import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

from bellis_sidecar.processes import contain_descendants, spawn, stop

SRC = Path(__file__).resolve().parents[1] / 'src'
LIFELINE_WORKER = 'import sys\nwhile sys.stdin.buffer.read(65536):\n    pass\n'
STUBBORN_WORKER = 'import time\ntime.sleep(60)\n'

#: 测试用的 sidecar：可选地先放进 Job Object，再派生一个不看 stdin 的子进程，打印其 pid 后一直运行。
PARENT_SCRIPT = """
import subprocess, sys, time
from bellis_sidecar.processes import contain_descendants
if sys.argv[1] == 'contain':
    contain_descendants()
child = subprocess.Popen(
    [sys.executable, '-c', 'import time; time.sleep(60)'],
    stdin=subprocess.DEVNULL,
    stdout=subprocess.DEVNULL,
)
print(child.pid, flush=True)
time.sleep(60)
"""


def test_stop_closes_stdin_then_kills():
    cooperative = spawn([sys.executable, '-c', LIFELINE_WORKER])
    assert stop(cooperative) == 'stdin-eof'
    assert stop(cooperative) == 'already-exited'
    stubborn = spawn([sys.executable, '-c', STUBBORN_WORKER])
    assert stop(stubborn, grace=0.5) == 'killed'
    assert stubborn.poll() is not None


@pytest.mark.skipif(
    sys.platform == 'win32', reason='Windows 上由下面的子进程用例验证，不在测试进程里建 Job'
)
def test_contain_descendants_is_skipped_elsewhere():
    assert contain_descendants() is False


if sys.platform == 'win32':
    import ctypes
    from ctypes import wintypes

    _kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    _open_process = _kernel32.OpenProcess
    _open_process.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    _open_process.restype = wintypes.HANDLE
    _wait = _kernel32.WaitForSingleObject
    _wait.argtypes = (wintypes.HANDLE, wintypes.DWORD)
    _wait.restype = wintypes.DWORD
    _close = _kernel32.CloseHandle
    _close.argtypes = (wintypes.HANDLE,)
    _close.restype = wintypes.BOOL
    _SYNCHRONIZE = 0x00100000
    _WAIT_TIMEOUT = 0x102

    def alive(pid: int) -> bool:
        handle = _open_process(_SYNCHRONIZE, False, pid)
        if not handle:
            return False
        try:
            return _wait(handle, 0) == _WAIT_TIMEOUT
        finally:
            _close(handle)
else:

    def alive(pid: int) -> bool:
        raise NotImplementedError


def wait_dead(pid: int, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not alive(pid):
            return True
        time.sleep(0.05)
    return not alive(pid)


def start_parent(mode: str) -> tuple[subprocess.Popen[bytes], int]:
    # 直接用基础解释器（不经 venv 的 python.exe 启动器），被终止的就是 sidecar 进程本身；
    # 父进程只用标准库与 bellis_sidecar.processes。
    base = getattr(sys, '_base_executable', sys.executable)
    parent = subprocess.Popen(
        [base, '-c', PARENT_SCRIPT, mode],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        env={**os.environ, 'PYTHONPATH': str(SRC)},
    )
    assert parent.stdout is not None
    child = int(parent.stdout.readline())
    return parent, child


@pytest.mark.skipif(sys.platform != 'win32', reason='Job Object 只在 Windows 上有（R-06）')
def test_job_object_kills_descendants_when_sidecar_is_killed():
    parent, child = start_parent('contain')
    try:
        assert alive(child)
        parent.kill()  # TerminateProcess：sidecar 来不及做任何收尾。
        parent.wait()
        assert wait_dead(child, 5), 'Job Object 应终止 sidecar 派生的进程'
    finally:
        if alive(child):
            os.kill(child, signal.SIGTERM)


@pytest.mark.skipif(sys.platform != 'win32', reason='Job Object 只在 Windows 上有（R-06）')
def test_without_job_object_descendants_survive():
    # 对照：不设 Job Object 时子进程残留，说明上一个用例确实由 Job Object 保证。
    parent, child = start_parent('none')
    try:
        parent.kill()
        parent.wait()
        time.sleep(0.5)
        assert alive(child)
    finally:
        if alive(child):
            os.kill(child, signal.SIGTERM)
