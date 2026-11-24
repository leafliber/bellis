"""Architecture anti-bloat static guard for Bellis V2."""

from __future__ import annotations

import ast
import re
from dataclasses import dataclass
from pathlib import Path

WARN_LINES = 500
MAX_LINES = 800

GAME_LAYERS: dict[str, int] = {
    "io": 0,
    "perception": 1,
    "skills": 2,
    "loop": 3,
}

LOCAL_REF_RE = re.compile(r"""(?:^|[\s"'/\\])\.local(?:$|[\s"'/\\])""")
SKIP_DIRS = {"__pycache__", ".venv", "target", "tests", ".git"}


@dataclass(frozen=True)
class GuardResult:
    errors: list[str]
    warnings: list[str]


def _iter_prod_files(root: Path) -> tuple[list[Path], list[Path]]:
    py_files: list[Path] = []
    rs_files: list[Path] = []

    py_dir = root / "py"
    if py_dir.is_dir():
        for path in sorted(py_dir.rglob("*.py")):
            if not any(part in SKIP_DIRS for part in path.relative_to(py_dir).parts):
                py_files.append(path)

    core_dir = root / "core"
    if core_dir.is_dir():
        for path in sorted(core_dir.rglob("*.rs")):
            if not any(part in SKIP_DIRS for part in path.relative_to(core_dir).parts):
                rs_files.append(path)

    return py_files, rs_files


def _module_name(py_root: Path, path: Path) -> str | None:
    rel = path.relative_to(py_root)
    parts = rel.parts
    if len(parts) < 3 or parts[1] != "src":
        return None
    sub = parts[2:]
    if sub[-1] == "__init__.py":
        return ".".join(sub[:-1]) if len(sub) > 1 else None
    return ".".join((*sub[:-1], path.stem))


def _resolve_import_from(
    node: ast.ImportFrom,
    mod_name: str,
    is_pkg: bool,
) -> list[tuple[str, str]]:
    if node.level > 0:
        pkg_parts = mod_name.split(".") if is_pkg else mod_name.split(".")[:-1]
        up = node.level - 1
        base_parts = pkg_parts[: len(pkg_parts) - up] if up <= len(pkg_parts) else []
        if node.module:
            base_parts = [*base_parts, *node.module.split(".")]
        base = ".".join(base_parts)
    else:
        base = node.module or ""

    results: list[tuple[str, str]] = []
    for alias in node.names:
        if alias.name == "*":
            if base:
                results.append((base, base))
        elif base:
            results.append((f"{base}.{alias.name}", base))
        else:
            results.append((alias.name, alias.name))
    return results


def _extract_imports(
    tree: ast.AST,
    mod_name: str,
    is_pkg: bool,
    known_modules: set[str],
) -> list[str]:
    targets: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                targets.append(alias.name)
        elif isinstance(node, ast.ImportFrom):
            for full, base in _resolve_import_from(node, mod_name, is_pkg):
                if full in known_modules or any(m.startswith(f"{full}.") for m in known_modules):
                    targets.append(full)
                else:
                    targets.append(base)
    return targets


def _find_cycles(graph: dict[str, set[str]]) -> list[list[str]]:
    state: dict[str, int] = {}
    stack: list[str] = []
    seen_cycles: set[tuple[str, ...]] = set()
    cycles: list[list[str]] = []

    def dfs(node: str) -> None:
        state[node] = 1
        stack.append(node)
        for nxt in sorted(graph.get(node, ())):
            st = state.get(nxt, 0)
            if st == 0:
                dfs(nxt)
            elif st == 1:
                idx = stack.index(nxt)
                ring = stack[idx:]
                min_i = ring.index(min(ring))
                canonical = tuple(ring[min_i:] + ring[:min_i])
                if canonical not in seen_cycles:
                    seen_cycles.add(canonical)
                    cycles.append([*canonical, canonical[0]])
        stack.pop()
        state[node] = 2

    for node in sorted(graph):
        if state.get(node, 0) == 0:
            dfs(node)

    return cycles


def _check_layer_rule(src_mod: str, dst_mod: str) -> str | None:
    src_parts = src_mod.split(".")
    dst_parts = dst_mod.split(".")
    src_top, dst_top = src_parts[0], dst_parts[0]

    if dst_top == "tests":
        return f"Production module imports tests: {src_mod} -> {dst_mod}"

    if src_top == "bellis_common" and dst_top in {"bellis_game", "bellis_host"}:
        return (
            f"Layer violation: bellis_common must not depend on {dst_top} ({src_mod} -> {dst_mod})"
        )

    if (
        src_top == "bellis_game"
        and dst_top == "bellis_game"
        and len(src_parts) >= 2
        and len(dst_parts) >= 2
    ):
        src_rank = GAME_LAYERS.get(src_parts[1])
        dst_rank = GAME_LAYERS.get(dst_parts[1])
        if src_rank is not None and dst_rank is not None and dst_rank > src_rank:
            return (
                f"Reverse layer dependency in bellis_game: "
                f"{src_mod} ({src_parts[1]}) -> {dst_mod} ({dst_parts[1]})"
            )

    return None


def check_repo(root: Path) -> GuardResult:
    errors: list[str] = []
    warnings: list[str] = []

    py_files, rs_files = _iter_prod_files(root)
    py_root = root / "py"

    # 1. File-level checks (line count, forbidden names, forbidden references)
    py_texts: dict[Path, str] = {}
    for path in [*py_files, *rs_files]:
        rel = path.relative_to(root).as_posix()
        text = path.read_text(encoding="utf-8")
        if path.suffix == ".py":
            py_texts[path] = text

        line_count = len(text.splitlines())
        if line_count > MAX_LINES:
            errors.append(f"File exceeds {MAX_LINES} lines ({line_count}): {rel}")
        elif line_count > WARN_LINES:
            warnings.append(f"File exceeds {WARN_LINES} lines ({line_count}): {rel}")

        if path.suffix == ".py" and (path.name.startswith("sim_") or path.name.endswith("_sim.py")):
            errors.append(f"Forbidden simulation file in production directory: {rel}")

        if "TraceService" in text:
            errors.append(f"Forbidden identifier 'TraceService' in production source: {rel}")

        if LOCAL_REF_RE.search(text):
            errors.append(f"Forbidden '.local' reference in production source: {rel}")

    # 2. Python AST dependency graph & layer checks
    mod_to_path: dict[str, Path] = {}
    for path in py_files:
        mod = _module_name(py_root, path)
        if mod:
            mod_to_path[mod] = path

    known_modules = set(mod_to_path)
    graph: dict[str, set[str]] = {mod: set() for mod in known_modules}

    for mod, path in sorted(mod_to_path.items()):
        rel = path.relative_to(root).as_posix()
        try:
            tree = ast.parse(py_texts[path], filename=rel)
        except SyntaxError as exc:
            errors.append(f"Syntax error in {rel}: {exc}")
            continue

        is_pkg = path.name == "__init__.py"
        for target in _extract_imports(tree, mod, is_pkg, known_modules):
            layer_err = _check_layer_rule(mod, target)
            if layer_err:
                errors.append(layer_err)

            if target in known_modules and target != mod:
                graph[mod].add(target)

    for cycle in _find_cycles(graph):
        errors.append(f"Circular dependency: {' -> '.join(cycle)}")

    return GuardResult(errors=errors, warnings=warnings)
