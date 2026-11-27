"""Windows local fast-check runner for Bellis V2 (`uv run check`)."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

from tools.arch_guard import check_repo

REPO_ROOT = Path(__file__).resolve().parent.parent


def _run(cmd: list[str], cwd: Path = REPO_ROOT, *, timeout_s: float = 180.0) -> int:
    rel = cwd.relative_to(REPO_ROOT) if cwd != REPO_ROOT else "."
    print(f"[check] $ {' '.join(cmd)} (cwd={rel})", flush=True)
    try:
        proc = subprocess.run(cmd, cwd=cwd, check=False, timeout=timeout_s)
    except subprocess.TimeoutExpired:
        print(
            f"[check] TIMEOUT after {timeout_s:g}s: {' '.join(cmd)}",
            file=sys.stderr,
            flush=True,
        )
        return 124
    return proc.returncode


def _core_has_changes(root: Path) -> bool:
    proc = subprocess.run(
        ["git", "status", "--porcelain", "--", "core"],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode == 0 and proc.stdout.strip():
        return True
    diff = subprocess.run(
        ["git", "diff", "--name-only", "main...HEAD", "--", "core"],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    return diff.returncode == 0 and bool(diff.stdout.strip())


def _run_arch_guard(root: Path) -> int:
    print("[check] arch_guard")
    result = check_repo(root)
    for warn in result.warnings:
        print(f"WARNING: {warn}")
    for err in result.errors:
        print(f"ERROR: {err}", file=sys.stderr)
    if result.errors:
        print(f"[check] arch_guard failed with {len(result.errors)} error(s).", file=sys.stderr)
        return 1
    print("[check] arch_guard passed.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Bellis V2 local Windows check runner.")
    parser.add_argument("--all", action="store_true", help="Run Python and Rust checks.")
    parser.add_argument("--rust", action="store_true", help="Include Rust workspace checks.")
    args = parser.parse_args(argv)

    py_steps: list[list[str]] = [
        ["ruff", "format", "--check"],
        ["ruff", "check"],
        ["pyright"],
    ]
    for cmd in py_steps:
        rc = _run(cmd)
        if rc != 0:
            return rc

    rc = _run_arch_guard(REPO_ROOT)
    if rc != 0:
        return rc

    rc = _run([sys.executable, "-m", "pytest"])
    if rc != 0:
        return rc

    run_rust = args.all or args.rust or _core_has_changes(REPO_ROOT)
    if run_rust:
        core_dir = REPO_ROOT / "core"
        rust_steps: list[list[str]] = [
            ["cargo", "fmt", "--check"],
            ["cargo", "clippy", "--workspace", "--all-targets", "--", "-D", "warnings"],
            ["cargo", "test", "--workspace"],
        ]
        for cmd in rust_steps:
            rc = _run(cmd, cwd=core_dir)
            if rc != 0:
                return rc
    else:
        print("[check] Skipping Rust checks (no core/ changes; pass --all or --rust to force).")

    print("[check] All checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
