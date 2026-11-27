"""Unified Bellis launcher for ``game``, ``live``, ``all``, ``task``, and ``secret`` commands."""

from __future__ import annotations

import argparse
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from collections.abc import Callable, Sequence
from contextlib import suppress
from pathlib import Path
from typing import IO, Any

from . import cred, secret_cli, task_xml
from .agent_events import DEFAULT_GAME_LINK_TARGET

type PopenFactory = Callable[..., subprocess.Popen[bytes]]


def _default_xml_path(task_name: str) -> Path:
    base = os.getenv("LOCALAPPDATA") or tempfile.gettempdir()
    return Path(base) / "Bellis" / f"{task_name}.xml"


def _find_core_exe(repo_root: Path | None = None) -> Path:
    root = Path(__file__).resolve().parents[4] if repo_root is None else repo_root
    for profile in ("release", "debug"):
        cand = root / "core" / "target" / profile / "realtime-core.exe"
        if cand.is_file():
            return cand
    return root / "core" / "target" / "release" / "realtime-core.exe"


def _emit_line(line: str) -> None:
    print(line, flush=True)


def _base_python() -> str:
    if sys.platform == "win32":
        cand = Path(sys.base_prefix) / "python.exe"
        if cand.is_file():
            return str(cand)
    return str(getattr(sys, "_base_executable", sys.executable))


def _python_cmd(module: str, args: Sequence[str]) -> tuple[list[str], str, dict[str, str]]:
    env = os.environ.copy()
    env["__PYVENV_LAUNCHER__"] = sys.executable
    return [sys.executable, "-m", module, *args], _base_python(), env


def _spawn_python(
    module: str,
    args: Sequence[str],
    *,
    stdout: int | IO[Any] | None = None,
    stdin: int | IO[Any] | None = None,
    popen: PopenFactory = subprocess.Popen,
) -> subprocess.Popen[bytes]:
    argv, executable, env = _python_cmd(module, args)
    flags = subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0
    return popen(
        argv,
        executable=executable,
        stdin=stdin,
        stdout=stdout,
        env=env,
        creationflags=flags,
    )


def _stop_process(proc: subprocess.Popen[bytes], *, timeout: float) -> int:
    if proc.poll() is not None:
        return proc.returncode
    with suppress(OSError, ValueError):
        if sys.platform == "win32" and hasattr(signal, "CTRL_BREAK_EVENT"):
            proc.send_signal(signal.CTRL_BREAK_EVENT)
        else:
            proc.terminate()
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            with suppress(OSError):
                proc.kill()
            return proc.wait()
        try:
            return proc.wait(remaining)
        except subprocess.TimeoutExpired:
            with suppress(OSError):
                proc.kill()
            return proc.wait()
        except KeyboardInterrupt:
            continue


def _cleanup_cred_for_pid(target: str | None, pid: int) -> None:
    if not target:
        return
    with suppress(cred.CredError):
        info = cred.read_session_info(target)
        if info is not None and info.launcher_pid == pid:
            cred.delete_session_info(target)


def _add_host_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--config", type=Path)
    parser.add_argument("--db", type=Path)
    parser.add_argument("--no-obs", action="store_true")
    parser.add_argument("--console-port", type=int)
    parser.add_argument("--stage-port", type=int)
    parser.add_argument("--watchdog-timeout-ms", type=int)
    parser.add_argument("--permit-cred", default=cred.DEFAULT_SESSION_TARGET)
    parser.add_argument("--link-cred", default=DEFAULT_GAME_LINK_TARGET)


def _add_game_core_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--profile", type=Path, default=Path("games/hsr.toml"))
    parser.add_argument("--core-task")
    parser.add_argument("--core-cred", default=cred.DEFAULT_CORE_TARGET)
    parser.add_argument("--core-exe", type=Path)
    parser.add_argument("--emergency-hotkey", default=task_xml.DEFAULT_EMERGENCY_HOTKEY)
    parser.add_argument("--telemetry", type=Path)
    parser.add_argument("--base-url")
    parser.add_argument("--model")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="bellis", description="Bellis unified runtime CLI.")
    sub = parser.add_subparsers(dest="command", required=True)

    live_p = sub.add_parser("live", help="Start Host and Watchdog.")
    _add_host_args(live_p)

    game_p = sub.add_parser("game", help="Run standalone permit-console and game-agent.")
    _add_game_core_args(game_p)
    game_p.add_argument("--permit-cred", default=cred.DEFAULT_SESSION_TARGET)
    game_p.add_argument("--goal", required=True)
    game_p.add_argument("--max-steps", type=int, default=8)
    game_p.add_argument("--timeout", type=float, default=90.0)
    game_p.add_argument("--ready-timeout", type=float, default=15.0)

    all_p = sub.add_parser("all", help="Start Host, Watchdog, and game-agent together.")
    _add_host_args(all_p)
    _add_game_core_args(all_p)
    all_p.add_argument("--ready-timeout", type=float, default=30.0)

    task_p = sub.add_parser("task", help="Prepare, verify, or print delete command for core task.")
    task_p.add_argument("action", choices=("prepare", "check", "delete"))
    task_p.add_argument("--task-name", default=task_xml.DEFAULT_TASK_NAME)
    task_p.add_argument("--install-dir", default=task_xml.DEFAULT_INSTALL_DIR)
    task_p.add_argument("--core-cred", default=cred.DEFAULT_CORE_TARGET)
    task_p.add_argument("--permit-cred", default=cred.DEFAULT_SESSION_TARGET)
    task_p.add_argument("--emergency-hotkey", default=task_xml.DEFAULT_EMERGENCY_HOTKEY)
    task_p.add_argument("--source-exe", type=Path)
    task_p.add_argument("--xml-out", type=Path)
    task_p.add_argument("--user-id")

    sec_p = sub.add_parser("secret", help="Manage Windows Credential Manager secrets.")
    sec_p.add_argument("secret_args", nargs=argparse.REMAINDER)
    return parser


def _host_live_args(args: argparse.Namespace) -> list[str]:
    out = ["live", "--permit-cred", args.permit_cred, "--link-cred", args.link_cred]
    for flag, value in (
        ("--config", args.config),
        ("--db", args.db),
        ("--console-port", args.console_port),
        ("--stage-port", args.stage_port),
        ("--watchdog-timeout-ms", args.watchdog_timeout_ms),
    ):
        if value is not None:
            out.extend([flag, str(value)])
    if args.no_obs:
        out.append("--no-obs")
    return out


def _game_common_args(args: argparse.Namespace) -> list[str]:
    out = [
        "--profile",
        str(args.profile),
        "--permit-cred",
        args.permit_cred,
        "--emergency-hotkey",
        args.emergency_hotkey,
    ]
    if args.core_task:
        out.extend(["--core-task", args.core_task, "--core-cred", args.core_cred])
    elif args.core_exe is not None:
        out.extend(["--core-exe", str(args.core_exe)])
    for flag, value in (
        ("--telemetry", args.telemetry),
        ("--base-url", args.base_url),
        ("--model", args.model),
    ):
        if value is not None:
            out.extend([flag, str(value)])
    return out


def _run_task(
    args: argparse.Namespace,
    *,
    emit: Callable[[str], None] = _emit_line,
    query: Callable[[str], task_xml.TaskReadback] = task_xml.query_task,
) -> int:
    name = task_xml.valid_task_name(args.task_name)
    if args.action == "delete":
        cmd = task_xml.format_command(
            task_xml.delete_command(name, schtasks=task_xml.schtasks_path())
        )
        emit("Run in an elevated PowerShell to remove the task:")
        emit(f"  {cmd}")
        return 0

    spec = task_xml.default_core_task(
        args.install_dir,
        user_id=args.user_id,
        core_cred=args.core_cred,
        permit_cred=args.permit_cred or None,
        emergency_hotkey=args.emergency_hotkey if args.permit_cred else None,
    )
    if args.action == "prepare":
        xml_out = args.xml_out or _default_xml_path(name)
        xml_out.parent.mkdir(parents=True, exist_ok=True)
        xml_out.write_bytes(task_xml.encode_task_xml(task_xml.task_xml(spec)))
        source = str((args.source_exe or _find_core_exe()).resolve())
        emit(f"Wrote task XML: {xml_out}")
        emit("Run these commands once in an elevated PowerShell:")
        for line in task_xml.admin_install_commands(source, args.install_dir, name, str(xml_out)):
            emit(f"  {line}")
        emit(f"Then verify from a normal PowerShell: uv run bellis task check --task-name {name}")
        return 0

    try:
        readback = query(name)
    except (RuntimeError, ValueError) as exc:
        emit(f"Task check failed: {exc}")
        return 1
    checks = task_xml.check_task(readback, spec)
    mismatches = 0
    for item in checks:
        note = f" ({item.note})" if item.note else ""
        emit(f"[{item.verdict}] {item.label}: actual={item.actual} expected={item.expected}{note}")
        if item.verdict == "mismatch":
            mismatches += 1
    return 0 if mismatches == 0 else 1


def _wait_for_creds(
    targets: Sequence[str],
    proc: subprocess.Popen[bytes],
    *,
    timeout: float,
    expected_pid: int | None = None,
    read_info: Callable[[str], cred.SessionInfo | None] = cred.read_session_info,
) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return False
        ready = True
        for target in targets:
            with suppress(cred.CredError):
                info = read_info(target)
                if info is not None and (expected_pid is None or info.launcher_pid == expected_pid):
                    continue
            ready = False
            break
        if ready:
            return True
        time.sleep(0.1)
    return False


def _pump_stdout(
    stream: IO[bytes],
    fields: dict[str, str],
    ready: threading.Event,
    emit: Callable[[str], None],
) -> None:
    expected = {"Host PID", "Console Login URL"}
    try:
        for raw in stream:
            line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            emit(line)
            key, sep, value = line.partition(": ")
            if sep and key in expected:
                fields[key] = value.strip()
                if expected <= fields.keys():
                    ready.set()
    finally:
        ready.set()


def _run_live(args: argparse.Namespace, *, popen: PopenFactory = subprocess.Popen) -> int:
    proc = _spawn_python("bellis_host.app", _host_live_args(args), popen=popen)
    try:
        return proc.wait()
    except KeyboardInterrupt:
        _stop_process(proc, timeout=20.0)
        return 130


def _run_game(
    args: argparse.Namespace,
    *,
    popen: PopenFactory = subprocess.Popen,
    read_info: Callable[[str], cred.SessionInfo | None] = cred.read_session_info,
    emit: Callable[[str], None] = _emit_line,
) -> int:
    permit_proc = _spawn_python(
        "bellis_game.console", ["--cred-target", args.permit_cred], popen=popen
    )
    game_proc: subprocess.Popen[bytes] | None = None
    try:
        if not _wait_for_creds(
            (args.permit_cred,), permit_proc, timeout=args.ready_timeout, read_info=read_info
        ):
            emit("bellis game: permit-console did not publish session credential in time.")
            return 1
        game_args = [
            *_game_common_args(args),
            "--goal",
            args.goal,
            "--max-steps",
            str(args.max_steps),
            "--timeout",
            str(args.timeout),
        ]
        game_proc = _spawn_python("bellis_game.loop.cli", game_args, popen=popen)
        while game_proc.poll() is None and permit_proc.poll() is None:
            time.sleep(0.15)
        return game_proc.returncode if game_proc.poll() is not None else 1
    except KeyboardInterrupt:
        return 130
    finally:
        if game_proc is not None:
            _stop_process(game_proc, timeout=10.0)
            if args.core_task:
                _cleanup_cred_for_pid(args.core_cred, game_proc.pid)
        _stop_process(permit_proc, timeout=10.0)
        _cleanup_cred_for_pid(args.permit_cred, permit_proc.pid)


def _port_in_use(port: int) -> bool:
    if port <= 0:
        return False
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.2)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def _core_exe_running() -> bool:
    if sys.platform != "win32":
        return False
    try:
        proc = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq realtime-core.exe", "/FO", "CSV", "/NH"],
            capture_output=True,
            text=True,
            timeout=3.0,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return "realtime-core.exe" in proc.stdout.lower()


def _preflight_all(args: argparse.Namespace) -> str | None:
    if args.config is None:
        stage_port = 18765 if args.stage_port is None else args.stage_port
        console_port = 18766 if args.console_port is None else args.console_port
        for label, port in (("Stage", stage_port), ("Console", console_port)):
            if _port_in_use(port):
                return (
                    f"bellis all: 127.0.0.1:{port} ({label}) is already in use; "
                    "stop any leftover Bellis Host process first."
                )
    if args.core_task and _core_exe_running():
        return (
            f"bellis all: realtime-core.exe is already running, so scheduled task "
            f"'{args.core_task}' (IgnoreNew) would ignore startup. "
            f"Stop the old process first (e.g. schtasks /End /TN {args.core_task})."
        )
    return None


def _run_all(
    args: argparse.Namespace,
    *,
    popen: PopenFactory = subprocess.Popen,
    read_info: Callable[[str], cred.SessionInfo | None] = cred.read_session_info,
    emit: Callable[[str], None] = _emit_line,
    preflight: Callable[[argparse.Namespace], str | None] | None = None,
) -> int:
    checker = _preflight_all if (preflight is None and popen is subprocess.Popen) else preflight
    if checker is not None and (conflict := checker(args)):
        emit(conflict)
        return 1
    host_proc = _spawn_python(
        "bellis_host.app", _host_live_args(args), stdout=subprocess.PIPE, popen=popen
    )
    assert host_proc.stdout is not None
    fields: dict[str, str] = {}
    ready = threading.Event()
    pump = threading.Thread(
        target=_pump_stdout,
        args=(host_proc.stdout, fields, ready, emit),
        name="bellis-host-stdout",
        daemon=True,
    )
    pump.start()
    game_proc: subprocess.Popen[bytes] | None = None
    try:
        if not ready.wait(args.ready_timeout) or "Host PID" not in fields:
            emit("bellis all: Host did not report readiness before timeout.")
            return 1
        host_pid = int(fields["Host PID"])
        if not _wait_for_creds(
            (args.permit_cred, args.link_cred),
            host_proc,
            timeout=args.ready_timeout,
            expected_pid=host_pid,
            read_info=read_info,
        ):
            emit("bellis all: Host session credentials were not ready in time.")
            return 1
        serve_args = ["serve", *_game_common_args(args), "--link-cred", args.link_cred]
        game_proc = _spawn_python("bellis_game.loop.cli", serve_args, popen=popen)
        emit(f"Game Agent PID: {game_proc.pid}")
        while host_proc.poll() is None and game_proc.poll() is None:
            time.sleep(0.2)
        if game_proc.poll() is not None and game_proc.returncode != 0:
            return game_proc.returncode
        return host_proc.returncode if host_proc.poll() is not None else 0
    except KeyboardInterrupt:
        return 130
    finally:
        if game_proc is not None:
            _stop_process(game_proc, timeout=10.0)
            if args.core_task:
                _cleanup_cred_for_pid(args.core_cred, game_proc.pid)
        _stop_process(host_proc, timeout=20.0)
        pump.join(timeout=2.0)


def main(argv: Sequence[str] | None = None) -> int:
    if hasattr(signal, "SIGBREAK"):
        signal.signal(signal.SIGBREAK, signal.default_int_handler)
    args = build_parser().parse_args(argv)
    if args.command == "secret":
        return secret_cli.run_secret_command(args.secret_args)
    if args.command == "task":
        return _run_task(args)
    if args.command == "live":
        return _run_live(args)
    if args.command == "game":
        return _run_game(args)
    return _run_all(args)


if __name__ == "__main__":
    raise SystemExit(main())
