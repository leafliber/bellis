"""Windows Credential Manager (``CRED_TYPE_GENERIC``, UTF-16LE JSON) ``SessionInfo`` codec."""

from __future__ import annotations

import ctypes
import json
import re
import sys
from ctypes import wintypes
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Final, cast

from bellis_common.channel import wire

DEFAULT_SESSION_TARGET: Final = "session.bellis"
_SESSION_ID_RE = re.compile(r"[a-z0-9]{1,16}")
_RFC3339_RE = re.compile(
    r"(?P<y>\d{4})-(?P<m>\d{2})-(?P<d>\d{2})[Tt]"
    r"(?P<H>\d{2}):(?P<M>\d{2}):(?P<S>\d{2})(?:\.\d+)?"
    r"(?P<tz>[Zz]|(?P<sign>[+-])(?P<oh>\d{2}):(?P<om>\d{2}))"
)
_KEYS = frozenset({"v", "sessionId", "channelPath", "channelKey", "launcherPid", "startedAt"})
_U64_MAX = (1 << 64) - 1
_CRED_TYPE_GENERIC, _CRED_PERSIST_ENTERPRISE, _ERROR_NOT_FOUND = 1, 3, 1168
_adv: Any = ctypes.WinDLL("advapi32", use_last_error=True) if sys.platform == "win32" else None


class CredError(Exception):
    """Windows Credential Manager IO or ``SessionInfo`` error (never includes secret values)."""


def is_session_id(value: str) -> bool:
    return _SESSION_ID_RE.fullmatch(value) is not None


def _check(cond: bool, msg: str) -> None:
    if not cond:
        raise CredError(msg)


def _valid_rfc3339(text: str) -> bool:
    m = _RFC3339_RE.fullmatch(text)
    if m is None:
        return False
    y, mo, d, h, mi, s = (int(m[k]) for k in ("y", "m", "d", "H", "M", "S"))
    leap = y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)
    days = (0, 31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
    if not (1 <= mo <= 12 and 1 <= d <= days[mo]) or h > 23 or mi > 59 or s > 60:
        return False
    off = 0
    if m["tz"] not in {"Z", "z"}:
        oh, om = int(m["oh"]), int(m["om"])
        if oh > 23 or om > 59:
            return False
        off = (-1 if m["sign"] == "-" else 1) * (oh * 60 + om)
    return s < 60 or (h * 60 + mi - off) % 1440 == 1439


@dataclass(frozen=True, slots=True)
class SessionInfo:
    v: int
    session_id: str
    channel_path: str
    channel_key: str
    launcher_pid: int
    started_at: str

    def __post_init__(self) -> None:
        _check(not isinstance(self.v, bool) and self.v == 1, "SessionInfo.v must be 1")
        _check(is_session_id(self.session_id), "SessionInfo.sessionId is invalid")
        path = self.channel_path
        ok_pipe = sys.platform != "win32" or path.startswith(wire.PIPE_PREFIX)
        _check(ok_pipe and 1 <= len(path) <= 260 and "\0" not in path, "SessionInfo.channelPath")
        try:
            wire.decode_session_key(self.channel_key)
        except wire.ChannelError as exc:
            raise CredError("SessionInfo.channelKey is invalid") from exc
        pid = self.launcher_pid
        _check(not isinstance(pid, bool) and 1 <= pid <= _U64_MAX, "SessionInfo.launcherPid <= 0")
        _check(_valid_rfc3339(self.started_at), "SessionInfo.startedAt must be valid RFC 3339")

    def __repr__(self) -> str:
        return f"SessionInfo(id={self.session_id!r}, path={self.channel_path!r}, key=<redacted>)"

    @classmethod
    def create(
        cls, credentials: wire.ChannelCredentials, session_id: str, *, launcher_pid: int,
        started_at: datetime | None = None,
    ) -> SessionInfo:  # fmt: skip
        ts = datetime.now(UTC) if started_at is None else started_at
        _check(ts.tzinfo is not None, "started_at must be timezone-aware")
        stamp = ts.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        return cls(1, session_id, credentials.path, credentials.encoded_key, launcher_pid, stamp)

    def credentials(self) -> wire.ChannelCredentials:
        return wire.ChannelCredentials.decode(self.channel_path, self.channel_key)

    def to_dict(self) -> dict[str, object]:
        return {
            "v": self.v, "sessionId": self.session_id, "channelPath": self.channel_path,
            "channelKey": self.channel_key, "launcherPid": self.launcher_pid,
            "startedAt": self.started_at,
        }  # fmt: skip

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False, separators=(",", ":"))

    def to_utf16le(self) -> bytes:
        return self.to_json().encode("utf-16-le")

    @classmethod
    def from_dict(cls, raw: object) -> SessionInfo:
        _check(isinstance(raw, dict), "SessionInfo payload must be an object")
        obj = cast("dict[str, Any]", raw)
        _check(obj.keys() == _KEYS, "SessionInfo fields mismatch or unknown field present")
        v, sid, path = obj["v"], obj["sessionId"], obj["channelPath"]
        key, pid, started = obj["channelKey"], obj["launcherPid"], obj["startedAt"]
        _check(isinstance(v, int) and isinstance(pid, int), "SessionInfo int field mismatch")
        _check(all(isinstance(x, str) for x in (sid, path, key, started)), "SessionInfo str field")
        return cls(v, sid, path, key, pid, started)

    @classmethod
    def from_json(cls, text: str) -> SessionInfo:
        _check(text.lstrip().startswith("{"), "SessionInfo JSON must be an object")
        try:
            return cls.from_dict(json.loads(text))
        except json.JSONDecodeError as exc:
            raise CredError("SessionInfo is not valid JSON") from exc

    @classmethod
    def from_utf16le(cls, blob: bytes) -> SessionInfo:
        _check(bool(blob) and len(blob) % 2 == 0, "SessionInfo UTF-16LE blob length is invalid")
        try:
            return cls.from_json(blob.decode("utf-16-le"))
        except UnicodeDecodeError as exc:
            raise CredError("SessionInfo blob is not valid UTF-16LE") from exc


_DW, _WSTR, _CWSTR = wintypes.DWORD, wintypes.LPWSTR, wintypes.LPCWSTR
_BOOL, _PBYTE = wintypes.BOOL, ctypes.POINTER(ctypes.c_byte)


class _CredW(ctypes.Structure):
    _fields_ = [
        ("Flags", _DW), ("Type", _DW), ("TargetName", _WSTR), ("Comment", _WSTR),
        ("LastWritten", wintypes.FILETIME), ("CredentialBlobSize", _DW),
        ("CredentialBlob", _PBYTE), ("Persist", _DW), ("AttributeCount", _DW),
        ("Attributes", ctypes.c_void_p), ("TargetAlias", _WSTR), ("UserName", _WSTR),
    ]  # fmt: skip


_PCRED = ctypes.POINTER(_CredW)
if _adv is not None:
    _adv.CredWriteW.argtypes, _adv.CredWriteW.restype = (_PCRED, _DW), _BOOL
    _adv.CredReadW.argtypes = (_CWSTR, _DW, _DW, ctypes.POINTER(_PCRED))
    _adv.CredReadW.restype = _BOOL
    _adv.CredDeleteW.argtypes, _adv.CredDeleteW.restype = (_CWSTR, _DW, _DW), _BOOL
    _adv.CredFree.argtypes, _adv.CredFree.restype = (ctypes.c_void_p,), None


def _target_ok(target: str) -> None:
    _check(_adv is not None and bool(target) and "\0" not in target, "invalid CredMan target")


def write_session_info(info: SessionInfo, target: str = DEFAULT_SESSION_TARGET) -> None:
    _target_ok(target)
    blob = info.to_utf16le()
    buf = (ctypes.c_byte * len(blob)).from_buffer_copy(blob)
    cred = _CredW(
        Type=_CRED_TYPE_GENERIC, TargetName=target, CredentialBlobSize=len(blob),
        CredentialBlob=ctypes.cast(buf, _PBYTE), Persist=_CRED_PERSIST_ENTERPRISE,
        UserName="bellis",
    )  # fmt: skip
    if not _adv.CredWriteW(ctypes.byref(cred), 0):
        raise CredError(f"CredWriteW failed: {ctypes.WinError(ctypes.get_last_error())}")


def read_session_info(target: str = DEFAULT_SESSION_TARGET) -> SessionInfo | None:
    _target_ok(target)
    ptr = _PCRED()
    if not _adv.CredReadW(target, _CRED_TYPE_GENERIC, 0, ctypes.byref(ptr)):
        if ctypes.get_last_error() == _ERROR_NOT_FOUND:
            return None
        raise CredError(f"CredReadW failed: {ctypes.WinError(ctypes.get_last_error())}")
    try:
        raw = ctypes.string_at(ptr.contents.CredentialBlob, ptr.contents.CredentialBlobSize)
    finally:
        _adv.CredFree(ptr)
    return SessionInfo.from_utf16le(raw)


def delete_session_info(target: str = DEFAULT_SESSION_TARGET) -> bool:
    _target_ok(target)
    if not _adv.CredDeleteW(target, _CRED_TYPE_GENERIC, 0):
        if ctypes.get_last_error() == _ERROR_NOT_FOUND:
            return False
        raise CredError(f"CredDeleteW failed: {ctypes.WinError(ctypes.get_last_error())}")
    return True
