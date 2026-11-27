"""Host composition and Windows live process launcher."""

import argparse
import asyncio
import logging
import os
import signal
import subprocess
import sys
import tempfile
import tomllib
from contextlib import AsyncExitStack, suppress
from contextvars import ContextVar
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Self

from bellis_common.agent_events import DEFAULT_GAME_LINK_TARGET, FastEvent
from bellis_common.cred import (
    DEFAULT_SESSION_TARGET,
    CredError,
    delete_session_info,
    read_session_info,
)
from bellis_common.telemetry import JsonlTelemetry

from . import watchdog
from .audience import AudienceHub
from .console import ConsoleConfig, ConsoleServer
from .director import DirectorConfig, LlmStreamer, OpenAiLlmClient, SlowDirector
from .game_control import GameController
from .game_link import GameLinkConfig, HostGameLink
from .game_permit import GamePermitConfig, HostGamePermit
from .obs import ObsClient, ObsConfig, ObsError, resolve_obs_password
from .safety import EmergencySummary, SafetyConfig, SafetyCore
from .speech import SpeechArbiter, TtsSynthesizer
from .stage import StageConfig, StageServer
from .store import HostStore
from .tts import MinimaxConfig, MiniMaxTtsClient


@dataclass(frozen=True)
class HostConfig:
    db_path: Path = field(default_factory=lambda: Path(
        os.getenv("LOCALAPPDATA") or tempfile.gettempdir(), "Bellis/host.sqlite3"
    ))  # fmt: skip
    telemetry_path: Path | None = None
    obs: ObsConfig = ObsConfig()
    enable_obs: bool = True
    stage: StageConfig = StageConfig(port=18765)
    console: ConsoleConfig = ConsoleConfig(port=18766)
    tts: MinimaxConfig = MinimaxConfig()
    director: DirectorConfig = DirectorConfig()
    watchdog_heartbeat_s: float = 0.25
    watchdog_timeout_ms: int = 1000
    enable_watchdog: bool = True
    permit: GamePermitConfig = GamePermitConfig()
    game_link: GameLinkConfig = GameLinkConfig()

    @classmethod
    def from_toml(
        cls,
        path: Path,
        *,
        default_permit_cred: str | None = None,
        default_link_cred: str | None = None,
    ) -> Self:
        with path.open("rb") as stream:
            values = tomllib.load(stream)
        defaults = cls()
        for section, fallback in (
            ("permit", default_permit_cred),
            ("game_link", default_link_cred),
        ):
            options = values.pop(section, {})
            target = options.pop("cred_target", fallback)
            values[section] = replace(
                getattr(defaults, section), cred_target=None if target == "" else target, **options
            )
        for key in ("db_path", "telemetry_path"):
            if key in values:
                values[key] = path.parent / values[key]
        for key in ("obs", "stage", "console", "tts", "director"):
            if key in values:
                options = values[key]
                if "static_dir" in options:
                    options["static_dir"] = path.parent / options["static_dir"]
                if "cred_targets" in options:
                    options["cred_targets"] = tuple(options["cred_targets"])
                values[key] = replace(getattr(defaults, key), **options)
        cfg = cls(**values)
        switches = cfg.enable_obs, cfg.enable_watchdog, cfg.obs.stop_stream
        if any(type(value) is not bool for value in switches):
            raise ValueError("Host and OBS switches require TOML booleans")
        return cfg


@dataclass(frozen=True)
class StartInfo:
    console_login_url: str
    stage_url: str
    console_port: int
    stage_port: int


# EmergencySummary carries the free-form reason. Preserve the actual source
# through the synchronous safety notification, including calls on other threads.
_source = ContextVar("emergency_source", default="host")


class _HostSafety(SafetyCore):
    def trigger_emergency(self, reason: str, *, source: str = "operator") -> EmergencySummary:
        token = _source.set(source)
        try:
            return super().trigger_emergency(reason, source=source)
        finally:
            _source.reset(token)


class HostApp:
    def __init__(
        self,
        config: HostConfig,
        *,
        tts: TtsSynthesizer | None = None,
        llm: LlmStreamer | None = None,
    ):
        self.config, self._stack = config, AsyncExitStack()
        self._tts, self._llm = tts, llm
        self._lock = asyncio.Lock()
        self._info: StartInfo | None = None
        self._closed = False
        self._emergency: asyncio.Task[None] | None = None
        self._refresh: asyncio.Task[None] | None = None

    def _wire(self) -> None:
        cfg, stack = self.config, self._stack
        self.store = stack.enter_context(HostStore(cfg.db_path))
        telemetry = None
        if cfg.telemetry_path:
            telemetry = stack.enter_context(JsonlTelemetry(cfg.telemetry_path))
        ttls = {**SafetyConfig().lease_ttl_s, "game.input": cfg.permit.lease_ttl_s}
        self.safety = _HostSafety(
            self.store, config=SafetyConfig(lease_ttl_s=ttls), telemetry=telemetry
        )
        stack.callback(self.safety.close)
        self.watchdog = None
        if cfg.enable_watchdog:
            self.watchdog = watchdog.WatchdogLink(
                self.safety,
                credentials=watchdog.credentials_from_env(),
                heartbeat_interval_s=cfg.watchdog_heartbeat_s,
            )
            stack.push_async_callback(self.watchdog.close, planned=True)
        self.obs = None
        if cfg.enable_obs:
            self.obs = ObsClient(cfg.obs, on_external_emergency=self.safety.reconcile_obs_external)
            stack.push_async_callback(self.obs.close)
            stack.push_async_callback(self._drain_obs)
            loop = asyncio.get_running_loop()

            def emergency(_: EmergencySummary) -> None:
                if not self._closed and _source.get() not in {"watchdog", "obs"}:
                    loop.call_soon_threadsafe(self._schedule_emergency)

            stack.callback(self.safety.on_emergency(emergency))
        voice = self._tts if self._tts is not None else MiniMaxTtsClient(cfg.tts)
        if close := getattr(voice, "close", None):
            stack.push_async_callback(close)
        self.stage = StageServer(self.safety, cfg.stage, on_reauth_needed=self._reauth)
        stack.push_async_callback(self.stage.close)
        self.speech = SpeechArbiter(self.safety, self.store, self.stage, voice)
        stack.push_async_callback(self.speech.close)
        self.audience = AudienceHub(self.safety, self.store)
        model = self._llm
        if model is None:
            model = OpenAiLlmClient(cfg.director)
            stack.push_async_callback(model.close)
        self.game_permit = HostGamePermit(
            self.safety, cfg.permit, on_auto_resumed=self._on_permit_auto_resumed
        )
        stack.push_async_callback(self.game_permit.close)
        self.game_link = HostGameLink(cfg.game_link, on_event=self._on_game_event)
        stack.push_async_callback(self.game_link.close)
        self.game = GameController(
            self.safety, self.store, self.game_link, permit_armed=lambda: self.game_permit.armed
        )
        stack.push_async_callback(self.game.close)
        self.director = SlowDirector(
            self.safety, self.audience, self.speech, model, config=cfg.director, game=self.game
        )
        stack.push_async_callback(self.director.close)
        self.console = ConsoleServer(
            self.safety,
            director=self.director,
            game_permit=self.game_permit,
            game=self.game,
            config=cfg.console,
            on_emergency_obs=self._console_emergency if self.obs else None,
        )
        stack.push_async_callback(self.console.close)

    def _on_game_event(self, event: FastEvent) -> None:
        self.director.submit_game_event(event)

    def _on_permit_auto_resumed(self) -> None:
        if (queued := self.game.take_queued_goal()) is not None:
            self.game.dispatch_queued(queued)
            return
        if self.game.resume_objective_after_takeover():
            self.director.notify_objective_resumed()

    async def _obs_action(self, refresh: bool = False) -> None:
        assert self.obs
        if refresh:
            await self.obs.set_stage_url(self.stage.issue_stage_url())
        elif not (await self.obs.run_emergency()).ok:
            raise ObsError("OBS emergency batch failed")

    def _reauth(self) -> None:
        if self.obs and not self._closed and (not self._refresh or self._refresh.done()):
            self._refresh = asyncio.create_task(self._obs_action(refresh=True))
            self._refresh.add_done_callback(_observe)

    def _schedule_emergency(self) -> None:
        if not self._emergency or self._emergency.done():
            self._emergency = asyncio.create_task(self._obs_action())
            self._emergency.add_done_callback(_observe)

    async def _console_emergency(self) -> None:
        self._schedule_emergency()
        if self._emergency:
            await asyncio.shield(self._emergency)

    async def _drain_obs(self) -> None:
        await asyncio.sleep(0)  # Admit already queued thread-safe emergency callbacks.
        await asyncio.gather(
            *(t for t in (self._refresh, self._emergency) if t), return_exceptions=True
        )

    async def start(self) -> StartInfo:
        async with self._lock:
            if self._closed:
                raise RuntimeError("Host is closed")
            if self._info:
                return self._info
            try:
                self._wire()
                self.game.start()
                await self.game_link.start()
                await self.game_permit.start()
                if self.obs:
                    await self.obs.connect()
                    await self.obs.preflight()
                await self.stage.start()
                url = self.stage.issue_stage_url()
                if self.obs:
                    await self.obs.set_stage_url(url)
                if self.watchdog:
                    await self.watchdog.start()
                    if os.getenv("BELLIS_LAUNCHER_STDIN") == "1":
                        await self.watchdog.wait_connected(10)
                await self.director.start()
                await self.console.start()
                self._info = StartInfo(
                    self.console.issue_login_url(), url, self.console.port, self.stage.port
                )
                return self._info
            except BaseException:
                self._closed = True
                await self._stack.aclose()
                raise

    async def close(self) -> None:
        async with self._lock:
            self._closed = True
            await self._stack.aclose()

    quiesce = close


def _observe(task: asyncio.Task[None]) -> None:
    if not task.cancelled() and (error := task.exception()):
        logging.error("Host OBS request failed (%s)", type(error).__name__)


async def _serve(cfg: HostConfig) -> int:
    app = HostApp(cfg)
    try:
        info = await app.start()
        managed = os.getenv("BELLIS_LAUNCHER_STDIN") == "1"
        if not managed:
            print(f"Host PID: {os.getpid()}", flush=True)
        print(f"Stage URL: {info.stage_url}", flush=True)
        print(f"Console Login URL: {info.console_login_url}", flush=True)
        if managed:
            await asyncio.to_thread(sys.stdin.buffer.read, 1)
        else:
            await asyncio.Event().wait()
    finally:
        await app.close()
    return 0


def _finish(proc: subprocess.Popen[bytes], timeout: float) -> int:
    try:
        return proc.wait(timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        return proc.wait()


def _cleanup_host_cred(target: str, host_pid: int) -> None:
    with suppress(CredError):
        info = read_session_info(target)
        if info is not None and info.launcher_pid == host_pid:
            delete_session_info(target)


def _live(cfg: HostConfig, args: argparse.Namespace) -> int:
    cred = watchdog.new_credentials()
    env = os.environ.copy()
    env.update(BELLIS_CHANNEL_PATH=cred.path, BELLIS_CHANNEL_KEY=cred.encoded_key)
    obs = cfg.obs
    command = [
        str(watchdog.find_watchdog_executable()), "--obs-url", obs.url,
        "--stage-source", obs.stage_source, "--safe-scene", obs.safe_scene,
        "--heartbeat-timeout-ms", str(cfg.watchdog_timeout_ms), "--exit-on-stop", "--once",
    ]  # fmt: skip
    if obs.stop_stream:
        command.append("--stop-stream")
    options = [f"--db={cfg.db_path}", f"--console-port={cfg.console.port}",
               f"--stage-port={cfg.stage.port}"]  # fmt: skip
    target = cfg.permit.cred_target
    options.append(f"--permit-cred={target}" if target else "--no-permit-cred")
    link_target = cfg.game_link.cred_target
    options.append(f"--link-cred={link_target}" if link_target else "--no-link-cred")
    if args.config:
        options.append(f"--config={args.config}")
    if not cfg.enable_obs:
        options.append("--no-obs")
    group = subprocess.CREATE_NEW_PROCESS_GROUP
    wd_env = {**env, watchdog.ENV_OBS_PASSWORD: resolve_obs_password(obs)}
    wd = subprocess.Popen(command, env=wd_env, creationflags=group)
    try:
        # Use CPython's Windows venv handoff so the Host PID owns the interpreter,
        # even when bellis-host live is itself launched via __PYVENV_LAUNCHER__.
        base_py = Path(sys.base_prefix) / "python.exe"
        host_exe = (
            str(base_py)
            if sys.platform == "win32" and base_py.is_file()
            else getattr(sys, "_base_executable", sys.executable)
        )
        host = subprocess.Popen(
            [sys.executable, "-m", "bellis_host.app", "serve", *options],
            executable=host_exe,
            stdin=subprocess.PIPE,
            env={**env, "__PYVENV_LAUNCHER__": sys.executable, "BELLIS_LAUNCHER_STDIN": "1"},
            creationflags=group,
        )
        try:
            print(f"Watchdog PID: {wd.pid}\nHost PID: {host.pid}", flush=True)
            while wd.poll() is None:
                with suppress(subprocess.TimeoutExpired):
                    return host.wait(0.2)
        finally:
            assert host.stdin
            host.stdin.close()
            status = _finish(host, 10)
            if target:
                _cleanup_host_cred(target, host.pid)
            if link_target:
                _cleanup_host_cred(link_target, host.pid)
        return status or wd.returncode
    finally:
        _finish(wd, 15)  # Allow the Rust peer to finish its OBS batch after Host loss.


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="bellis-host")
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("serve", "live"):
        sub = commands.add_parser(name)
        sub.add_argument("--config", type=Path)
        sub.add_argument("--permit-cred")
        sub.add_argument("--no-permit-cred", action="store_true")
        sub.add_argument("--link-cred")
        sub.add_argument("--no-link-cred", action="store_true")
        sub.add_argument("--db", type=Path)
        sub.add_argument("--no-obs", action="store_true")
        sub.add_argument("--console-port", type=int)
        sub.add_argument("--stage-port", type=int)
        if name == "serve":
            sub.add_argument("--no-watchdog", action="store_true")
        else:
            sub.add_argument("--watchdog-timeout-ms", type=int)
    args = parser.parse_args(argv)
    try:
        cfg = (
            HostConfig.from_toml(
                args.config,
                default_permit_cred=DEFAULT_SESSION_TARGET,
                default_link_cred=DEFAULT_GAME_LINK_TARGET,
            )
            if args.config
            else HostConfig(
                permit=GamePermitConfig(cred_target=DEFAULT_SESSION_TARGET),
                game_link=GameLinkConfig(cred_target=DEFAULT_GAME_LINK_TARGET),
            )
        )
        if args.no_permit_cred or args.permit_cred is not None:
            target = None if args.no_permit_cred else args.permit_cred or None
            cfg = replace(cfg, permit=replace(cfg.permit, cred_target=target))
        if args.no_link_cred or args.link_cred is not None:
            target = None if args.no_link_cred else args.link_cred or None
            cfg = replace(cfg, game_link=replace(cfg.game_link, cred_target=target))
        cfg = replace(
            cfg, db_path=args.db or cfg.db_path, enable_obs=cfg.enable_obs and not args.no_obs
        )
        if args.console_port is not None:
            cfg = replace(cfg, console=replace(cfg.console, port=args.console_port))
        if args.stage_port is not None:
            cfg = replace(cfg, stage=replace(cfg.stage, port=args.stage_port))
        if args.command == "serve":
            enabled = cfg.enable_watchdog or os.getenv("BELLIS_LAUNCHER_STDIN") == "1"
            cfg = replace(cfg, enable_watchdog=enabled and not args.no_watchdog)
            return asyncio.run(_serve(cfg))
        if args.watchdog_timeout_ms is not None:
            cfg = replace(cfg, watchdog_timeout_ms=args.watchdog_timeout_ms)
        signal.signal(signal.SIGBREAK, signal.default_int_handler)
        return _live(cfg, args)
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
