"""Self-tests for the Bellis V2 architecture anti-bloat guard."""

from __future__ import annotations

from pathlib import Path

from tools.arch_guard import check_repo


def _write(root: Path, rel: str, content: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _seed_clean_repo(root: Path) -> None:
    _write(root, "py/bellis_common/src/bellis_common/__init__.py", "")
    _write(root, "py/bellis_common/src/bellis_common/types.py", "X = 1\n")
    _write(root, "py/bellis_game/src/bellis_game/__init__.py", "")
    _write(root, "py/bellis_game/src/bellis_game/io/__init__.py", "")
    _write(
        root,
        "py/bellis_game/src/bellis_game/io/frame.py",
        "from bellis_common.types import X\nY = X\n",
    )
    _write(root, "py/bellis_game/src/bellis_game/perception/__init__.py", "")
    _write(
        root,
        "py/bellis_game/src/bellis_game/perception/obs.py",
        "from bellis_game.io.frame import Y\nZ = Y\n",
    )
    _write(root, "py/bellis_game/src/bellis_game/skills/__init__.py", "")
    _write(
        root,
        "py/bellis_game/src/bellis_game/skills/click.py",
        "from bellis_game.perception.obs import Z\nW = Z\n",
    )
    _write(root, "py/bellis_game/src/bellis_game/loop/__init__.py", "")
    _write(
        root,
        "py/bellis_game/src/bellis_game/loop/runner.py",
        "from bellis_game.skills.click import W\nV = W\n",
    )


def test_clean_repo_passes(tmp_path: Path) -> None:
    _seed_clean_repo(tmp_path)
    result = check_repo(tmp_path)
    assert result.errors == []
    assert result.warnings == []


def test_circular_dependency_fails(tmp_path: Path) -> None:
    _seed_clean_repo(tmp_path)
    _write(tmp_path, "py/bellis_host/src/bellis_host/__init__.py", "")
    _write(tmp_path, "py/bellis_host/src/bellis_host/a.py", "from bellis_host import b\n")
    _write(tmp_path, "py/bellis_host/src/bellis_host/b.py", "from bellis_host import a\n")

    result = check_repo(tmp_path)
    assert any("Circular dependency" in err for err in result.errors)


def test_reverse_layer_import_fails(tmp_path: Path) -> None:
    _seed_clean_repo(tmp_path)
    _write(
        tmp_path,
        "py/bellis_common/src/bellis_common/bad.py",
        "from bellis_game.io import frame\n",
    )
    _write(
        tmp_path,
        "py/bellis_game/src/bellis_game/io/bad.py",
        "from bellis_game.skills import click\n",
    )
    _write(
        tmp_path,
        "py/bellis_game/src/bellis_game/perception/bad.py",
        "import tests.helper\n",
    )
    _write(
        tmp_path,
        "py/bellis_game/src/bellis_game/loop/bad.py",
        'DATA = ".local/secret.json"\n',
    )

    result = check_repo(tmp_path)
    assert any("bellis_common must not depend on bellis_game" in e for e in result.errors)
    assert any("Reverse layer dependency in bellis_game" in e for e in result.errors)
    assert any("Production module imports tests" in e for e in result.errors)
    assert any("'.local' reference" in e for e in result.errors)


def test_line_count_warning_and_error(tmp_path: Path) -> None:
    _seed_clean_repo(tmp_path)
    _write(tmp_path, "py/bellis_common/src/bellis_common/warn.py", "x = 1\n" * 505)
    _write(tmp_path, "py/bellis_common/src/bellis_common/huge.py", "x = 1\n" * 805)

    result = check_repo(tmp_path)
    assert any("exceeds 500 lines" in w and "warn.py" in w for w in result.warnings)
    assert any("exceeds 800 lines" in e and "huge.py" in e for e in result.errors)


def test_forbidden_sim_file_and_trace_service_fail(tmp_path: Path) -> None:
    _seed_clean_repo(tmp_path)
    _write(tmp_path, "py/bellis_game/src/bellis_game/sim_device.py", "X = 1\n")
    _write(tmp_path, "py/bellis_game/src/bellis_game/audio_sim.py", "X = 1\n")
    _write(tmp_path, "py/bellis_game/src/bellis_game/fake.py", "X = 1\n")
    _write(tmp_path, "core/crates/channel/src/fake.rs", "pub const X: u8 = 1;\n")
    _write(tmp_path, "core/crates/channel/src/fake_input.rs", "pub const Y: u8 = 2;\n")
    _write(tmp_path, "py/bellis_host/src/bellis_host/obs.py", "class TraceService:\n    pass\n")

    result = check_repo(tmp_path)
    assert any("sim_device.py" in e for e in result.errors)
    assert any("audio_sim.py" in e for e in result.errors)
    assert any("fake.py" in e for e in result.errors)
    assert any("fake.rs" in e for e in result.errors)
    assert any("fake_input.rs" in e for e in result.errors)
    assert any("TraceService" in e for e in result.errors)


def test_cross_process_game_host_import_fails(tmp_path: Path) -> None:
    _seed_clean_repo(tmp_path)
    _write(tmp_path, "py/bellis_host/src/bellis_host/__init__.py", "")
    _write(
        tmp_path,
        "py/bellis_host/src/bellis_host/bridge.py",
        "from bellis_game.io import frame\n",
    )
    _write(
        tmp_path,
        "py/bellis_game/src/bellis_game/loop/bad.py",
        "import bellis_host\n",
    )

    result = check_repo(tmp_path)
    assert any("bellis_host must not depend on bellis_game" in e for e in result.errors)
    assert any("bellis_game must not depend on bellis_host" in e for e in result.errors)


def test_rust_cfg_test_truncation_and_test_files_skipped(tmp_path: Path) -> None:
    _seed_clean_repo(tmp_path)
    prod_plus_big_tests = "pub fn ok() -> u8 { 1 }\n" * 10 + "#[cfg(test)]\n" + "// t\n" * 900
    _write(tmp_path, "core/crates/channel/src/lib.rs", prod_plus_big_tests)
    _write(tmp_path, "core/crates/channel/src/tests.rs", "// t\n" * 900)
    _write(tmp_path, "core/crates/channel/src/ipc_test.rs", "// t\n" * 900)

    clean_res = check_repo(tmp_path)
    assert clean_res.errors == []
    assert clean_res.warnings == []

    too_big_prod = "pub fn f() {}\n" * 805 + "#[cfg(test)]\nmod tests {}\n"
    _write(tmp_path, "core/crates/channel/src/big.rs", too_big_prod)
    big_res = check_repo(tmp_path)
    assert any("exceeds 800 lines" in e and "big.rs" in e for e in big_res.errors)
