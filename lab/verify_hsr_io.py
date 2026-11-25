"""Windows 11 HSR single-terminal guided realtime-core I/O verification script.

NOT part of automated CI/check gates. Runs an in-script unified 5-method PermitServer
over a real ``bellis-channel/1`` named pipe so you only need ONE elevated PowerShell:

  uv run python lab/verify_hsr_io.py

Sequence (solves the human-takeover deadlock by granting lease only AFTER you focus HSR
and release mouse/keyboard):
  1. Admin privilege preflight + WGC frame capture check (resolution / FPS / age)
  2. Focus-loss check (while terminal is still foreground -> expects focus_lost)
  3. Authorized input check (5s countdown to focus HSR & hands off -> grant -> press M / click)
  4. Human takeover check (move mouse or press a key -> expects takeover + verified)
  5. Emergency hotkey check (press Ctrl+Shift+F12 -> expects emergency_stop + verified)
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import ctypes
import sys
import time
from pathlib import Path

from bellis_common.channel import ChannelError, RpcError
from bellis_common.cred import DEFAULT_SESSION_TARGET
from bellis_game.console import PermitServer
from bellis_game.io import (
    CoreClient,
    CoreClientOptions,
    FrameRing,
    RingFrame,
    find_core_executable,
    frame_age_ns,
)
from bellis_game.io.protocol import (
    Accepted,
    Action,
    ActionBlock,
    ActionReceiptParams,
    Click,
    ControlStep,
    Executed,
    InputPolicy,
    InputReleasedParams,
    KeyPress,
    MouseButton,
    NormRect,
    Producer,
    ReleaseReason,
    ReleaseVerification,
    WindowTargetParams,
)

REPO_ROOT = Path(__file__).resolve().parent.parent


def _is_admin() -> bool:
    if sys.platform != "win32":
        return False
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def _beep(freq: int = 880, duration_ms: int = 120) -> None:
    if sys.platform != "win32":
        return
    with contextlib.suppress(Exception):
        import winsound

        winsound.Beep(freq, duration_ms)


def _frame_diff_ratio(before: RingFrame, after: RingFrame) -> float:
    if before.width != after.width or before.height != after.height:
        return 1.0
    step = max(64, len(before.pixels) // 4096)
    a = before.pixels[::step]
    b = after.pixels[::step]
    if not a:
        return 0.0
    diff = sum(1 for x, y in zip(a, b, strict=False) if abs(x - y) > 4)
    return diff / len(a)


async def _countdown(seconds: float, prompt: str) -> None:
    whole = max(1, int(round(seconds)))
    print(f"\n>>> {prompt}", flush=True)
    for rem in range(whole, 0, -1):
        print(f"    {rem}...", flush=True)
        await asyncio.sleep(1.0)
    _beep(1046, 100)


class _EventCollector:
    """Tracks release & receipt notifications for deterministic step waits."""

    def __init__(self) -> None:
        self.releases: list[InputReleasedParams] = []
        self.receipts: list[ActionReceiptParams] = []
        self._event = asyncio.Event()

    def on_released(self, rel: InputReleasedParams) -> None:
        self.releases.append(rel)
        res = f" residual={len(rel.residual_items)}" if rel.residual_items else ""
        print(
            f"  [input.released] id={rel.release_id} token={rel.token} "
            f"reason={rel.reason.value} ver={rel.verification.value}{res}",
            flush=True,
        )
        self._event.set()

    def on_receipt(self, rec: ActionReceiptParams) -> None:
        self.receipts.append(rec)
        print(f"  [action.receipt] seq={rec.block_seq} outcomes={rec.outcomes}", flush=True)
        self._event.set()

    def mark(self) -> tuple[int, int]:
        return len(self.releases), len(self.receipts)

    async def wait_receipt(
        self, start_idx: int, block_seq: int, timeout: float
    ) -> ActionReceiptParams | None:
        deadline = time.monotonic() + timeout
        while True:
            for rec in self.receipts[start_idx:]:
                if rec.block_seq == block_seq:
                    return rec
            rem = deadline - time.monotonic()
            if rem <= 0:
                return None
            self._event.clear()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._event.wait(), timeout=rem)

    async def wait_release(
        self,
        start_idx: int,
        reason: ReleaseReason,
        *,
        require_final: bool = True,
        timeout: float = 10.0,
    ) -> InputReleasedParams | None:
        deadline = time.monotonic() + timeout
        matched_id: int | None = None
        first_match: InputReleasedParams | None = None
        while True:
            for rel in self.releases[start_idx:]:
                if rel.reason is reason:
                    if matched_id is None:
                        matched_id = rel.release_id
                        first_match = rel
                    if not require_final or (
                        rel.release_id == matched_id
                        and rel.verification is not ReleaseVerification.UNVERIFIED
                    ):
                        return rel
            rem = deadline - time.monotonic()
            if rem <= 0:
                return first_match
            self._event.clear()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._event.wait(), timeout=rem)


async def _heartbeat_loop(client: CoreClient, producer: Producer, interval: float = 0.1) -> None:
    seq = 0
    try:
        while client.running:
            seq += 1
            with contextlib.suppress(ChannelError):
                client.send_heartbeat(producer, seq)
            await asyncio.sleep(interval)
    except asyncio.CancelledError:
        return


async def _sample_wgc(ring: FrameRing, seconds: float = 2.5) -> RingFrame | None:
    deadline = time.monotonic() + seconds
    first_t = 0.0
    last: RingFrame | None = None
    seen = 0
    while time.monotonic() < deadline:
        frame = ring.read_latest()
        if frame is not None and (last is None or frame.frame_number != last.frame_number):
            if seen == 0:
                first_t = time.monotonic()
            last = frame
            seen += 1
        await asyncio.sleep(0.015)
    if last is None:
        return None
    elapsed = max(0.001, time.monotonic() - first_t)
    fps = (seen - 1) / elapsed if seen > 1 else 0.0
    age_ms = frame_age_ns(last.capture_ns) / 1_000_000.0
    print(
        f"  [WGC] frame=#{last.frame_number} res={last.width}x{last.height} "
        f"fps~{fps:.1f} age={age_ms:.1f}ms",
        flush=True,
    )
    return last


def _make_action(args: argparse.Namespace, action_id: int, frame: RingFrame) -> tuple[Action, str]:
    if args.mode == "click":
        x = args.click_x if args.click_x is not None else int(frame.width * args.click_norm_x)
        y = args.click_y if args.click_y is not None else int(frame.height * args.click_norm_y)
        return Click(id=action_id, x=x, y=y, button=MouseButton.LEFT), f"left-click ({x}, {y})"
    return (
        KeyPress(id=action_id, scan_code=args.scan_code),
        f"key_press scan_code={args.scan_code}",
    )


async def _run(args: argparse.Namespace) -> int:
    admin = _is_admin()
    print(f"[preflight] Elevated Admin = {admin}", flush=True)
    if not admin and not args.allow_non_admin:
        print(
            "\n[BLOCKED] 当前终端不是管理员权限！\n"
            "《崩坏：星穹铁道》(StarRail.exe) 默认以管理员权限运行，普通权限进程发出的 SendInput\n"
            "会被 Windows UIPI 静默拦截（WGC 可能仍能采到帧，但游戏不会对键鼠有任何反应）。\n"
            "请右键“以管理员身份运行”PowerShell 后再执行本脚本"
            "（测试非提权窗口可加 --allow-non-admin）。",
            flush=True,
        )
        return 2

    core_exe = Path(args.core_exe) if args.core_exe else find_core_executable(REPO_ROOT)
    print(f"[preflight] realtime-core = {core_exe}", flush=True)

    results: dict[str, str] = {
        "1. WGC 采帧": "FAIL",
        "2. 失焦保护 (focus_lost)": "SKIP",
        "3. 授权输入与回执": "FAIL",
        "4. 真人接管 (takeover + verified)": "SKIP",
        "5. 急停热键 (emergency_stop + verified)": "SKIP",
    }

    collector = _EventCollector()
    cred_target = DEFAULT_SESSION_TARGET if args.use_credman else None
    permit = PermitServer(
        cred_target=cred_target,
        lease_ttl_s=2.0,
        renew_interval_s=0.4,
        on_event=lambda msg: print(f"  {msg}", flush=True),
    )
    info = await permit.start()
    print(
        f"[preflight] PermitServer ready (session={info.session_id}, "
        f"handoff={'CredMan:' + cred_target if cred_target else 'direct-pipe'})",
        flush=True,
    )

    options = CoreClientOptions(
        executable=core_exe,
        heartbeat_timeout=0.5,
        health_interval=1.0,
        max_frame_age=0.5,
        permit_credentials=None if args.use_credman else permit.credentials,
        permit_cred=cred_target,
        permit_session_id=info.session_id if args.use_credman else None,
        emergency_hotkey=args.emergency_hotkey,
    )
    producer = Producer(id="hsr-io-verify", generation=1)
    seq = 0
    aid = 0

    try:
        with FrameRing.create(args.max_width, args.max_height, slot_count=3) as ring:
            client = CoreClient(
                options,
                on_released=collector.on_released,
                on_receipt=collector.on_receipt,
            )
            await client.start()
            await permit.wait_connected(timeout=5.0)
            hb_task: asyncio.Task[None] | None = None
            try:
                await client.attach_frame_ring(ring)
                target = WindowTargetParams(
                    process_name=args.process,
                    window_class=args.window_class or None,
                    title=args.title or None,
                )
                await client.set_capture_target(target)
                policy = InputPolicy(
                    click_buttons=(MouseButton.LEFT,),
                    press_keys=(args.scan_code,),
                    scroll=False,
                    click_regions=(NormRect(0.05, 0.05, 0.95, 0.95),),
                    forbidden_zones=(NormRect(0.90, 0.0, 1.0, 0.10),),
                    press_duration_ms=60,
                    max_rate=4.0,
                    hold_keys=(),
                    hold_buttons=(),
                    max_hold_ms=None,
                )
                await client.configure_input(policy)
                hb_task = asyncio.create_task(_heartbeat_loop(client, producer))

                # --- 1/5: WGC 采帧 ---
                print(f"\n[1/5] 检查 WGC 采帧 ({target.process_name})...", flush=True)
                frame = await _sample_wgc(ring, seconds=2.5)
                if frame is None:
                    print("  未采到帧：请确保游戏已打开且未最小化，继续等待 8 秒...", flush=True)
                    frame = await _sample_wgc(ring, seconds=8.0)
                if frame is None:
                    print("  [FAIL] 无法采集到目标窗口帧，请检查进程名/窗口类名。", flush=True)
                    return 1
                results["1. WGC 采帧"] = f"PASS ({frame.width}x{frame.height})"

                # --- 2/5: 失焦保护（趁终端还在前台直接测） ---
                print(
                    "\n[2/5] 失焦保护测试（保持当前终端在前台，松开键鼠 1 秒）...",
                    flush=True,
                )
                await asyncio.sleep(1.0)
                r_idx, _ = collector.mark()
                await permit.grant_start()
                await asyncio.sleep(0.08)
                seq += 1
                aid += 1
                latest = ring.read_latest() or frame
                act, desc = _make_action(args, aid, latest)
                now = time.perf_counter_ns()
                block = ActionBlock(
                    producer=producer,
                    seq=seq,
                    base_frame=latest.frame_number,
                    start_ns=now,
                    deadline_ns=now + 500_000_000,
                    steps=(ControlStep(offset_ns=0, held=(), actions=(act,)),),
                )
                await client.submit_action_block(block)
                fl = await collector.wait_release(
                    r_idx, ReleaseReason.FOCUS_LOST, require_final=False, timeout=2.0
                )
                await permit.pause()
                if fl is not None:
                    results["2. 失焦保护 (focus_lost)"] = "PASS"
                else:
                    results["2. 失焦保护 (focus_lost)"] = (
                        "FAIL (未收到 focus_lost；若游戏已在前台可忽略)"
                    )

                # --- 3/5: 授权输入 + 画面变化核验 ---
                await _countdown(
                    args.focus_countdown,
                    f"[3/5] 请切到 HSR 窗口并【完全松开键鼠】，倒计时后自动授权执行 {desc}",
                )
                before = ring.read_latest()
                if before is None:
                    print("  [FAIL] 当前无可用帧。", flush=True)
                    return 1
                _, rec_idx = collector.mark()
                tok = await permit.grant_start()
                print(f"  [grant] 已静默授予许可 token={tok}", flush=True)
                await asyncio.sleep(0.12)

                seq += 1
                aid += 1
                fresh = ring.read_latest() or before
                act, desc = _make_action(args, aid, fresh)
                now = time.perf_counter_ns()
                block = ActionBlock(
                    producer=producer,
                    seq=seq,
                    base_frame=fresh.frame_number,
                    start_ns=now,
                    deadline_ns=now + 500_000_000,
                    steps=(ControlStep(offset_ns=0, held=(), actions=(act,)),),
                )
                submit_res = await client.submit_action_block(block)
                print(f"  [submit] {desc} -> {submit_res}", flush=True)
                rec = await collector.wait_receipt(rec_idx, seq, timeout=1.5)
                await asyncio.sleep(0.4)
                after = ring.read_latest()
                diff_pct = _frame_diff_ratio(fresh, after) * 100.0 if after is not None else 0.0
                print(f"  [frame-diff] 动作后画面变化率 ≈ {diff_pct:.1f}%", flush=True)
                if (
                    isinstance(submit_res, Accepted)
                    and rec is not None
                    and any(isinstance(o, Executed) for o in rec.outcomes)
                ):
                    results["3. 授权输入与回执"] = f"PASS (Executed, 画面变化 {diff_pct:.1f}%)"
                else:
                    results["3. 授权输入与回执"] = f"FAIL (submit={submit_res}, receipt={rec})"

                # --- 4/5: 真人接管撤权 ---
                if permit.active_token is None:
                    await asyncio.sleep(1.0)
                    await permit.grant_start()
                    await asyncio.sleep(0.08)
                r_idx, _ = collector.mark()
                _beep(660, 140)
                print(
                    "\n>>> [4/5] 请【移动鼠标或按一个键】以触发真人接管（限时 12 秒）...",
                    flush=True,
                )
                tk = await collector.wait_release(
                    r_idx, ReleaseReason.TAKEOVER, require_final=True, timeout=12.0
                )
                if tk is not None:
                    results["4. 真人接管 (takeover + verified)"] = (
                        f"PASS (ver={tk.verification.value})"
                    )
                else:
                    results["4. 真人接管 (takeover + verified)"] = "FAIL (超时未触发 takeover)"

                # --- 5/5: 急停热键物理释放 ---
                await _countdown(
                    3.0,
                    f"[5/5] 请短暂【松开键鼠】3 秒，随后按急停热键 {args.emergency_hotkey}！",
                )
                r_idx, _ = collector.mark()
                await permit.grant_start()
                await asyncio.sleep(0.08)
                _beep(1320, 180)
                print(
                    f">>> 现在请按下急停热键 【{args.emergency_hotkey}】（限时 12 秒）...",
                    flush=True,
                )
                es = await collector.wait_release(
                    r_idx, ReleaseReason.EMERGENCY_STOP, require_final=True, timeout=12.0
                )
                if es is not None:
                    results["5. 急停热键 (emergency_stop + verified)"] = (
                        f"PASS (ver={es.verification.value})"
                    )
                else:
                    results["5. 急停热键 (emergency_stop + verified)"] = (
                        "FAIL (超时未触发 emergency_stop)"
                    )
            finally:
                if hb_task is not None:
                    hb_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await hb_task
                with contextlib.suppress(ChannelError, RpcError):
                    await client.revoke_producer(producer.generation)
                stop_res = await client.stop()
                print(f"\n[cleanup] realtime-core stopped: {stop_res}", flush=True)
    finally:
        await permit.close()

    print("\n================ HSR 实时核 I/O 真机验收汇总 ================", flush=True)
    for k, v in results.items():
        print(f"  {k:<40} : {v}")
    print("============================================================", flush=True)
    return 0 if all(v.startswith("PASS") for v in results.values()) else 1


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Single-terminal guided Windows 11 HSR realtime-core I/O verification."
    )
    parser.add_argument("--process", default="StarRail.exe", help="Target process executable name")
    parser.add_argument("--window-class", default="UnityWndClass", help="Exact Win32 window class")
    parser.add_argument("--title", default=None, help="Optional exact window title")
    parser.add_argument(
        "--mode",
        choices=("key", "click"),
        default="key",
        help="Authorized action to test (default: key press M)",
    )
    parser.add_argument(
        "--scan-code",
        type=int,
        default=50,
        help="Set 1 scan code for --mode key (50=M map, 1=Esc menu, 57=Space)",
    )
    parser.add_argument(
        "--click-x", type=int, default=None, help="Absolute client X for --mode click"
    )
    parser.add_argument(
        "--click-y", type=int, default=None, help="Absolute client Y for --mode click"
    )
    parser.add_argument(
        "--click-norm-x", type=float, default=0.5, help="Normalized X for --mode click"
    )
    parser.add_argument(
        "--click-norm-y", type=float, default=0.5, help="Normalized Y for --mode click"
    )
    parser.add_argument(
        "--focus-countdown",
        type=float,
        default=5.0,
        help="Seconds given to switch focus to HSR and release hands before granting lease",
    )
    parser.add_argument(
        "--emergency-hotkey", default="ctrl+shift+f12", help="Emergency stop hotkey"
    )
    parser.add_argument("--use-credman", action="store_true", help="Also exercise CredMan handoff")
    parser.add_argument(
        "--allow-non-admin",
        action="store_true",
        help="Allow running without admin rights (for non-elevated target windows)",
    )
    parser.add_argument("--max-width", type=int, default=3840)
    parser.add_argument("--max-height", type=int, default=2160)
    parser.add_argument("--core-exe", default=None)
    args = parser.parse_args()
    try:
        return asyncio.run(_run(args))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
