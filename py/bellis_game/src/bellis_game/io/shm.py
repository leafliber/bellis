"""Windows named shared memory backed by ``CreateFileMappingW`` with current-user DACL."""

from __future__ import annotations

import base64
import ctypes
import mmap
import secrets
import sys
from collections.abc import Callable
from ctypes import wintypes
from typing import Any, Final

if sys.platform != "win32":
    raise ImportError("shm is Windows-only")

from bellis_common._winsecurity import (
    SecurityAttributes,
    SecurityDescriptor,
    current_user_only_sddl,
)

NAME_RANDOM_BYTES: Final = 16
_PAGE_READWRITE = 0x04
_ERROR_ALREADY_EXISTS = 183
_INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
_k32 = ctypes.WinDLL("kernel32", use_last_error=True)

_CreateFileMappingW: Any = _k32.CreateFileMappingW
_CreateFileMappingW.restype = wintypes.HANDLE
_CreateFileMappingW.argtypes = (
    wintypes.HANDLE,
    ctypes.POINTER(SecurityAttributes),
    wintypes.DWORD,
    wintypes.DWORD,
    wintypes.DWORD,
    wintypes.LPCWSTR,
)
_CloseHandle: Any = _k32.CloseHandle
_CloseHandle.restype = wintypes.BOOL
_CloseHandle.argtypes = (wintypes.HANDLE,)


def shared_memory_name(kind: str) -> str:
    token = base64.b32encode(secrets.token_bytes(NAME_RANDOM_BYTES)).decode("ascii")
    return f"Local\\bellis-{kind}-{token.rstrip('=').lower()}"


class SharedMemory:
    def __init__(
        self, name: str, size: int, buffer: mmap.mmap, destroy: Callable[[], None]
    ) -> None:
        self._name = name
        self._size = size
        self._buffer: mmap.mmap | None = buffer
        self._destroy = destroy

    @property
    def name(self) -> str:
        return self._name

    @property
    def size(self) -> int:
        return self._size

    @property
    def buffer(self) -> mmap.mmap:
        if self._buffer is None:
            raise ValueError(f"shared memory closed: {self._name}")
        return self._buffer

    @property
    def closed(self) -> bool:
        return self._buffer is None

    def close(self) -> None:
        if self._buffer is None:
            return
        self._buffer.close()
        self._buffer = None
        self._destroy()


def create_shared_memory(name: str, size: int) -> SharedMemory:
    if size <= 0:
        raise ValueError(f"shared memory size must be positive: {size}")
    sec = SecurityDescriptor(current_user_only_sddl())
    try:
        ctypes.set_last_error(0)
        handle = _CreateFileMappingW(
            _INVALID_HANDLE_VALUE,
            ctypes.byref(sec.attributes),
            _PAGE_READWRITE,
            size >> 32,
            size & 0xFFFFFFFF,
            name,
        )
        err = ctypes.get_last_error()
    finally:
        sec.free()
    if not handle:
        raise ctypes.WinError(err)
    if err == _ERROR_ALREADY_EXISTS:
        _CloseHandle(handle)
        raise FileExistsError(f"shared memory already exists: {name}")
    try:
        buf = mmap.mmap(-1, size, tagname=name)
    except BaseException:
        _CloseHandle(handle)
        raise
    return SharedMemory(name, size, buf, lambda: _CloseHandle(handle))
