"""Unit and real-process tests for scheduled-task XML, secret CLI, and CoreClient task mode."""

from __future__ import annotations

import asyncio
import json
import secrets
import subprocess
from pathlib import Path

import pytest
from bellis_common import cred, secret_cli, task_xml
from bellis_game.io import CoreClient, CoreClientOptions, StopStage, base_environment
from bellis_game.io.protocol import ReleaseReason
from bellis_game.loop import cli

REPO_ROOT = Path(__file__).resolve().parent.parent
DEBUG_CORE_EXE = REPO_ROOT / "core" / "target" / "debug" / "realtime-core.exe"


def test_task_xml_roundtrip_and_check_detects_mismatches() -> None:
    task = task_xml.default_core_task(
        r"C:\Program Files\Bellis",
        user_id=r"DESKTOP\leaf",
        core_cred="core.bellis",
        permit_cred="session.bellis",
        emergency_hotkey="ctrl+shift+f12",
    )
    xml = task_xml.task_xml(task)
    encoded = task_xml.encode_task_xml(xml)
    assert encoded.startswith(b"\xff\xfe")
    assert task_xml.decode_query_output(encoded) == xml

    readback = task_xml.read_task_xml(xml)
    checks = task_xml.check_task(readback, task)
    assert all(c.verdict == "ok" for c in checks), checks

    # SID readback is marked unverified instead of mismatch.
    sid_xml = xml.replace(r"DESKTOP\leaf", "S-1-5-21-100-200-300-1001")
    sid_checks = {c.label: c for c in task_xml.check_task(task_xml.read_task_xml(sid_xml), task)}
    assert sid_checks["user_id"].verdict == "unverified"

    # Tampered run level, trigger, or arguments must be flagged as mismatch.
    tampered = (
        xml.replace("HighestAvailable", "LeastPrivilege")
        .replace("<Triggers />", "<Triggers><LogonTrigger /></Triggers>")
        .replace("ctrl+shift+f12", "ctrl+alt+f1")
    )
    bad = {c.label: c.verdict for c in task_xml.check_task(task_xml.read_task_xml(tampered), task)}
    assert bad["run_level"] == "mismatch"
    assert bad["triggers"] == "mismatch"
    assert bad["arguments"] == "mismatch"


def test_task_xml_validation_and_commands() -> None:
    assert task_xml.split_windows_args(r'"--core-cred" "core.bellis" "a\\"') == [
        "--core-cred",
        "core.bellis",
        "a\\",
    ]
    assert task_xml.schtasks_path({"SystemRoot": r"C:\Windows"}) == (
        r"C:\Windows\System32\schtasks.exe"
    )
    with pytest.raises(ValueError, match="SystemRoot"):
        task_xml.schtasks_path({})
    with pytest.raises(ValueError, match="invalid task name"):
        task_xml.valid_task_name("bad name")
    with pytest.raises(ValueError, match="absolute"):
        task_xml.task_xml(
            task_xml.OnDemandTask(r"D\u", "realtime-core.exe", (), r"C:\Program Files\Bellis")
        )
    with pytest.raises(ValueError, match="must not contain"):
        task_xml.task_xml(
            task_xml.OnDemandTask(
                r"D\u", r"C:\Program Files\Bellis\realtime-core.exe", ("%PATH%",), r"C:\Bellis"
            )
        )
    cmds = task_xml.admin_install_commands(
        r"C:\repo\realtime-core.exe",
        r"C:\Program Files\Bellis",
        "BellisRealtimeCore",
        r"C:\temp\task.xml",
        schtasks=r"C:\Windows\System32\schtasks.exe",
    )
    assert len(cmds) == 3
    assert "/Create /TN 'BellisRealtimeCore'" in cmds[2]


class _MemStore:
    def __init__(self, initial: dict[str, str] | None = None) -> None:
        self.data = dict(initial or {})

    def list_targets(self) -> list[str]:
        return sorted(self.data)

    def exists(self, target: str) -> bool:
        return target in self.data

    def write(self, target: str, value: str) -> None:
        self.data[target] = value

    def delete(self, target: str) -> bool:
        return self.data.pop(target, None) is not None


class _ScriptedPrompt:
    def __init__(self, *answers: str) -> None:
        self._answers = list(answers)
        self.calls: list[tuple[str, bool]] = []

    def ask(self, prompt: str, *, hidden: bool) -> str:
        self.calls.append((prompt, hidden))
        return self._answers.pop(0)


def test_secret_cli_list_set_delete_and_redaction() -> None:
    store = _MemStore({"session.bellis": "managed-secret"})
    out: list[str] = []
    assert secret_cli.run_secret_command(["list"], store=store, emit=out.append) == 0
    assert out == ["session.bellis (launcher-managed)"]
    assert "managed-secret" not in "\n".join(out)

    # Managed targets cannot be overwritten or deleted manually.
    for managed in ("session.bellis", "game-link.bellis", "core.bellis"):
        out.clear()
        assert secret_cli.run_secret_command(["set", managed], store=store, emit=out.append) == 1
        assert secret_cli.run_secret_command(["delete", managed], store=store, emit=out.append) == 1

    # Generic secret requires two matching hidden inputs and never echoes the value.
    out.clear()
    prompt = _ScriptedPrompt("top-secret-key", "top-secret-key")
    rc = secret_cli.run_secret_command(
        ["set", "ark.bellis"], store=store, prompter=prompt, emit=out.append
    )
    assert rc == 0 and store.data["ark.bellis"] == "top-secret-key"
    assert all(hidden for _, hidden in prompt.calls)
    assert "top-secret-key" not in "\n".join(out)

    # Mismatch leaves store untouched.
    out.clear()
    rc = secret_cli.run_secret_command(
        ["set", "minimax.bellis"],
        store=store,
        prompter=_ScriptedPrompt("one", "two"),
        emit=out.append,
    )
    assert rc == 1 and "minimax.bellis" not in store.data

    # OBS secret writes validated loopback JSON.
    out.clear()
    obs_prompt = _ScriptedPrompt("", "obs-pass", "obs-pass")
    rc = secret_cli.run_secret_command(
        ["set", "obs.bellis"], store=store, prompter=obs_prompt, emit=out.append
    )
    assert rc == 0
    assert json.loads(store.data["obs.bellis"]) == {
        "url": "ws://127.0.0.1:4455",
        "password": "obs-pass",
    }
    assert "obs-pass" not in "\n".join(out)

    # Non-loopback OBS URL rejected.
    out.clear()
    rc = secret_cli.run_secret_command(
        ["set", "obs.bellis"],
        store=store,
        prompter=_ScriptedPrompt("ws://192.168.1.2:4455"),
        emit=out.append,
    )
    assert rc == 1

    out.clear()
    assert (
        secret_cli.run_secret_command(["delete", "ark.bellis"], store=store, emit=out.append) == 0
    )
    assert "ark.bellis" not in store.data


def test_credman_text_roundtrip_and_enumerate() -> None:
    target = f"test.secret.{secrets.token_hex(4)}.bellis"
    try:
        cred.write_secret_text(target, "demo-value-123")
        assert cred.read_secret_text(target) == "demo-value-123"
        assert target in cred.list_secret_targets(".bellis")
        assert cred.delete_secret(target) is True
        assert cred.read_secret_text(target) is None
    finally:
        cred.delete_secret(target)


def test_game_agent_cli_core_task_options() -> None:
    args = cli.build_serve_parser().parse_args(
        ["--core-task", "BellisRealtimeCore", "--core-cred", "custom.core.bellis"]
    )
    options = cli.core_options(args)
    assert options.executable is None
    assert options.core_task == "BellisRealtimeCore"
    assert options.core_cred == "custom.core.bellis"
    with pytest.raises(ValueError, match="either executable or core_task"):
        CoreClientOptions(executable=Path("core.exe"), core_task="BellisRealtimeCore")


async def test_core_client_task_mode_launches_cleans_cred_and_shuts_down() -> None:
    assert DEBUG_CORE_EXE.is_file(), "run cargo build -p realtime-core first"
    core_cred = f"test.taskcore.{secrets.token_hex(4)}.bellis"
    spawned: list[subprocess.Popen[bytes]] = []
    triggered: list[str] = []

    def fake_schtasks_run(task_name: str) -> None:
        triggered.append(task_name)
        proc = subprocess.Popen(
            [str(DEBUG_CORE_EXE), "--core-cred", core_cred, "--health-interval-ms", "50"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=base_environment(),
        )
        spawned.append(proc)

    options = CoreClientOptions(
        core_task="BellisRealtimeCore",
        core_cred=core_cred,
        task_runner=fake_schtasks_run,
        start_timeout=5.0,
    )
    client = CoreClient(options)
    try:
        await client.start()
        assert triggered == ["BellisRealtimeCore"]
        assert client.running
        assert client.last_released is not None
        assert client.last_released.reason is ReleaseReason.CORE_START
        # One-time core credential must be deleted immediately once realtime-core is ready.
        assert cred.read_session_info(core_cred) is None

        stop_res = await client.stop()
        assert stop_res.stage is StopStage.SHUTDOWN
        assert stop_res.returncode == 0
        assert not client.running
        assert len(spawned) == 1
        assert await asyncio.to_thread(spawned[0].wait, 5) == 0
    finally:
        await client.stop()
        cred.delete_session_info(core_cred)
        for proc in spawned:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)
