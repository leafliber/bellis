"""Windows current-user-only security descriptor helpers (DACL ``D:P(A;;GA;;;<SID>)``)."""

from __future__ import annotations

import sys

if sys.platform != "win32":
    raise ImportError("_winsecurity is Windows-only")

import ctypes
from ctypes import wintypes
from typing import Any

_ERROR_INSUFFICIENT_BUFFER = 122
_TOKEN_QUERY = 0x0008
_TOKEN_USER = 1
_SDDL_REVISION_1 = 1
_k32 = ctypes.WinDLL("kernel32", use_last_error=True)
_adv = ctypes.WinDLL("advapi32", use_last_error=True)


def _fn(lib: ctypes.WinDLL, name: str, restype: Any, *argtypes: Any) -> Any:
    fn = getattr(lib, name)
    fn.restype, fn.argtypes = restype, argtypes
    return fn


_GetCurrentProcess = _fn(_k32, "GetCurrentProcess", wintypes.HANDLE)
_CloseHandle = _fn(_k32, "CloseHandle", wintypes.BOOL, wintypes.HANDLE)
_LocalFree = _fn(_k32, "LocalFree", wintypes.HLOCAL, wintypes.HLOCAL)
_OpenProcessToken = _fn(
    _adv,
    "OpenProcessToken",
    wintypes.BOOL,
    wintypes.HANDLE,
    wintypes.DWORD,
    ctypes.POINTER(wintypes.HANDLE),
)
_GetTokenInfo = _fn(
    _adv,
    "GetTokenInformation",
    wintypes.BOOL,
    wintypes.HANDLE,
    ctypes.c_int,
    wintypes.LPVOID,
    wintypes.DWORD,
    ctypes.POINTER(wintypes.DWORD),
)
_SidToString = _fn(
    _adv,
    "ConvertSidToStringSidW",
    wintypes.BOOL,
    wintypes.LPVOID,
    ctypes.POINTER(wintypes.LPWSTR),
)
_SddlToSd = _fn(
    _adv,
    "ConvertStringSecurityDescriptorToSecurityDescriptorW",
    wintypes.BOOL,
    wintypes.LPCWSTR,
    wintypes.DWORD,
    ctypes.POINTER(wintypes.LPVOID),
    ctypes.POINTER(wintypes.ULONG),
)


class SecurityAttributes(ctypes.Structure):
    _fields_ = (
        ("nLength", wintypes.DWORD),
        ("lpSecurityDescriptor", wintypes.LPVOID),
        ("bInheritHandle", wintypes.BOOL),
    )


def _check(ok: object) -> None:
    if not ok:
        raise ctypes.WinError(ctypes.get_last_error())


def current_user_sid() -> str:
    token = wintypes.HANDLE()
    _check(_OpenProcessToken(_GetCurrentProcess(), _TOKEN_QUERY, ctypes.byref(token)))
    try:
        size = wintypes.DWORD()
        if _GetTokenInfo(token, _TOKEN_USER, None, 0, ctypes.byref(size)):
            raise OSError("GetTokenInformation unexpectedly succeeded without buffer")
        if ctypes.get_last_error() != _ERROR_INSUFFICIENT_BUFFER:
            raise ctypes.WinError(ctypes.get_last_error())
        buf = ctypes.create_string_buffer(size.value)
        _check(_GetTokenInfo(token, _TOKEN_USER, buf, size, ctypes.byref(size)))
        sid = ctypes.cast(buf, ctypes.POINTER(wintypes.LPVOID))[0]
        text = wintypes.LPWSTR()
        _check(_SidToString(sid, ctypes.byref(text)))
        try:
            value = text.value
        finally:
            _LocalFree(ctypes.cast(text, wintypes.HLOCAL))
    finally:
        _CloseHandle(token)
    if value is None:
        raise OSError("ConvertSidToStringSidW returned null")
    return value


def current_user_only_sddl() -> str:
    return f"D:P(A;;GA;;;{current_user_sid()})"


class SecurityDescriptor:
    def __init__(self, sddl: str) -> None:
        sd = wintypes.LPVOID()
        _check(_SddlToSd(sddl, _SDDL_REVISION_1, ctypes.byref(sd), None))
        self._sd = sd
        self.attributes = SecurityAttributes(ctypes.sizeof(SecurityAttributes), sd, False)

    def free(self) -> None:
        if self._sd.value is not None:
            _LocalFree(ctypes.cast(self._sd, wintypes.HLOCAL))
            self._sd = wintypes.LPVOID()
