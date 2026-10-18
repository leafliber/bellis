import os
import subprocess
import sys
from pathlib import Path

import pytest

from bellis_sidecar.qos import EXECUTION_SPEED, declare_high_qos, qos_of, read_qos

SRC = Path(__file__).resolve().parents[1] / 'src'

#: 在子进程里声明 HighQoS 并读回，再直接用 SetProcessInformation 改成 EcoQoS、交还系统，各读回一次。
#: 放在子进程里，不改测试进程自己的节流状态。
CHILD_SCRIPT = """
import ctypes
from ctypes import wintypes
from bellis_sidecar.qos import declare_high_qos, read_qos

class Throttling(ctypes.Structure):
    _fields_ = (('Version', wintypes.ULONG), ('ControlMask', wintypes.ULONG),
                ('StateMask', wintypes.ULONG))

kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
kernel32.GetCurrentProcess.restype = wintypes.HANDLE
kernel32.SetProcessInformation.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p,
                                           wintypes.DWORD)
kernel32.SetProcessInformation.restype = wintypes.BOOL

def throttle(control, state):
    info = Throttling(1, control, state)
    assert kernel32.SetProcessInformation(kernel32.GetCurrentProcess(), 4, ctypes.byref(info),
                                          ctypes.sizeof(info))

print(read_qos(), declare_high_qos(), read_qos(), end=' ')
throttle(1, 1)
print(read_qos(), end=' ')
throttle(0, 0)
print(read_qos(), flush=True)
"""


def test_qos_of_reads_only_the_execution_speed_bit():
    assert qos_of(0, 0) == 'default'
    assert qos_of(0, EXECUTION_SPEED) == 'default'
    assert qos_of(EXECUTION_SPEED, 0) == 'high'
    assert qos_of(EXECUTION_SPEED, EXECUTION_SPEED) == 'eco'
    # 其它机制的位（例如 IGNORE_TIMER_RESOLUTION 0x4）不影响结果。
    assert qos_of(EXECUTION_SPEED | 0x4, 0x4) == 'high'


@pytest.mark.skipif(sys.platform == 'win32', reason='Windows 上由子进程用例验证')
def test_unsupported_elsewhere():
    assert read_qos() == 'unsupported'
    assert declare_high_qos() == 'unsupported'


@pytest.mark.skipif(sys.platform != 'win32', reason='ProcessPowerThrottling 只在 Windows 上有')
def test_declare_and_read_back_on_windows():
    result = subprocess.run(
        [sys.executable, '-c', CHILD_SCRIPT],
        capture_output=True,
        text=True,
        timeout=30,
        env={**os.environ, 'PYTHONPATH': str(SRC)},
        check=True,
    )
    # 新进程未显式设置 → 声明后读回 high → 被改成 EcoQoS → 交还系统管理。
    assert result.stdout.split() == ['default', 'high', 'high', 'eco', 'default']
