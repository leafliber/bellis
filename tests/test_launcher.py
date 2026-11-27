"""Tests for the unified ``bellis`` launcher (task, secret, live, game, all)."""

from __future__ import annotations

import io
import subprocess
from pathlib import Path
from typing import Any

from bellis_common import cred, launcher, task_xml
from bellis_common.channel import ChannelCredentials, create_channel_path, create_session_key


class _FakeProc:
    def __init__(
        self,
        pid: int,
        argv: list[str],
        *,
        stdout_lines: list[str] | None = None,
        returncode: int | None = None,
        events: list[str] | None = None,
        label: str = "proc",
    ) -> None:
        self.pid = pid
        self.argv = argv
        self.returncode = returncode
        self._events = events if events is not None else []
        self._label = label
        payload = "".join(f"{line}\n" for line in (stdout_lines or [])).encode("utf-8")
        self.stdout: io.BytesIO | None = io.BytesIO(payload) if stdout_lines is not None else None

    def poll(self) -> int | None:
        return self.returncode

    def send_signal(self, _sig: int) -> None:
        self._events.append(f"signal:{self._label}")
        if self.returncode is None:
            self.returncode = 0

    def terminate(self) -> None:
        self._events.append(f"terminate:{self._label}")
        if self.returncode is None:
            self.returncode = 0

    def kill(self) -> None:
        self._events.append(f"kill:{self._label}")
        if self.returncode is None:
            self.returncode = 1

    def wait(self, _timeout: float | None = None) -> int:
        if self.returncode is None:
            self.returncode = 0
        return self.returncode


def _fake_session(pid: int) -> cred.SessionInfo:
    creds = ChannelCredentials(create_channel_path("test01"), create_session_key())
    return cred.SessionInfo.create(creds, "test01", launcher_pid=pid)


def test_task_prepare_check_and_delete(tmp_path: Path) -> None:
    xml_out = tmp_path / "BellisRealtimeCore.xml"
    exe = tmp_path / "realtime-core.exe"
    exe.write_bytes(b"")
    lines: list[str] = []

    prep = launcher.build_parser().parse_args(
        [
            "task",
            "prepare",
            "--task-name",
            "BellisRealtimeCore",
            "--install-dir",
            r"C:\Program Files\Bellis",
            "--user-id",
            r"DESKTOP\leaf",
            "--source-exe",
            str(exe),
            "--xml-out",
            str(xml_out),
        ]
    )
    assert launcher._run_task(prep, emit=lines.append) == 0  # pyright: ignore[reportPrivateUsage]
    assert xml_out.is_file()
    raw = xml_out.read_bytes()
    assert raw.startswith(b"\xff\xfe")
    assert any("/Create /TN 'BellisRealtimeCore'" in line for line in lines)

    # Check succeeds against matching readback XML.
    check_args = launcher.build_parser().parse_args(
        [
            "task",
            "check",
            "--task-name",
            "BellisRealtimeCore",
            "--install-dir",
            r"C:\Program Files\Bellis",
            "--user-id",
            r"DESKTOP\leaf",
        ]
    )
    xml_text = task_xml.decode_query_output(raw)
    lines.clear()
    rc = launcher._run_task(  # pyright: ignore[reportPrivateUsage]
        check_args,
        emit=lines.append,
        query=lambda _n: task_xml.read_task_xml(xml_text),
    )
    assert rc == 0 and all(line.startswith("[ok]") for line in lines)

    # Check fails when RunLevel is downgraded.
    bad_xml = xml_text.replace("HighestAvailable", "LeastPrivilege")
    lines.clear()
    rc = launcher._run_task(  # pyright: ignore[reportPrivateUsage]
        check_args,
        emit=lines.append,
        query=lambda _n: task_xml.read_task_xml(bad_xml),
    )
    assert rc == 1 and any("[mismatch] run_level" in line for line in lines)

    # Delete prints command without executing schtasks.
    del_args = launcher.build_parser().parse_args(["task", "delete"])
    lines.clear()
    assert launcher._run_task(del_args, emit=lines.append) == 0  # pyright: ignore[reportPrivateUsage]
    assert any("/Delete /TN BellisRealtimeCore /F" in line for line in lines)


def test_all_mode_starts_host_then_game_agent_and_stops_in_reverse_order() -> None:
    spawned: list[tuple[list[str], _FakeProc]] = []
    events: list[str] = []
    out: list[str] = []

    def fake_popen(argv: list[str], **_kwargs: Any) -> subprocess.Popen[bytes]:
        if "bellis_host.app" in argv:
            proc = _FakeProc(
                1001,
                argv,
                stdout_lines=[
                    "Watchdog PID: 1002",
                    "Host PID: 1001",
                    "Stage URL: http://127.0.0.1:18765/",
                    "Console Login URL: http://127.0.0.1:18766/#token=abc",
                ],
                events=events,
                label="host",
            )
        else:
            # Game agent exits cleanly after startup to exercise normal shutdown order.
            proc = _FakeProc(2002, argv, returncode=0, events=events, label="game")
        spawned.append((argv, proc))
        return proc  # type: ignore[return-value]

    sessions = {
        "session.bellis": _fake_session(1001),
        "game-link.bellis": _fake_session(1001),
    }
    args = launcher.build_parser().parse_args(
        [
            "all",
            "--profile",
            "games/hsr.toml",
            "--core-task",
            "BellisRealtimeCore",
            "--no-obs",
        ]
    )
    rc = launcher._run_all(  # pyright: ignore[reportPrivateUsage]
        args,
        popen=fake_popen,
        read_info=sessions.get,
        emit=out.append,
    )
    assert rc == 0
    assert len(spawned) == 2
    host_argv, game_argv = spawned[0][0], spawned[1][0]
    assert "bellis_host.app" in host_argv and "--no-obs" in host_argv
    assert "bellis_game.loop.cli" in game_argv and "serve" in game_argv
    assert "--core-task" in game_argv and "BellisRealtimeCore" in game_argv
    assert any("Host PID: 1001" in line for line in out)
    assert any("Game Agent PID: 2002" in line for line in out)
    assert events and events[-1].endswith(":host")


def test_all_mode_aborts_cleanly_if_host_exits_before_ready() -> None:
    events: list[str] = []
    out: list[str] = []

    def fake_popen(argv: list[str], **_kwargs: Any) -> subprocess.Popen[bytes]:
        return _FakeProc(  # type: ignore[return-value]
            1001, argv, stdout_lines=["Host failed"], returncode=1, events=events, label="host"
        )

    args = launcher.build_parser().parse_args(["all", "--ready-timeout", "0.3"])
    rc = launcher._run_all(  # pyright: ignore[reportPrivateUsage]
        args, popen=fake_popen, read_info=lambda _: None, emit=out.append
    )
    assert rc == 1
    assert any("did not report readiness" in line for line in out)


def test_game_mode_waits_for_permit_cred_and_launches_goal() -> None:
    spawned: list[list[str]] = []
    events: list[str] = []

    def fake_popen(argv: list[str], **_kwargs: Any) -> subprocess.Popen[bytes]:
        spawned.append(argv)
        if "bellis_game.console" in argv:
            return _FakeProc(3001, argv, events=events, label="permit")  # type: ignore[return-value]
        return _FakeProc(3002, argv, returncode=0, events=events, label="game")  # type: ignore[return-value]

    args = launcher.build_parser().parse_args(
        ["game", "--goal", "open map", "--core-task", "BellisRealtimeCore"]
    )
    rc = launcher._run_game(  # pyright: ignore[reportPrivateUsage]
        args,
        popen=fake_popen,
        read_info=lambda t: _fake_session(3001) if t == "session.bellis" else None,
        emit=lambda _: None,
    )
    assert rc == 0
    assert len(spawned) == 2
    assert "bellis_game.console" in spawned[0]
    assert "bellis_game.loop.cli" in spawned[1] and "open map" in spawned[1]
    assert any(e.endswith(":permit") for e in events)


def test_stop_process_survives_second_keyboard_interrupt() -> None:
    class _InterruptOnce(_FakeProc):
        def __init__(self) -> None:
            super().__init__(4001, ["python"], label="host")
            self.waits = 0

        def send_signal(self, _sig: int) -> None:
            self._events.append("signal:host")

        def wait(self, _timeout: float | None = None) -> int:
            self.waits += 1
            if self.waits == 1:
                raise KeyboardInterrupt
            self.returncode = 0
            return 0

    proc = _InterruptOnce()
    rc = launcher._stop_process(proc, timeout=5.0)  # type: ignore[arg-type]  # pyright: ignore[reportPrivateUsage]
    assert rc == 0 and proc.waits == 2 and proc._events == ["signal:host"]  # pyright: ignore[reportPrivateUsage]
    assert Path(launcher._base_python()).is_file()  # pyright: ignore[reportPrivateUsage]
