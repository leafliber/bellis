"""Run game goals using an externally authorized realtime core."""

import argparse
import asyncio
import json
import sys
from collections.abc import Callable, Sequence
from contextlib import AsyncExitStack
from dataclasses import asdict, replace
from pathlib import Path
from uuid import uuid4

from bellis_common import agent_events as ev
from bellis_common.agent_events import DEFAULT_GAME_LINK_TARGET, GAME_AGENT_ROLE
from bellis_common.cred import DEFAULT_CORE_TARGET, DEFAULT_SESSION_TARGET
from bellis_common.telemetry import JsonlTelemetry

from bellis_game.io import CoreClient, CoreClientOptions, FrameRing, find_core_executable
from bellis_game.io.protocol import Producer
from bellis_game.perception import GameProfile, VlmClient, VlmConfig, load_game_profile
from bellis_game.skills import ActionExecutor

from .agent import FastLoop
from .events import ActionRecord, ControlReleased, GoalCompleted, GoalSet, LoopOutcome
from .session import GameSession, GameSessionConfig


def _runtime_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", type=Path, default=Path("games/hsr.toml"))
    parser.add_argument("--permit-cred", default=DEFAULT_SESSION_TARGET)
    parser.add_argument("--permit-session-id")
    parser.add_argument("--emergency-hotkey", default="ctrl+shift+f12")
    parser.add_argument("--telemetry", type=Path)
    parser.add_argument("--core-exe", type=Path)
    parser.add_argument("--core-task")
    parser.add_argument("--core-cred", default=DEFAULT_CORE_TARGET)
    parser.add_argument("--base-url")
    parser.add_argument("--model")
    parser.add_argument("--max-width", type=int, default=3840)
    parser.add_argument("--max-height", type=int, default=2160)
    return parser


def build_parser() -> argparse.ArgumentParser:
    parser = _runtime_parser()
    parser.add_argument("--goal", required=True)
    parser.add_argument("--goal-id")
    parser.add_argument("--max-steps", type=int, default=8)
    parser.add_argument("--timeout", type=float, default=90.0)
    return parser


def build_serve_parser() -> argparse.ArgumentParser:
    parser = _runtime_parser()
    parser.prog += " serve"
    parser.add_argument("--link-cred", default=DEFAULT_GAME_LINK_TARGET)
    return parser


def core_options(args: argparse.Namespace) -> CoreClientOptions:
    if args.core_task:
        return CoreClientOptions(
            core_task=args.core_task,
            core_cred=args.core_cred,
            permit_cred=args.permit_cred,
            permit_session_id=args.permit_session_id,
            emergency_hotkey=args.emergency_hotkey,
        )
    return CoreClientOptions(
        executable=args.core_exe or find_core_executable(),
        permit_cred=args.permit_cred,
        permit_session_id=args.permit_session_id,
        emergency_hotkey=args.emergency_hotkey,
    )


def vlm_config(profile: GameProfile, base_url: str | None, model: str | None) -> VlmConfig:
    config = VlmConfig.from_profile(profile.vlm)
    return replace(
        config,
        base_url=config.base_url if base_url is None else base_url,
        model=config.model if model is None else model,
    )


def _core_client(
    options: CoreClientOptions, receiver: Callable[[], ActionExecutor | GameSession]
) -> CoreClient:
    return CoreClient(
        options,
        on_receipt=lambda rec: receiver().on_receipt(rec),
        on_released=lambda rel: receiver().on_released(rel),
    )


async def open_loop(
    stack: AsyncExitStack,
    options: CoreClientOptions,
    ring: FrameRing,
    profile: GameProfile,
    vlm: VlmClient,
    telemetry: JsonlTelemetry | None,
    *,
    on_step: Callable[[ActionRecord], None] | None = None,
) -> FastLoop:
    producer = Producer(GAME_AGENT_ROLE, generation=1)

    core = _core_client(options, lambda: executor)
    executor = ActionExecutor(core, ring, profile, producer)

    await _start_core(stack, core, ring, profile)
    loop = FastLoop(
        core, ring, vlm, executor, profile, producer, telemetry=telemetry, on_step=on_step
    )
    stack.push_async_callback(loop.close)
    return loop


async def _start_core(
    stack: AsyncExitStack,
    core: CoreClient,
    ring: FrameRing,
    profile: GameProfile,
) -> None:
    async def stop_core() -> None:
        result = await core.stop()
        if result.returncode != 0:
            raise RuntimeError(
                f"realtime core shutdown failed ({result.stage}, {result.returncode})"
            )

    await core.start()
    stack.push_async_callback(stop_core)
    await core.attach_frame_ring(ring)
    await core.set_capture_target(profile.window)
    await core.configure_input(profile.input_policy)


def report_outcome(outcome: LoopOutcome) -> int:
    print(type(outcome).__name__, json.dumps(asdict(outcome), ensure_ascii=False), flush=True)
    if isinstance(outcome, GoalCompleted):
        return 0
    return 2 if isinstance(outcome, ControlReleased) else 1


async def _resources(
    stack: AsyncExitStack,
    args: argparse.Namespace,
    profile: GameProfile,
) -> tuple[JsonlTelemetry | None, VlmClient, FrameRing]:
    telemetry = stack.enter_context(JsonlTelemetry(args.telemetry)) if args.telemetry else None
    vlm = await stack.enter_async_context(
        VlmClient(vlm_config(profile, args.base_url, args.model), telemetry=telemetry)
    )
    ring = stack.enter_context(FrameRing.create(args.max_width, args.max_height))
    return telemetry, vlm, ring


def _log_json(label: str, data: dict[str, object]) -> None:
    print(label, json.dumps(data, ensure_ascii=False), flush=True)


def _log_command(cmd: ev.SlowCommand, ack: ev.CommandAck) -> None:
    fields = ("goal_id", "description", "decision_id", "chosen_index", "chosen_option")
    data = {key: value for key, value in cmd.to_dict().items() if key in fields}
    if isinstance(cmd, ev.GoalSet) and len(cmd.description) > 80:
        data["description"] = cmd.description[:79] + "…"
    data["accepted"] = ack.accepted
    if ack.reason:
        data["reason"] = ack.reason
    _log_json(f"[command] {cmd.TAG}", data)


async def _serve(args: argparse.Namespace) -> int:
    profile = load_game_profile(args.profile)
    print(f"[game-agent] starting {profile.game_id} ({profile.window.process_name})", flush=True)
    async with AsyncExitStack() as stack:
        telemetry, vlm, ring = await _resources(stack, args, profile)

        core = _core_client(core_options(args), lambda: session)
        config = GameSessionConfig(link_cred_target=args.link_cred)
        session = GameSession(
            core, ring, vlm, profile, config, telemetry=telemetry,
            on_connected=lambda: print(
                f"[game-agent] connected host ({args.link_cred})", flush=True
            ),
            on_command=_log_command,
            on_step=lambda record: _log_json("[step]", record.to_prompt_dict()),
            on_event=lambda event: _log_json(f"[event] {event.TAG}", event.to_dict()),
        )  # fmt: skip
        await _start_core(stack, core, ring, profile)
        stack.push_async_callback(session.close)
        await session.run()
        print("[game-agent] disconnected", flush=True)
    return 0


async def _run(args: argparse.Namespace) -> int:
    goal = GoalSet(
        uuid4().hex if args.goal_id is None else args.goal_id,
        args.goal,
        args.max_steps,
        args.timeout,
    )
    profile = load_game_profile(args.profile)
    options = core_options(args)
    async with AsyncExitStack() as stack:
        telemetry, vlm, ring = await _resources(stack, args, profile)
        loop = await open_loop(stack, options, ring, profile, vlm, telemetry)
        outcome = await loop.run_goal(goal)
    return report_outcome(outcome)


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args_list = list(sys.argv[1:] if argv is None else argv)
        serve = args_list[:1] == ["serve"]
        parser = build_serve_parser() if serve else build_parser()
        args = parser.parse_args(args_list[1:] if serve else args_list)
    except SystemExit as exc:
        return 1 if exc.code else 0
    try:
        return asyncio.run(_serve(args) if serve else _run(args))
    except KeyboardInterrupt:
        return 1
    except Exception as exc:
        print(f"game-agent: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
