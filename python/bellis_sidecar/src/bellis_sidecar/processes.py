"""sidecar 派生的进程随 sidecar 退出（R-06）。只依赖标准库。

宿主强制终止 sidecar 时只能终止它的直接子进程；libuv 的 Job 允许孙进程脱离，
所以 sidecar 自己负责它派生的进程：

- Windows：`contain_descendants()` 把 sidecar 自己放进设了 KILL_ON_JOB_CLOSE 的 Job Object。
  之后派生的全部子孙进程（包括第三方库自己起的进程）都在这个 Job 里；
  不设 BREAKAWAY_OK，它们不能脱离。Job 的句柄只由 sidecar 持有、不被继承，也从不主动关闭：
  sidecar 无论怎样退出（含崩溃与被强制终止），系统关闭句柄时都会终止 Job 中剩下的进程。
- 其它平台没有 Job Object，跳过。`spawn` 派生的进程以 stdin 为生命线，
  sidecar 退出时读到 EOF 自行退出；不看生命线的第三方子进程在开发机上可能残留。
  生产平台只有 Windows（D-11）。
"""

from __future__ import annotations

import contextlib
import subprocess
import sys
from collections.abc import Mapping, Sequence

#: Job Object 的句柄；只为保持它在进程存活期间不被关闭。
_job: int | None = None


def contain_descendants() -> bool:
    """Windows 上把本进程放进 KILL_ON_JOB_CLOSE 的 Job Object，返回 True；其它平台返回 False。

    须在派生任何进程之前调用。失败时抛出 OSError：管不住子孙进程就不运行（R-06）。
    """
    global _job
    if sys.platform != 'win32':
        return False
    if _job is None:
        _job = _create_job_for_self()
    return True


def spawn(args: Sequence[str], *, env: Mapping[str, str] | None = None) -> subprocess.Popen[bytes]:
    """派生辅助进程：不经 shell、不开窗口，stdin 是生命线，stdout 丢弃、stderr 继承。"""
    flags = subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0
    return subprocess.Popen(
        list(args),
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        env=None if env is None else dict(env),
        shell=False,
        creationflags=flags,
    )


def stop(process: subprocess.Popen[bytes], grace: float = 2.0) -> str:
    """按 R-06 的后两步停止辅助进程：关闭 stdin 等它自行退出，超时再强制终止。

    返回它在哪一步退出：`already-exited`、`stdin-eof` 或 `killed`。
    """
    if process.poll() is not None:
        return 'already-exited'
    if process.stdin is not None:
        with contextlib.suppress(OSError):
            process.stdin.close()
    try:
        process.wait(grace)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
        return 'killed'
    return 'stdin-eof'


if sys.platform == 'win32':
    import ctypes
    from ctypes import wintypes

    _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
    _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9

    class _IoCounters(ctypes.Structure):
        _fields_ = (
            ('ReadOperationCount', ctypes.c_ulonglong),
            ('WriteOperationCount', ctypes.c_ulonglong),
            ('OtherOperationCount', ctypes.c_ulonglong),
            ('ReadTransferCount', ctypes.c_ulonglong),
            ('WriteTransferCount', ctypes.c_ulonglong),
            ('OtherTransferCount', ctypes.c_ulonglong),
        )

    class _BasicLimitInformation(ctypes.Structure):
        _fields_ = (
            ('PerProcessUserTimeLimit', ctypes.c_longlong),
            ('PerJobUserTimeLimit', ctypes.c_longlong),
            ('LimitFlags', wintypes.DWORD),
            ('MinimumWorkingSetSize', ctypes.c_size_t),
            ('MaximumWorkingSetSize', ctypes.c_size_t),
            ('ActiveProcessLimit', wintypes.DWORD),
            ('Affinity', ctypes.c_size_t),
            ('PriorityClass', wintypes.DWORD),
            ('SchedulingClass', wintypes.DWORD),
        )

    class _ExtendedLimitInformation(ctypes.Structure):
        _fields_ = (
            ('BasicLimitInformation', _BasicLimitInformation),
            ('IoInfo', _IoCounters),
            ('ProcessMemoryLimit', ctypes.c_size_t),
            ('JobMemoryLimit', ctypes.c_size_t),
            ('PeakProcessMemoryUsed', ctypes.c_size_t),
            ('PeakJobMemoryUsed', ctypes.c_size_t),
        )

    _kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    _create_job_object = _kernel32.CreateJobObjectW
    _create_job_object.argtypes = (ctypes.c_void_p, wintypes.LPCWSTR)
    _create_job_object.restype = wintypes.HANDLE
    _set_information_job_object = _kernel32.SetInformationJobObject
    _set_information_job_object.argtypes = (
        wintypes.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.DWORD,
    )
    _set_information_job_object.restype = wintypes.BOOL
    _assign_process_to_job_object = _kernel32.AssignProcessToJobObject
    _assign_process_to_job_object.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
    _assign_process_to_job_object.restype = wintypes.BOOL
    _get_current_process = _kernel32.GetCurrentProcess
    _get_current_process.argtypes = ()
    _get_current_process.restype = wintypes.HANDLE
    _close_handle = _kernel32.CloseHandle
    _close_handle.argtypes = (wintypes.HANDLE,)
    _close_handle.restype = wintypes.BOOL

    def _create_job_for_self() -> int:
        # 安全属性为 NULL：句柄不可继承，子进程拿不到它，Job 的寿命只取决于本进程。
        job = _create_job_object(None, None)
        if not job:
            raise ctypes.WinError(ctypes.get_last_error())
        info = _ExtendedLimitInformation()
        info.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        size = ctypes.sizeof(info)
        if not _set_information_job_object(
            job, _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS, ctypes.byref(info), size
        ):
            error = ctypes.WinError(ctypes.get_last_error())
            _close_handle(job)
            raise error
        # Windows 8 起支持嵌套 Job：本进程可能已在启动器（如 venv 的 python.exe）的 Job 里。
        if not _assign_process_to_job_object(job, _get_current_process()):
            error = ctypes.WinError(ctypes.get_last_error())
            _close_handle(job)
            raise error
        return int(job)
