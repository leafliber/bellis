"""On-demand elevated Windows Scheduled Task XML generation, readback check, and trigger."""

from __future__ import annotations

import ntpath
import os
import re
import subprocess
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Final, Literal

from .cred import DEFAULT_CORE_TARGET, DEFAULT_SESSION_TARGET

_TASK_NS: Final = "http://schemas.microsoft.com/windows/2004/02/mit/task"
TASK_PRIORITY: Final = 5
DEFAULT_TASK_NAME: Final = "BellisRealtimeCore"
DEFAULT_INSTALL_DIR: Final = r"C:\Program Files\Bellis"
DEFAULT_EMERGENCY_HOTKEY: Final = "ctrl+shift+f12"
_TASK_DESC: Final = "Bellis on-demand elevated realtime-core task (registered by maintainer)"
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_ELEMENT = re.compile(r"<([A-Za-z][\w.-]*)(?:\s[^>]*?)?(?:/>|>([\s\S]*?)</\1\s*>)")
_SID = re.compile(r"S-1-\d+(-\d+)+", re.IGNORECASE)
_TASK_NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_MISSING: Final = "(missing)"


@dataclass(frozen=True, slots=True)
class OnDemandTask:
    user_id: str
    command: str
    args: tuple[str, ...]
    working_directory: str
    description: str = _TASK_DESC


def valid_task_name(name: str) -> str:
    if not _TASK_NAME_RE.fullmatch(name):
        raise ValueError(f"invalid task name: {name!r}")
    return name


def current_user_id(username: str | None, domain: str | None) -> str:
    def ok(part: str | None) -> bool:
        return bool(part and part.strip() and not re.search(r"[\\/]|[\x00-\x1f]", part))

    if not ok(domain) or not ok(username):
        raise ValueError("USERDOMAIN and USERNAME are required to scope the task to current user")
    return f"{domain}\\{username}"


def current_user_id_from_env(env: Mapping[str, str] | None = None) -> str:
    source = os.environ if env is None else env
    return current_user_id(source.get("USERNAME"), source.get("USERDOMAIN"))


def default_core_task(
    install_dir: str = DEFAULT_INSTALL_DIR,
    *,
    user_id: str | None = None,
    core_cred: str = DEFAULT_CORE_TARGET,
    permit_cred: str | None = DEFAULT_SESSION_TARGET,
    emergency_hotkey: str | None = DEFAULT_EMERGENCY_HOTKEY,
    env: Mapping[str, str] | None = None,
) -> OnDemandTask:
    args: list[str] = ["--core-cred", core_cred]
    if permit_cred is not None:
        args.extend(["--permit-cred", permit_cred])
        if emergency_hotkey is not None:
            args.extend(["--emergency-hotkey", emergency_hotkey])
    elif emergency_hotkey is not None:
        raise ValueError("emergency_hotkey requires permit_cred")
    uid = user_id or current_user_id_from_env(env)
    return OnDemandTask(
        user_id=uid,
        command=ntpath.join(install_dir, "realtime-core.exe"),
        args=tuple(args),
        working_directory=install_dir,
    )


def _check_exec_field(label: str, text: str) -> None:
    if not text or _CONTROL.search(text):
        raise ValueError(f"{label} is empty or contains control characters")
    if "%" in text or '"' in text:
        raise ValueError(f"{label} must not contain '%' or '\"'")


def quote_windows_arg(arg: str) -> str:
    if '"' in arg:
        raise ValueError(f"argument contains quote: {arg!r}")
    match = re.search(r"\\*$", arg)
    trailing = len(match.group(0)) if match else 0
    return f'"{arg}{"\\" * trailing}"'


def split_windows_args(line: str) -> list[str]:
    args: list[str] = []
    cur: list[str] = []
    quoted = started = False
    i = 0
    while i < len(line):
        ch = line[i]
        if ch == "\\":
            count = 0
            while i < len(line) and line[i] == "\\":
                count += 1
                i += 1
            if i < len(line) and line[i] == '"':
                cur.append("\\" * (count // 2))
                if count % 2:
                    cur.append('"')
                    i += 1
            else:
                cur.append("\\" * count)
            started = True
        elif ch == '"':
            quoted = not quoted
            started = True
            i += 1
        elif not quoted and ch in " \t":
            if started:
                args.append("".join(cur))
            cur, started = [], False
            i += 1
        else:
            cur.append(ch)
            started = True
            i += 1
    if started:
        args.append("".join(cur))
    return args


def escape_xml(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


def _unescape_xml(text: str) -> str:
    named = {"amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'"}

    def repl(m: re.Match[str]) -> str:
        body = m.group(1)
        if body[0] == "#":
            return chr(int(body[2:], 16) if body[1] in "xX" else int(body[1:]))
        return named.get(body, m.group(0))

    return re.sub(r"&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);", repl, text)


def task_xml(task: OnDemandTask) -> str:
    if _CONTROL.search(task.user_id) or not re.fullmatch(r"[^\\]+\\[^\\]+", task.user_id):
        raise ValueError(f"user_id must be DOMAIN\\User, got {task.user_id!r}")
    if _CONTROL.search(task.description):
        raise ValueError("description contains control characters")
    for label, path in (("command", task.command), ("working_directory", task.working_directory)):
        _check_exec_field(label, path)
        if not ntpath.isabs(path):
            raise ValueError(f"{label} must be an absolute Windows path: {path!r}")
    for arg in task.args:
        _check_exec_field("argument", arg)
    command = quote_windows_arg(task.command)
    arguments = " ".join(quote_windows_arg(arg) for arg in task.args)
    lines = (
        '<?xml version="1.0" encoding="UTF-16"?>',
        f'<Task version="1.2" xmlns="{_TASK_NS}">',
        "  <RegistrationInfo>",
        f"    <Description>{escape_xml(task.description)}</Description>",
        "  </RegistrationInfo>",
        "  <Triggers />",
        "  <Principals>",
        '    <Principal id="Author">',
        f"      <UserId>{escape_xml(task.user_id)}</UserId>",
        "      <LogonType>InteractiveToken</LogonType>",
        "      <RunLevel>HighestAvailable</RunLevel>",
        "    </Principal>",
        "  </Principals>",
        "  <Settings>",
        "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
        "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
        "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
        "    <StartWhenAvailable>false</StartWhenAvailable>",
        "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
        "    <AllowStartOnDemand>true</AllowStartOnDemand>",
        "    <Enabled>true</Enabled>",
        "    <Hidden>false</Hidden>",
        "    <RunOnlyIfIdle>false</RunOnlyIfIdle>",
        "    <WakeToRun>false</WakeToRun>",
        "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
        f"    <Priority>{TASK_PRIORITY}</Priority>",
        "  </Settings>",
        '  <Actions Context="Author">',
        "    <Exec>",
        f"      <Command>{escape_xml(command)}</Command>",
        f"      <Arguments>{escape_xml(arguments)}</Arguments>",
        f"      <WorkingDirectory>{escape_xml(task.working_directory)}</WorkingDirectory>",
        "    </Exec>",
        "  </Actions>",
        "</Task>",
    )
    return "\n".join(lines) + "\n"


def encode_task_xml(xml: str) -> bytes:
    return b"\xff\xfe" + xml.encode("utf-16-le")


def decode_query_output(data: bytes) -> str:
    if data[:2] == b"\xff\xfe":
        return data[2:].decode("utf-16-le")
    if data[:2] == b"\xfe\xff":
        return data[2:].decode("utf-16-be")
    if data[:3] == b"\xef\xbb\xbf":
        return data[3:].decode("utf-8")
    if len(data) >= 2 and data[0] != 0 and data[1] == 0:
        return data.decode("utf-16-le")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as exc:
        if sys.platform != "win32":
            raise ValueError("unable to decode task XML output") from exc
    return data.decode("oem")


def _children(xml: str | None) -> list[tuple[str, str]]:
    return [] if xml is None else [(m.group(1), m.group(2) or "") for m in _ELEMENT.finditer(xml)]


def _child(xml: str | None, name: str) -> str | None:
    return next((inner for tag, inner in _children(xml) if tag == name), None)


def _text(xml: str | None, name: str) -> str | None:
    inner = _child(xml, name)
    return None if inner is None else _unescape_xml(inner.strip())


@dataclass(frozen=True, slots=True)
class TaskReadback:
    triggers: tuple[str, ...]
    principal_user: str | None
    logon_type: str | None
    run_level: str | None
    exec_command: str | None
    exec_arguments: str | None
    exec_working_directory: str | None
    multiple_instances: str | None
    execution_time_limit: str | None
    allow_start_on_demand: str | None
    priority: str | None
    enabled: str | None


def read_task_xml(xml: str) -> TaskReadback:
    task = _child(xml, "Task")
    if task is None:
        raise ValueError("not a Windows Task Scheduler XML document")
    principal = _child(_child(task, "Principals"), "Principal")
    settings = _child(task, "Settings")
    exec_action = _child(_child(task, "Actions"), "Exec")
    triggers = tuple(name for name, _ in _children(_child(task, "Triggers")))
    return TaskReadback(
        triggers=triggers,
        principal_user=_text(principal, "UserId"),
        logon_type=_text(principal, "LogonType"),
        run_level=_text(principal, "RunLevel"),
        exec_command=_text(exec_action, "Command"),
        exec_arguments=_text(exec_action, "Arguments"),
        exec_working_directory=_text(exec_action, "WorkingDirectory"),
        multiple_instances=_text(settings, "MultipleInstancesPolicy"),
        execution_time_limit=_text(settings, "ExecutionTimeLimit"),
        allow_start_on_demand=_text(settings, "AllowStartOnDemand"),
        priority=_text(settings, "Priority"),
        enabled=_text(settings, "Enabled"),
    )


type Verdict = Literal["ok", "mismatch", "unverified"]


@dataclass(frozen=True, slots=True)
class FieldCheck:
    label: str
    actual: str
    expected: str
    verdict: Verdict
    note: str | None = None


def _unquote(text: str) -> str:
    return text[1:-1] if len(text) >= 2 and text[0] == text[-1] == '"' else text


def check_task(
    task: TaskReadback,
    expected: OnDemandTask,
    *,
    same_path: Callable[[str, str], bool] | None = None,
) -> list[FieldCheck]:
    checks: list[FieldCheck] = []

    def add(label: str, actual: str, want: str, verdict: Verdict, note: str | None = None) -> None:
        checks.append(FieldCheck(label, actual, want, verdict, note))

    def eq(label: str, actual: str | None, want: str) -> None:
        add(label, actual or _MISSING, want, "ok" if actual == want else "mismatch")

    def path_eq(actual: str | None, want: str) -> bool:
        if actual is None:
            return False
        if same_path is not None:
            return same_path(actual, want)
        return ntpath.normcase(ntpath.normpath(actual)) == ntpath.normcase(ntpath.normpath(want))

    add(
        "triggers",
        ",".join(task.triggers) or "(none)",
        "(none)",
        "ok" if not task.triggers else "mismatch",
    )
    if task.principal_user and _SID.fullmatch(task.principal_user):
        add("user_id", task.principal_user, expected.user_id, "unverified", "returned as SID")
    else:
        ok = bool(task.principal_user and task.principal_user.lower() == expected.user_id.lower())
        add(
            "user_id", task.principal_user or _MISSING, expected.user_id, "ok" if ok else "mismatch"
        )
    eq("logon_type", task.logon_type, "InteractiveToken")
    eq("run_level", task.run_level, "HighestAvailable")
    cmd = None if task.exec_command is None else _unquote(task.exec_command)
    add(
        "command",
        cmd or _MISSING,
        expected.command,
        "ok" if path_eq(cmd, expected.command) else "mismatch",
    )
    args = split_windows_args(task.exec_arguments or "")
    add(
        "arguments",
        " ".join(args) or "(none)",
        " ".join(expected.args),
        "ok" if args == list(expected.args) else "mismatch",
    )
    wd = task.exec_working_directory
    add(
        "working_directory",
        wd or _MISSING,
        expected.working_directory,
        "ok" if path_eq(wd, expected.working_directory) else "mismatch",
    )
    eq("multiple_instances", task.multiple_instances or "IgnoreNew", "IgnoreNew")
    eq("allow_start_on_demand", task.allow_start_on_demand or "true", "true")
    eq("execution_time_limit", task.execution_time_limit or "PT72H", "PT0S")
    prio = task.priority or "7"
    add("priority", prio, "4-6", "ok" if re.fullmatch(r"[4-6]", prio) else "mismatch")
    eq("enabled", task.enabled or "true", "true")
    return checks


def schtasks_path(env: Mapping[str, str] | None = None) -> str:
    source = os.environ if env is None else env
    root = source.get("SystemRoot") or source.get("SYSTEMROOT")
    if not root:
        raise ValueError("SystemRoot is not set; cannot locate schtasks.exe")
    return ntpath.join(root, "System32", "schtasks.exe")


def create_command(task_name: str, xml_path: str, *, schtasks: str = "schtasks.exe") -> list[str]:
    return [schtasks, "/Create", "/TN", valid_task_name(task_name), "/XML", xml_path, "/F"]


def query_command(task_name: str, *, schtasks: str = "schtasks.exe") -> list[str]:
    return [schtasks, "/Query", "/TN", valid_task_name(task_name), "/XML"]


def run_task_command(task_name: str, *, schtasks: str = "schtasks.exe") -> list[str]:
    return [schtasks, "/Run", "/TN", valid_task_name(task_name)]


def delete_command(task_name: str, *, schtasks: str = "schtasks.exe") -> list[str]:
    return [schtasks, "/Delete", "/TN", valid_task_name(task_name), "/F"]


def format_command(argv: Sequence[str]) -> str:
    return " ".join(quote_windows_arg(arg) if " " in arg else arg for arg in argv)


def query_task(task_name: str, *, schtasks: str | None = None) -> TaskReadback:
    exe = schtasks or schtasks_path()
    proc = subprocess.run(query_command(task_name, schtasks=exe), capture_output=True, check=False)
    if proc.returncode != 0:
        detail = decode_query_output(proc.stderr or proc.stdout).strip()
        raise RuntimeError(f"schtasks /Query failed (rc={proc.returncode}): {detail}")
    return read_task_xml(decode_query_output(proc.stdout))


def trigger_task(task_name: str, *, schtasks: str | None = None) -> None:
    exe = schtasks or schtasks_path()
    proc = subprocess.run(
        run_task_command(task_name, schtasks=exe), capture_output=True, check=False
    )
    if proc.returncode != 0:
        detail = decode_query_output(proc.stderr or proc.stdout).strip()
        raise RuntimeError(f"schtasks /Run failed (rc={proc.returncode}): {detail}")


def admin_install_commands(
    source_exe: str,
    install_dir: str,
    task_name: str,
    xml_path: str,
    *,
    schtasks: str | None = None,
) -> list[str]:
    exe = schtasks or schtasks_path()
    dest = ntpath.join(install_dir, "realtime-core.exe")
    return [
        f"New-Item -ItemType Directory -Force -Path '{install_dir}' | Out-Null",
        f"Copy-Item -Force '{source_exe}' '{dest}'",
        f"& '{exe}' /Create /TN '{valid_task_name(task_name)}' /XML '{xml_path}' /F",
    ]
