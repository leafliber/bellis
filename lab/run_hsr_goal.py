"""Run the HSR goal from one elevated Windows PowerShell: uv run python lab/run_hsr_goal.py"""

import argparse
import asyncio
import ctypes
import json
import sys
from contextlib import AsyncExitStack, suppress
from datetime import datetime
from pathlib import Path

from bellis_common.telemetry import JsonlTelemetry
from bellis_game.console import PermitServer
from bellis_game.io import (
    CoreClientOptions,
    FrameRing,
    FrameRingTornError,
    find_core_executable,
    frame_age_ns,
)
from bellis_game.io.protocol import ReleaseVerification
from bellis_game.loop import ActionRecord, GoalSet, LoopConfig
from bellis_game.loop.cli import open_loop, report_outcome, vlm_config
from bellis_game.perception import VlmClient, load_game_profile, resolve_vlm_api_key

REPO_ROOT = Path(__file__).resolve().parent.parent

DEFAULT_GOAL = (
    "从大世界打开手机菜单（按 esc 键），点击进入「星际和平指南」，确认当前停留在「每日实训」页签"
    "（若在其他页签则点击左侧「每日实训」切过去并确认可见每日实训活跃度或任务列表），"
    "达成后立即回报 done 停止。严禁点击商城、跃迁、充值、设置或任何消耗资源/不可逆按钮。"
)


def _is_admin() -> bool:
    if sys.platform != "win32":
        return False
    with suppress(Exception):
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    return False


async def _countdown(seconds: float, prompt: str) -> None:
    print(f"\n>>> {prompt}", flush=True)
    for rem in range(max(1, int(round(seconds))), 0, -1):
        print(f"    {rem}...", flush=True)
        await asyncio.sleep(1.0)


def _log_step(record: ActionRecord) -> None:
    print("[step]", json.dumps(record.to_prompt_dict(), ensure_ascii=False), flush=True)


async def _wait_for_capture(ring: FrameRing) -> None:
    max_age_ns = LoopConfig().max_frame_age_s * 1e9
    try:
        async with asyncio.timeout(10):
            while True:
                with suppress(FrameRingTornError):
                    frame = ring.read_latest()
                    if frame and frame_age_ns(frame.capture_ns) <= max_age_ns:
                        print(
                            f"[WGC] #{frame.frame_number} {frame.width}x{frame.height}", flush=True
                        )
                        return
                await asyncio.sleep(0.05)
    except TimeoutError:
        raise RuntimeError("未采到新帧，请检查 HSR 已打开且未最小化。") from None


async def _verify_release(permit: PermitServer, token: int, telemetry: JsonlTelemetry) -> bool:
    # input.stop revokes through this lease and returns the matching physical release ID.
    release_id = (await permit.stop_input(token)).release_id
    verification = "missing"
    with suppress(TimeoutError):
        async with asyncio.timeout(2):
            while release_id is not None:
                rel = permit.last_released
                if rel and rel.release_id == release_id:
                    verification = rel.verification.value
                    if rel.verification != ReleaseVerification.UNVERIFIED:
                        break
                await asyncio.sleep(0.02)
    ok = verification == ReleaseVerification.VERIFIED
    telemetry.record(
        "hsr.release", ok=ok, attrs={"release_id": release_id, "verification": verification}
    )
    print(f"[cleanup] 物理释放 #{release_id} · {verification}", flush=True)
    return ok


async def _run(args: argparse.Namespace) -> int:
    if not _is_admin() and not args.allow_non_admin:
        raise RuntimeError("请以管理员身份启动 PowerShell，或用 --allow-non-admin 测试普通窗口。")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    goal = GoalSet(f"hsr-{stamp}", args.goal, args.max_steps, args.timeout)
    profile = load_game_profile(args.profile)
    config = vlm_config(profile, args.base_url, args.model)
    api_key = resolve_vlm_api_key(config)
    executable = args.core_exe or find_core_executable(REPO_ROOT)
    if not executable.is_file():
        raise FileNotFoundError(executable)
    report = REPO_ROOT / "reports" / f"hsr-goal-{stamp}.jsonl"
    print(f"[preflight] VLM 凭据已就绪 · {profile.window.process_name} · {executable}", flush=True)
    print(f"[report] {report}\n[goal] {goal.description}", flush=True)
    async with AsyncExitStack() as stack:
        telemetry = stack.enter_context(JsonlTelemetry(report))
        vlm = await stack.enter_async_context(
            VlmClient(config, api_key=api_key, telemetry=telemetry)
        )
        permit = PermitServer(cred_target=None)
        stack.push_async_callback(permit.close)
        await permit.start()
        ring = stack.enter_context(FrameRing.create(args.max_width, args.max_height))
        options = CoreClientOptions(
            executable,
            permit_credentials=permit.credentials,
            emergency_hotkey=args.emergency_hotkey,
        )
        loop = await open_loop(stack, options, ring, profile, vlm, telemetry, on_step=_log_step)
        await permit.wait_connected(timeout=5)
        await _wait_for_capture(ring)
        await _countdown(5, f"请切到 HSR 大世界并松开键鼠。急停热键 {args.emergency_hotkey}。")
        stack.push_async_callback(permit.pause)
        token = await permit.grant_start()
        outcome = await loop.run_goal(goal)
        released = await _verify_release(permit, token, telemetry)
    code = report_outcome(outcome)
    print(f"[验收] {'PASS' if code == 0 and released else 'FAIL'} · {report}", flush=True)
    return code if released else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", type=Path, default=REPO_ROOT / "games" / "hsr.toml")
    parser.add_argument("--goal", default=DEFAULT_GOAL)
    parser.add_argument("--max-steps", type=int, default=8)
    parser.add_argument("--timeout", type=float, default=90.0)
    parser.add_argument("--core-exe", type=Path)
    parser.add_argument("--base-url")
    parser.add_argument("--model")
    parser.add_argument("--max-width", type=int, default=3840)
    parser.add_argument("--max-height", type=int, default=2160)
    parser.add_argument("--emergency-hotkey", default="ctrl+shift+f12")
    parser.add_argument("--allow-non-admin", action="store_true")
    args = parser.parse_args()
    try:
        return asyncio.run(_run(args))
    except KeyboardInterrupt:
        print("[验收] 已中断", file=sys.stderr)
    except Exception as exc:
        print(f"[验收] FAIL · {type(exc).__name__}: {exc}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
