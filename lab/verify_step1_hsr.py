"""Step 1 Windows interactive HSR real-machine verification script (NOT part of automated gates).

Usage on Windows 11 interactive desktop with Honkai: Star Rail running:
  Terminal 1:
    uv run permit-console
  Terminal 2:
    uv run python lab/verify_step1_hsr.py

Type ``start`` in Terminal 1 to grant an input lease before testing authorized actions,
then exercise focus-loss, human mouse/key takeover, ``pause``, ``stop``, and emergency hotkey.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import os
import sys
import time
from pathlib import Path

from bellis_common.channel import ChannelCredentials, ChannelError, RpcError
from bellis_common.cred import DEFAULT_SESSION_TARGET, read_session_info
from bellis_game.io import (
    ENV_PERMIT_KEY,
    ENV_PERMIT_PATH,
    CoreClient,
    CoreClientOptions,
    FrameRing,
    find_core_executable,
    frame_age_ns,
)
from bellis_game.io.protocol import (
    ActionBlock,
    ActionReceiptParams,
    Click,
    ControlStep,
    HealthParams,
    InputPolicy,
    InputReleasedParams,
    KeyPress,
    MouseButton,
    NormRect,
    Producer,
    WindowTargetParams,
)

REPO_ROOT = Path(__file__).resolve().parent.parent


def _resolve_permit_options(args: argparse.Namespace) -> tuple[ChannelCredentials | None, str | None, str | None]:
    env_path = os.environ.get(ENV_PERMIT_PATH)
    env_key = os.environ.get(ENV_PERMIT_KEY)
    if args.permit_path or args.permit_key:
        if not (args.permit_path and args.permit_key):
            raise SystemExit("Pass both --permit-path and --permit-key together.")
        return ChannelCredentials.decode(args.permit_path, args.permit_key), None, None
    if env_path or env_key:
        if not (env_path and env_key):
            raise SystemExit(f"Set both {ENV_PERMIT_PATH} and {ENV_PERMIT_KEY} together.")
        return ChannelCredentials.decode(env_path, env_key), None, None
    info = read_session_info(args.cred_target)
    if info is None:
        raise SystemExit(
            f"No permit session found in Windows Credential Manager target {args.cred_target!r}.\n"
            "Start Terminal 1 first: uv run permit-console"
        )
    print(f"[hsr] Found permit session {info.session_id} (launcher pid={info.launcher_pid})")
    return None, args.cred_target, info.session_id


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


async def _sample_wgc_frames(ring: FrameRing, seconds: float = 3.0) -> tuple[int, int, int] | None:
    print(f"[hsr] Waiting for WGC frames (sampling up to {seconds:.1f}s)...", flush=True)
    deadline = time.monotonic() + seconds
    first_num: int | None = None
    first_t = 0.0
    last_frame = None
    seen = 0
    while time.monotonic() < deadline:
        frame = ring.read_latest()
        if frame is not None and (last_frame is None or frame.frame_number != last_frame.frame_number):
            if first_num is None:
                first_num = frame.frame_number
                first_t = time.monotonic()
            last_frame = frame
            seen += 1
        await asyncio.sleep(0.015)
    if last_frame is None:
        print("[hsr] No frames received yet (check game process/class/title and window visibility).")
        return None
    elapsed = max(0.001, time.monotonic() - first_t)
    fps = (seen - 1) / elapsed if seen > 1 else 0.0
    age_ms = frame_age_ns(last_frame.capture_ns) / 1_000_000.0
    print(
        f"[hsr] WGC OK: frame=#{last_frame.frame_number} res={last_frame.width}x{last_frame.height} "
        f"stride={last_frame.row_stride} fps~{fps:.1f} age={age_ms:.1f}ms",
        flush=True,
    )
    return last_frame.frame_number, last_frame.width, last_frame.height


async def _run(args: argparse.Namespace) -> int:
    core_exe = Path(args.core_exe) if args.core_exe else find_core_executable(REPO_ROOT)
    permit_direct, permit_cred, permit_sid = _resolve_permit_options(args)
    print(f"[hsr] Using realtime-core: {core_exe}", flush=True)

    def on_released(rel: InputReleasedParams) -> None:
        res = f" residual={len(rel.residual_items)}" if rel.residual_items else ""
        print(
            f"\n[event:input.released] id={rel.release_id} token={rel.token} "
            f"reason={rel.reason.value} verification={rel.verification.value}{res}",
            flush=True,
        )

    def on_receipt(rec: ActionReceiptParams) -> None:
        print(f"\n[event:action.receipt] seq={rec.block_seq} outcomes={rec.outcomes}", flush=True)

    last_health_box: list[HealthParams] = []

    def on_health(h: HealthParams) -> None:
        last_health_box[:] = [h]

    options = CoreClientOptions(
        executable=core_exe,
        heartbeat_timeout=0.5,
        health_interval=1.0,
        max_frame_age=0.5,
        permit_credentials=permit_direct,
        permit_cred=permit_cred,
        permit_session_id=permit_sid,
        emergency_hotkey=args.emergency_hotkey,
    )
    producer = Producer(id="step1-hsr-verify", generation=1)
    block_seq = 0
    action_id = 0

    with FrameRing.create(args.max_width, args.max_height, slot_count=3) as ring:
        client = CoreClient(options, on_released=on_released, on_receipt=on_receipt, on_health=on_health)
        await client.start()
        hb_task: asyncio.Task[None] | None = None
        try:
            await client.attach_frame_ring(ring)
            target = WindowTargetParams(
                process_name=args.process,
                window_class=args.window_class or None,
                title=args.title or None,
            )
            await client.set_capture_target(target)
            print(f"[hsr] Capture target set: {target}", flush=True)

            policy = InputPolicy(
                click_buttons=(MouseButton.LEFT,),
                press_keys=(args.press_scan_code,),
                scroll=False,
                click_regions=(NormRect(0.05, 0.05, 0.95, 0.95),),
                forbidden_zones=(NormRect(0.90, 0.0, 1.0, 0.10),),
                press_duration_ms=50,
                max_rate=4.0,
                hold_keys=(),
                hold_buttons=(),
                max_hold_ms=None,
            )
            await client.configure_input(policy)
            print("[hsr] Conservative InputPolicy configured.", flush=True)

            await _sample_wgc_frames(ring, seconds=3.0)
            hb_task = asyncio.create_task(_heartbeat_loop(client, producer))
            print(
                "\nInteractive verification menu (grant lease with `start` in Terminal 1 first):\n"
                "  f           : sample WGC frames (resolution / FPS / age)\n"
                f"  c [delay_s] : send one authorized left-click (default delay {args.action_delay:.1f}s to focus HSR; use `c 0` to test focus_lost)\n"
                f"  k [delay_s] : send one authorized short key press (scan code {args.press_scan_code}; default delay {args.action_delay:.1f}s)\n"
                "  s           : print latest health, frame, and input.released status\n"
                "  q           : revoke producer, stop realtime-core cleanly, and exit\n"
                "Tips: keep Terminal 2 focused with `c 0` (or Alt+Tab away) to verify focus_lost;\n"
                "      move mouse or press a key to verify takeover; press Ctrl+Shift+F12 (or\n"
                "      `pause`/`stop` in Terminal 1) to verify immediate physical release verification.\n",
                flush=True,
            )
            while True:
                line = await asyncio.to_thread(sys.stdin.readline)
                if not line:
                    break
                parts = line.strip().lower().split()
                if not parts:
                    continue
                cmd = parts[0]
                if cmd == "q":
                    break
                if cmd == "f":
                    await _sample_wgc_frames(ring, seconds=2.0)
                elif cmd == "s":
                    frame = ring.read_latest()
                    if frame is not None:
                        age = frame_age_ns(frame.capture_ns) / 1_000_000.0
                        print(f"[status] frame=#{frame.frame_number} {frame.width}x{frame.height} age={age:.1f}ms")
                    else:
                        print("[status] frame=none")
                    print(f"[status] health={last_health_box[0] if last_health_box else None}")
                    print(f"[status] last_released={client.last_released}", flush=True)
                elif cmd in {"c", "k"}:
                    delay = args.action_delay
                    if len(parts) > 1:
                        try:
                            delay = max(0.0, float(parts[1]))
                        except ValueError:
                            print("[warn] Invalid delay seconds; expected a number.", flush=True)
                            continue
                    if delay > 0:
                        print(f"[hsr] Focus HSR window now — firing in {delay:.1f}s...", flush=True)
                        await asyncio.sleep(delay)
                    frame = ring.read_latest()
                    if frame is None:
                        print("[warn] No captured frame available; focus HSR window first.", flush=True)
                        continue
                    block_seq += 1
                    action_id += 1
                    now = time.perf_counter_ns()
                    if cmd == "c":
                        x = args.click_x if args.click_x is not None else int(frame.width * args.click_norm_x)
                        y = args.click_y if args.click_y is not None else int(frame.height * args.click_norm_y)
                        action = Click(id=action_id, x=x, y=y, button=MouseButton.LEFT)
                        print(f"[send] click ({x}, {y}) on base_frame=#{frame.frame_number}", flush=True)
                    else:
                        action = KeyPress(id=action_id, scan_code=args.press_scan_code)
                        print(
                            f"[send] key_press scan_code={args.press_scan_code} on base_frame=#{frame.frame_number}",
                            flush=True,
                        )
                    block = ActionBlock(
                        producer=producer,
                        seq=block_seq,
                        base_frame=frame.frame_number,
                        start_ns=now,
                        deadline_ns=now + 500_000_000,
                        steps=(ControlStep(offset_ns=0, held=(), actions=(action,)),),
                    )
                    try:
                        res = await client.submit_action_block(block)
                        print(f"[submit] result={res}", flush=True)
                    except (ChannelError, RpcError) as exc:
                        print(f"[err] submit failed: {exc}", flush=True)
                else:
                    print("Unknown command (use f | c [sec] | k [sec] | s | q).", flush=True)
        finally:
            if hb_task is not None:
                hb_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await hb_task
            with contextlib.suppress(ChannelError, RpcError):
                await client.revoke_producer(producer.generation)
            stop_res = await client.stop()
            print(f"[hsr] realtime-core stopped: {stop_res}", flush=True)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Manual Windows 11 HSR Step 1 verification.")
    parser.add_argument("--process", default="StarRail.exe", help="Target process executable name")
    parser.add_argument("--window-class", default="UnityWndClass", help="Exact Win32 window class")
    parser.add_argument("--title", default=None, help="Optional exact window title")
    parser.add_argument("--cred-target", default=DEFAULT_SESSION_TARGET, help="CredMan target name")
    parser.add_argument("--permit-path", default=None, help="Direct permit pipe path (overrides CredMan)")
    parser.add_argument("--permit-key", default=None, help="Direct permit key (overrides CredMan)")
    parser.add_argument("--emergency-hotkey", default="ctrl+shift+f12", help="Emergency stop hotkey")
    parser.add_argument("--click-x", type=int, default=None, help="Absolute client X for safe click")
    parser.add_argument("--click-y", type=int, default=None, help="Absolute client Y for safe click")
    parser.add_argument("--click-norm-x", type=float, default=0.5, help="Normalized X if --click-x unset")
    parser.add_argument("--click-norm-y", type=float, default=0.5, help="Normalized Y if --click-y unset")
    parser.add_argument("--press-scan-code", type=int, default=57, help="Set 1 scan code (57=Space)")
    parser.add_argument("--action-delay", type=float, default=2.5, help="Default seconds to focus HSR before c/k")
    parser.add_argument("--max-width", type=int, default=3840, help="FrameRing max width")
    parser.add_argument("--max-height", type=int, default=2160, help="FrameRing max height")
    parser.add_argument("--core-exe", default=None, help="Explicit path to realtime-core.exe")
    args = parser.parse_args()
    try:
        return asyncio.run(_run(args))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
