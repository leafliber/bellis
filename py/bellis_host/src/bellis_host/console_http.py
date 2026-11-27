"""Loopback HTTP/1.1 framing, CSP headers, and cookie/CSRF sessions for ConsoleServer."""

import asyncio
import hmac
import json
import math
import re
import secrets
import time
from contextlib import suppress
from dataclasses import dataclass
from http import HTTPStatus
from http.cookies import CookieError, SimpleCookie
from pathlib import Path
from typing import cast

ASSETS = {
    "/": ("index.html", "text/html"),
    "/index.html": ("index.html", "text/html"),
    "/console.js": ("console.js", "text/javascript"),
    "/console.css": ("console.css", "text/css"),
}
COOKIE_NAME = "bellis_console"
COOKIE_FLAGS = "; HttpOnly; SameSite=Strict; Path=/"
_JSON_TYPE = re.compile(r'application/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?', re.I)
type Data = dict[str, object]


@dataclass(frozen=True)
class ConsoleConfig:
    host: str = "127.0.0.1"
    port: int = 0
    session_ttl_s: float = 43200.0
    static_dir: Path | None = None

    def __post_init__(self) -> None:
        if self.host != "127.0.0.1" or type(self.port) is not int or not 0 <= self.port <= 65535:
            raise ValueError("expected IPv4 loopback and valid port")
        if not 0 < self.session_ttl_s < math.inf:
            raise ValueError("expected finite positive session TTL")


class HttpError(Exception):
    def __init__(self, status: int):
        self.status = status


def matches_secret(value: object, secret: str | None) -> bool:
    return bool(
        secret and isinstance(value, str) and value.isascii() and hmac.compare_digest(value, secret)
    )


def require_text(data: Data, key: str, default: str = "") -> str:
    value = data.get(key, default)
    if not isinstance(value, str) or not value.strip():
        raise ValueError("expected non-empty text")
    value.encode("utf-8")
    return value


async def read_http_request(
    reader: asyncio.StreamReader, port: int
) -> tuple[str, str, dict[str, str], Data]:
    block = (await reader.readuntil(b"\r\n\r\n"))[:-4].decode("ascii")
    line, *lines = block.split("\r\n")
    match = re.fullmatch(r"(GET|POST) (/[\x21-\x7e]*) HTTP/1\.1", line)
    if not match:
        raise HttpError(400)
    method, path = match.groups()
    headers: dict[str, str] = {}
    for line in lines:
        match = re.fullmatch(r"([!#$%&'*+.^_|\x60~A-Za-z0-9-]+):[ \t]*([\x20-\x7e\t]*)", line)
        if not match or match[1].lower() in headers:
            raise HttpError(400)
        headers[match[1].lower()] = match[2].strip()
    host = headers.get("host")
    if host not in (f"127.0.0.1:{port}", f"localhost:{port}"):
        raise HttpError(403)
    length = headers.get("content-length", "0")
    if "transfer-encoding" in headers or not re.fullmatch("[0-9]+", length):
        raise HttpError(400)
    if len(length) > 6 or int(length) > 65536:
        raise HttpError(413)
    if method == "GET":
        if int(length):
            raise HttpError(400)
        return method, path, headers, {}
    if headers.get("origin") != f"http://{host}":
        raise HttpError(403)
    if not _JSON_TYPE.fullmatch(headers.get("content-type", "")):
        raise HttpError(415)
    if "content-length" not in headers:
        raise HttpError(411)
    obj = json.loads((await reader.readexactly(int(length))).decode("utf-8"))
    if not isinstance(obj, dict):
        raise HttpError(400)
    return method, path, headers, cast(Data, obj)


class ConsoleSessionAuth:
    def __init__(self, session_ttl_s: float) -> None:
        self._ttl_s = session_ttl_s
        self._token: str | None = None
        self._sessions: dict[str, tuple[str, float]] = {}

    def issue_login_url(self, port: int) -> str:
        self._token = secrets.token_urlsafe(32)
        return f"http://127.0.0.1:{port}/#token={self._token}"

    def authenticate(
        self, path: str, method: str, headers: dict[str, str], data: Data, response: dict[str, str]
    ) -> Data | None:
        if path == "/api/login" and method == "POST":
            if not matches_secret(data.get("token"), self._token):
                raise HttpError(401)
            self._token = None
            sid, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            now = time.monotonic()
            self._sessions = {k: v for k, v in self._sessions.items() if v[1] > now}
            self._sessions[sid] = csrf, now + self._ttl_s
            response["Set-Cookie"] = f"{COOKIE_NAME}={sid}{COOKIE_FLAGS}"
            return {"ok": True, "csrf": csrf}
        cookie = SimpleCookie()
        with suppress(CookieError):
            cookie.load(headers.get("cookie", ""))
        sid = cookie[COOKIE_NAME].value if COOKIE_NAME in cookie else ""
        session = self._sessions.get(sid)
        if not session or session[1] <= time.monotonic():
            self._sessions.pop(sid, None)
            raise HttpError(401)
        if method == "POST" and not matches_secret(headers.get("x-bellis-csrf"), session[0]):
            raise HttpError(403)
        if method == "POST" and path == "/api/logout":
            del self._sessions[sid]
            response["Set-Cookie"] = f"{COOKIE_NAME}=; Max-Age=0{COOKIE_FLAGS}"
            return {"ok": True}
        if method == "GET" and path == "/api/status":
            response["X-Bellis-Csrf"] = session[0]
        return None

    def clear(self) -> None:
        self._sessions.clear()
        self._token = None


async def write_http_response(
    writer: asyncio.StreamWriter,
    status: int,
    mime: str,
    body: bytes,
    extra: dict[str, str],
) -> None:
    if status != 200:
        mime, body = (
            "application/json",
            json.dumps({"error": HTTPStatus(status).phrase}).encode(),
        )
    fields = {
        "Content-Type": mime + "; charset=utf-8",
        "Content-Length": str(len(body)),
        "Connection": "close",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'",
        **extra,
    }
    head = f"HTTP/1.1 {status} {HTTPStatus(status).phrase}\r\n"
    writer.write(
        (head + "".join(f"{k}: {v}\r\n" for k, v in fields.items()) + "\r\n").encode() + body
    )
    await writer.drain()
