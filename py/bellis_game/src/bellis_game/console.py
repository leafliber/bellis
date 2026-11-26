"""Standalone permit control console speaking the unified 5-method permit RPC."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import signal
import sys
import threading

from bellis_common import channel as ch
from bellis_common.cred import DEFAULT_SESSION_TARGET
from bellis_common.permit import (
    DEFAULT_LEASE_TTL_S,
    DEFAULT_RENEW_INTERVAL_S,
    PERMIT_ROLE,
    PermitServer,
)
from bellis_common.permit import (
    DEFAULT_RPC_TIMEOUT_S as DEFAULT_RPC_TIMEOUT_S,
)
from bellis_common.wire_codec import ProtocolError

from bellis_game.io.core_client import ENV_PERMIT_KEY, ENV_PERMIT_PATH


def _start_stdin_reader(loop: asyncio.AbstractEventLoop) -> asyncio.Queue[str]:
    """Read stdin on a daemon thread so Ctrl+C on Windows never blocks default executor shutdown."""
    queue: asyncio.Queue[str] = asyncio.Queue()

    def _pump() -> None:
        try:
            while True:
                line = sys.stdin.readline()
                with contextlib.suppress(RuntimeError):
                    loop.call_soon_threadsafe(queue.put_nowait, line)
                if not line:
                    return
        except OSError:
            with contextlib.suppress(RuntimeError):
                loop.call_soon_threadsafe(queue.put_nowait, "")

    threading.Thread(target=_pump, name="permit-stdin", daemon=True).start()
    return queue


async def _run_console(args: argparse.Namespace) -> int:
    cred_target = None if args.env_only else args.cred_target
    server = PermitServer(
        session_id=args.session_id,
        expected_role=args.role,
        cred_target=cred_target,
        lease_ttl_s=args.lease_ttl,
        renew_interval_s=args.renew_interval,
        on_event=lambda msg: print(msg, flush=True),
    )
    info = await server.start()
    print(f"Bellis Permit Console ready (session={info.session_id}, pid={info.launcher_pid})")
    if cred_target is not None:
        print(f"  CredMan target: {cred_target} (deleted automatically on exit)")
    else:
        print(f"  $env:{ENV_PERMIT_PATH} = '{server.credentials.path}'")
        print(f"  $env:{ENV_PERMIT_KEY} = '{server.credentials.encoded_key}'")
    print("Commands: start | pause | stop | status | quit", flush=True)
    lines = _start_stdin_reader(asyncio.get_running_loop())
    try:
        while line := await lines.get():
            cmd = line.strip().lower()
            if not cmd:
                continue
            try:
                if cmd == "start":
                    print(f"[ok] lease granted (token={await server.grant_start()})", flush=True)
                elif cmd == "pause":
                    print(f"[ok] lease revoked (token={await server.pause()})", flush=True)
                elif cmd == "stop":
                    res = await server.stop_input(through_token=None)
                    print(f"[ok] input.stop sent (release_id={res.release_id})", flush=True)
                elif cmd == "status":
                    print(server.status_summary(), flush=True)
                elif cmd in {"quit", "exit"}:
                    break
                else:
                    print("Unknown command. Use: start | pause | stop | status | quit", flush=True)
            except (ch.ChannelError, ch.RpcError, ProtocolError) as exc:
                print(f"[err] {exc}", flush=True)
    finally:
        await server.close()
        print("Permit console closed and session cleaned up.", flush=True)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Bellis V2 standalone permit control console.")
    parser.add_argument("--cred-target", default=DEFAULT_SESSION_TARGET)
    parser.add_argument("--env-only", action="store_true")
    parser.add_argument("--session-id", default=None)
    parser.add_argument("--role", default=PERMIT_ROLE)
    parser.add_argument("--lease-ttl", type=float, default=DEFAULT_LEASE_TTL_S)
    parser.add_argument("--renew-interval", type=float, default=DEFAULT_RENEW_INTERVAL_S)
    if hasattr(signal, "SIGBREAK"):
        signal.signal(signal.SIGBREAK, signal.default_int_handler)
    try:
        return asyncio.run(_run_console(parser.parse_args(argv)))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
