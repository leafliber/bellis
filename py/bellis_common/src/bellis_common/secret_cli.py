"""Interactive Windows Credential Manager CLI (no echo, never logs secret values)."""

from __future__ import annotations

import getpass
import json
import re
from collections.abc import Callable, Sequence
from typing import Final, Protocol

from . import cred
from .agent_events import DEFAULT_GAME_LINK_TARGET

SECRET_USAGE: Final = "usage: bellis secret <list | set <target> | delete <target>>"
MANAGED_TARGETS: Final = frozenset(
    {cred.DEFAULT_SESSION_TARGET, DEFAULT_GAME_LINK_TARGET, cred.DEFAULT_CORE_TARGET}
)
SECRET_NAME_RE: Final = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
DEFAULT_OBS_URL: Final = "ws://127.0.0.1:4455"
_OBS_URL_RE: Final = re.compile(r"^ws://(?:127\.0\.0\.1|localhost):([0-9]{1,5})/?$")


class SecretStore(Protocol):
    def list_targets(self) -> list[str]: ...
    def exists(self, target: str) -> bool: ...
    def write(self, target: str, value: str) -> None: ...
    def delete(self, target: str) -> bool: ...


class CredManSecretStore:
    def __init__(self, suffix: str = ".bellis") -> None:
        self._suffix = suffix

    def list_targets(self) -> list[str]:
        return cred.list_secret_targets(self._suffix)

    def exists(self, target: str) -> bool:
        return cred.read_secret_text(target) is not None

    def write(self, target: str, value: str) -> None:
        cred.write_secret_text(target, value)

    def delete(self, target: str) -> bool:
        return cred.delete_secret(target)


class Prompter(Protocol):
    def ask(self, prompt: str, *, hidden: bool) -> str: ...


class ConsolePrompter:
    def ask(self, prompt: str, *, hidden: bool) -> str:
        return getpass.getpass(prompt) if hidden else input(prompt)


def _ask_twice(prompt: Prompter, label: str, emit: Callable[[str], None]) -> str | None:
    first = prompt.ask(f"{label}: ", hidden=True)
    second = prompt.ask("Confirm again: ", hidden=True)
    if first != second:
        emit("Values did not match; nothing written.")
        return None
    return first


def _build_obs_payload(prompt: Prompter, emit: Callable[[str], None]) -> str | None:
    url = prompt.ask(f"obs-websocket URL [default {DEFAULT_OBS_URL}]: ", hidden=False).strip()
    url = url or DEFAULT_OBS_URL
    match = _OBS_URL_RE.fullmatch(url)
    if not match or not 0 < int(match[1]) <= 65535:
        emit("OBS URL must be a loopback ws://127.0.0.1:<port> or ws://localhost:<port> address.")
        return None
    password = _ask_twice(prompt, "obs-websocket password (hidden; press Enter if unset)", emit)
    if password is None:
        return None
    payload = {"url": url, "password": password} if password else {"url": url}
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def run_secret_command(
    argv: Sequence[str],
    *,
    store: SecretStore | None = None,
    prompter: Prompter | None = None,
    emit: Callable[[str], None] = print,
) -> int:
    active_store = CredManSecretStore() if store is None else store
    active_prompt = ConsolePrompter() if prompter is None else prompter
    if not argv:
        emit(SECRET_USAGE)
        return 2
    cmd, *rest = argv
    if cmd == "list":
        if rest:
            emit(SECRET_USAGE)
            return 2
        try:
            names = active_store.list_targets()
        except cred.CredError as exc:
            emit(f"Failed to list credentials: {exc}")
            return 1
        if not names:
            emit("(no credentials)")
            return 0
        for name in names:
            suffix = " (launcher-managed)" if name in MANAGED_TARGETS else ""
            emit(f"{name}{suffix}")
        return 0

    if cmd not in {"set", "delete"} or len(rest) != 1:
        emit(SECRET_USAGE)
        return 2
    target = rest[0]
    if not SECRET_NAME_RE.fullmatch(target):
        emit(f"Invalid credential target name: {target!r}")
        return 2
    if target in MANAGED_TARGETS:
        emit(f"{target} is managed by the launcher and cannot be modified manually.")
        return 1

    try:
        if cmd == "delete":
            emit(f"Deleted {target}." if active_store.delete(target) else f"{target} not found.")
            return 0
        existed = active_store.exists(target)
        if target == cred.DEFAULT_OBS_TARGET:
            value = _build_obs_payload(active_prompt, emit)
            if value is None:
                return 1
        else:
            value = _ask_twice(active_prompt, f"Secret value for {target} (hidden)", emit)
            if value is None:
                return 1
            if not value:
                emit("Empty value rejected; nothing written.")
                return 1
        active_store.write(target, value)
        emit(f"Updated {target}." if existed else f"Stored {target}.")
        return 0
    except (EOFError, KeyboardInterrupt):
        emit("Cancelled.")
        return 1
    except cred.CredError as exc:
        emit(f"Credential store error: {exc}")
        return 1
