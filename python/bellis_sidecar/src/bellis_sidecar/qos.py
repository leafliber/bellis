"""本进程的电源节流状态（Windows 的 QoS，见 Windows 平台“定时与调度”）。只依赖标准库。

- `declare_high_qos()`：需要的 sidecar 在启动时把本进程显式设为 HighQoS
  （ProcessPowerThrottling 的 ControlMask 含 EXECUTION_SPEED、StateMask 不含）。
  显式状态不被子进程继承，所以由真正做事的解释器给自己设置，不由宿主或 venv 的 python.exe 代设。
  设置失败只记日志，不影响运行。
- `read_qos()`：读回本进程此刻的状态，健康检查每次调用。
  之后被别人改成 EcoQoS（例如任务管理器的“效率模式”）时读回为 `eco`，开播预检据此报告。

取值与 `packages/protocol` 的 `SidecarQos` 一致：`high`、`eco`、
`default`（没有显式设置，由系统管理）、`unknown`（读取失败）、`unsupported`（不是 Windows）。
"""

from __future__ import annotations

import logging
import sys
from typing import Literal

Qos = Literal['high', 'eco', 'default', 'unknown', 'unsupported']

#: PROCESS_POWER_THROTTLING_EXECUTION_SPEED
EXECUTION_SPEED = 0x1

log = logging.getLogger('bellis_sidecar')


def qos_of(control_mask: int, state_mask: int) -> Qos:
    """由 ProcessPowerThrottling 的两个掩码得到 QoS：只看 EXECUTION_SPEED 一位。"""
    if not control_mask & EXECUTION_SPEED:
        return 'default'
    return 'eco' if state_mask & EXECUTION_SPEED else 'high'


def read_qos() -> Qos:
    if sys.platform != 'win32':
        return 'unsupported'
    masks = _get_throttling()
    return 'unknown' if masks is None else qos_of(*masks)


def declare_high_qos() -> Qos:
    """Windows 上把本进程设为 HighQoS 并返回读回值；其它平台返回 `unsupported`。"""
    if sys.platform != 'win32':
        return 'unsupported'
    error = _set_throttling(EXECUTION_SPEED, 0)
    if error is not None:
        log.warning('声明 HighQoS 失败：%s', error)
    qos = read_qos()
    if qos != 'high':
        log.warning('声明 HighQoS 后读回为 %s', qos)
    return qos


if sys.platform == 'win32':
    import ctypes
    from ctypes import wintypes

    _PROCESS_POWER_THROTTLING = 4
    _PROCESS_POWER_THROTTLING_CURRENT_VERSION = 1

    class _Throttling(ctypes.Structure):
        _fields_ = (
            ('Version', wintypes.ULONG),
            ('ControlMask', wintypes.ULONG),
            ('StateMask', wintypes.ULONG),
        )

    _kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    _get_current_process = _kernel32.GetCurrentProcess
    _get_current_process.argtypes = ()
    _get_current_process.restype = wintypes.HANDLE
    _get_process_information = _kernel32.GetProcessInformation
    _get_process_information.argtypes = (
        wintypes.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.DWORD,
    )
    _get_process_information.restype = wintypes.BOOL
    _set_process_information = _kernel32.SetProcessInformation
    _set_process_information.argtypes = (
        wintypes.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.DWORD,
    )
    _set_process_information.restype = wintypes.BOOL

    def _get_throttling() -> tuple[int, int] | None:
        try:
            info = _Throttling(Version=_PROCESS_POWER_THROTTLING_CURRENT_VERSION)
            ok = _get_process_information(
                _get_current_process(),
                _PROCESS_POWER_THROTTLING,
                ctypes.byref(info),
                ctypes.sizeof(info),
            )
        except OSError as error:
            log.warning('读不到节流状态：%s', error)
            return None
        if not ok:
            log.warning('读不到节流状态：%s', ctypes.WinError(ctypes.get_last_error()))
            return None
        return int(info.ControlMask), int(info.StateMask)

    def _set_throttling(control_mask: int, state_mask: int) -> OSError | None:
        try:
            info = _Throttling(
                Version=_PROCESS_POWER_THROTTLING_CURRENT_VERSION,
                ControlMask=control_mask,
                StateMask=state_mask,
            )
            ok = _set_process_information(
                _get_current_process(),
                _PROCESS_POWER_THROTTLING,
                ctypes.byref(info),
                ctypes.sizeof(info),
            )
        except OSError as error:
            return error
        return None if ok else ctypes.WinError(ctypes.get_last_error())
