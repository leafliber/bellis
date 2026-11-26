"""Guided Windows 11 + OBS + HSR acceptance. Run from the repository's PowerShell."""

import argparse
import asyncio
import hashlib
import json
import math
import shutil
import signal
import sqlite3
import subprocess
import sys
from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack, closing, suppress
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any
from urllib.parse import parse_qs, urlsplit

import bellis_host as host
from bellis_common import cred
from bellis_common.agent_events import DEFAULT_GAME_LINK_TARGET
from bellis_game.io import find_core_executable
from bellis_game.loop.cli import vlm_config
from bellis_game.perception import load_game_profile, resolve_vlm_api_key
from run_hsr_goal import DEFAULT_GOAL

ROOT = Path(__file__).resolve().parents[1]
TARGETS = (cred.DEFAULT_SESSION_TARGET, DEFAULT_GAME_LINK_TARGET)
BRANCH = (
    "先不要执行任何点击或按键，立即使用 ask_decision 询问观众「接下来怎么安排？」，"
    '选项为 ["留在当前界面", "按 esc 返回大世界"]；等待收到决策后再按所选执行并回报 done。'
    "严禁点击商城、跃迁、充值、设置或任何不可逆按钮。"
)
OBSERVE = (
    "只观察当前崩铁画面处于什么界面，严禁执行任何点击或按键，"
    "直接回报 done 并在 evidence 中简短描述当前画面。"
)
WAIT = "仅使用 wait 等待 4000 毫秒观察画面，不要点击或按键，也不要提前 done。"
type Data = dict[str, Any]


class CheckFailed(Exception):
    """Only locally authored diagnostics may be copied to the report."""


class WaitTimeout(CheckFailed):
    """A verification condition missed its deadline."""


def require(condition: object, message: str) -> None:
    if not condition:
        raise CheckFailed(message)


async def poll[T](
    fn: Callable[[], Awaitable[T]], *, timeout: float, interval: float = 0.1, desc: str
) -> T:
    try:
        async with asyncio.timeout(timeout):
            while not (value := await fn()):
                await asyncio.sleep(interval)
            return value
    except TimeoutError:
        raise WaitTimeout(f"{desc} 超时 ({timeout:g}s)") from None


def sql_has_intent(
    db_path: Path,
    intent_type: str,
    *,
    source: str | None = None,
    state: str = "succeeded",
    after_id: int = 0,
) -> bool:
    with closing(sqlite3.connect(db_path.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        require(db.execute("PRAGMA journal_mode").fetchone() == ("wal",), "数据库未启用 WAL")
        sql = "SELECT 1 FROM intents WHERE id>? AND type=? AND state=? AND (? IS NULL OR source=?)"
        params = (after_id, intent_type, state, source, source)
        return db.execute(sql, params).fetchone() is not None


async def obs_state(obs: host.ObsClient) -> tuple[str, bool]:
    scene, mute = await asyncio.gather(
        obs.request("GetCurrentProgramScene"),
        obs.request("GetInputMute", {"inputName": obs.config.stage_source}),
    )
    return scene.data["currentProgramSceneName"], mute.data["inputMuted"]


async def restore_obs(obs: host.ObsClient, scene: str, unmute: bool = True) -> None:
    await obs.request("SetCurrentProgramScene", {"sceneName": scene})
    if unmute:
        mute = {"inputName": obs.config.stage_source, "inputMuted": False}
        await obs.request("SetInputMute", mute)


class ConsoleClient:
    def __init__(self, port: int):
        self.port, self.cookie, self.csrf = port, "", ""

    async def call(self, path: str = "status", **fields: object) -> Data:
        method = "GET" if path == "status" else "POST"
        body = b"" if method == "GET" else json.dumps(fields, ensure_ascii=False).encode()
        host = f"127.0.0.1:{self.port}"
        head = (
            f"{method} /api/{path} HTTP/1.1\r\nHost: {host}\r\nOrigin: http://{host}\r\n"
            "Content-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\nConnection: close\r\n"
        )
        if self.cookie:
            head += f"Cookie: {self.cookie}\r\nX-Bellis-Csrf: {self.csrf}\r\n"
        async with asyncio.timeout(45):
            reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
            try:
                writer.write((head + "\r\n").encode("ascii") + body)
                await writer.drain()
                raw = await reader.readuntil(b"\r\n\r\n")
                status, *lines = raw.decode("ascii").strip().split("\r\n")
                code = int(status.split()[1])
                require(code == 200, f"{method} /api/{path} · HTTP {code}")
                headers = {k.lower(): v for k, v in (line.split(": ", 1) for line in lines)}
                result: Data = json.loads(await reader.readexactly(int(headers["content-length"])))
                require(method == "GET" or result.get("ok") is True, f"/api/{path} 请求未被接受")
                if path == "login":
                    self.cookie = headers["set-cookie"].split(";", 1)[0]
                    require(self.cookie.startswith("bellis_console="), "缺少操作台会话")
                    self.csrf = result["csrf"]
                elif path == "status":
                    self.csrf = headers["x-bellis-csrf"]
                return result
            finally:
                writer.close()
                await writer.wait_closed()

    async def until(
        self, test: Callable[[Data], bool], timeout: float, desc: str, interval: float = 0.1
    ) -> Data:
        async def check() -> Data:
            status = await self.call()
            return status if test(status) else {}

        return await poll(check, timeout=timeout, interval=interval, desc=desc)


def connections(s: Data) -> tuple[bool, bool]:
    return s["game_permit"]["connected"], s["game_link"]["connected"]


class Verification:
    def __init__(self, args: argparse.Namespace, db: Path):
        self.args, self.db = args, db
        self.stack = AsyncExitStack()
        self.host_pid: int | None = None
        self.logged_in = self.connected = False
        self.evidence: Data = {}

    async def preflight(self) -> None:
        win11 = sys.platform == "win32" and sys.getwindowsversion().build >= 22000
        require(win11, "需要 Windows 11")
        permit, link = TARGETS
        cfg = host.HostConfig(
            permit=host.GamePermitConfig(cred_target=permit),
            game_link=host.GameLinkConfig(cred_target=link),
        )
        if self.args.config:
            cfg = host.HostConfig.from_toml(
                self.args.config, default_permit_cred=permit, default_link_cred=link
            )
        targets = cfg.permit.cred_target, cfg.game_link.cred_target
        require(cfg.enable_obs and targets == TARGETS, "请启用 OBS 并使用默认 CredMan 目标")
        profile = load_game_profile(self.args.profile)
        require(host.resolve_llm_api_key(cfg.director), "缺少 Ark LLM 密钥")
        require(resolve_vlm_api_key(vlm_config(profile, None, None)), "缺少 Ark VLM 密钥")
        require(host.resolve_minimax_api_key(cfg.tts), "缺少 MiniMax TTS 密钥")
        self.evidence["watchdog"] = host.find_watchdog_executable().name
        self.evidence["core"] = find_core_executable(ROOT).name
        self.obs = await self.stack.enter_async_context(host.ObsClient(cfg.obs))
        await self.obs.preflight()
        self.scene, muted = await obs_state(self.obs)
        safe = self.scene == cfg.obs.safe_scene
        self.evidence.update(initial_safe_scene=safe, initial_muted=muted)
        require(not safe and not muted, "请切换到普通 OBS 场景并取消 Stage 静音")

    async def shutdown(self, proc: asyncio.subprocess.Process) -> None:
        try:
            require(proc.returncode is None, "Host 启动器提前退出")
            proc.send_signal(signal.CTRL_BREAK_EVENT)
            require(await asyncio.wait_for(proc.wait(), 30) in (0, 130), "Host 启动器退出码异常")
        finally:
            if proc.returncode is None:
                proc.kill()
                await proc.wait()
            if self.host_pid is not None:
                owners = [cred.read_session_info(target) for target in TARGETS]
                released = all(not info or info.launcher_pid != self.host_pid for info in owners)
                require(released, "Host 退出后仍持有 CredMan 会话")
                self.evidence["credentials_released"] = True

    async def host_launch(self) -> None:
        cli = shutil.which("bellis-host", path=str(ROOT / ".venv/Scripts"))
        cmd = [cli] if cli else [sys.executable, "-m", "bellis_host.app"]
        cmd.extend(["live", "--db", str(self.db)])
        if self.args.config:
            cmd.extend(["--config", str(self.args.config)])
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP
        )
        if not self.args.no_restore_obs:
            self.stack.push_async_callback(restore_obs, self.obs, self.scene)
        self.stack.push_async_callback(self.shutdown, proc)
        assert proc.stdout
        fields: dict[str, str] = {}
        expected = {"Host PID", "Watchdog PID", "Console Login URL"}
        async with asyncio.timeout(30):
            while not expected <= fields.keys():
                raw = await proc.stdout.readline()
                require(raw, "Host 启动失败")
                key, _, value = raw.decode("ascii", "replace").strip().partition(": ")
                if key in expected:
                    fields[key] = value
                if key == "Host PID":
                    self.host_pid = int(value)
        login = urlsplit(fields.pop("Console Login URL"))
        if login.hostname != "127.0.0.1" or login.port is None:
            raise CheckFailed("操作台地址无效")
        self.api = ConsoleClient(login.port)
        await self.api.call("login", token=parse_qs(login.fragment)["token"][0])
        self.logged_in = True
        print("等待 Stage 连接，请确认 OBS 浏览器源已激活。", flush=True)
        status = await self.api.until(lambda s: s["stage_connected"], 20, "OBS 浏览器源")
        require(status["mode"] == "safe_stop", "Host 初始状态应为 safe_stop")
        for target in TARGETS:
            info = cred.read_session_info(target)
            require(info and info.launcher_pid == self.host_pid, "CredMan 会话与 Host PID 不匹配")
        watchdog_pid = int(fields["Watchdog PID"])
        self.evidence.update(host_pid=self.host_pid, watchdog_pid=watchdog_pid, mode="safe_stop")

    async def game_agent_connect(self) -> None:
        profile = str(self.args.profile.resolve()).replace("'", "''")
        hotkey = self.args.emergency_hotkey.replace("'", "''")
        cmd = f"uv run game-agent serve --profile '{profile}' --emergency-hotkey '{hotkey}'"
        print("请在仓库的管理员 PowerShell 中运行：", cmd, sep="\n", flush=True)
        await self.api.until(lambda s: all(connections(s)), self.args.connect_timeout, "双通道连接")
        self.connected = True

    async def live(self) -> None:
        if (await self.api.call())["mode"] != "live":
            await self.api.call("control/live")

    async def arm(self, seconds: int) -> None:
        await self.live()
        if (await self.api.call())["game_permit"]["armed"] is True:
            return
        focus = "HSR 大世界" if seconds == 5 else "HSR"
        print(f"请聚焦 {focus} 并松开键鼠。", flush=True)
        for n in range(seconds, 0, -1):
            print(n, flush=True)
            await asyncio.sleep(1)
        await self.api.call("game/arm")
        require((await self.api.call())["game_permit"]["armed"] is True, "输入未授权")

    async def goal(self, description: str, steps: int, timeout: int) -> str:
        with closing(sqlite3.connect(self.db.as_uri() + "?mode=ro", uri=True)) as db:
            self.cursor = int(db.execute("SELECT coalesce(max(id),0) FROM intents").fetchone()[0])
        fields = dict(description=description, max_steps=steps, timeout_s=timeout)
        return (await self.api.call("game/goal", **fields))["goal_id"]

    def intent(self, name: str, source: str = "operator") -> None:
        found = sql_has_intent(self.db, name, source=source, after_id=self.cursor)
        require(found, f"缺少 {source} {name} 成功记录")

    async def completed(self, timeout: int) -> Data:
        s = await self.api.until(lambda s: not s["game_link"]["active_goal_id"], timeout, "完成")
        link = s["game_link"]
        require(link["connected"] and link["last_outcome"] == "goal_completed", "目标未成功完成")
        self.intent("game.goal_set")
        self.evidence["outcome"] = "goal_completed"
        return s

    async def speech(self, before: list[str], timeout: int, *, optional: bool = False) -> None:
        try:
            s = await self.api.until(lambda s: s["recent_heard"] != before, timeout, "播出")
        except WaitTimeout:
            if not optional:
                raise
            print("警告：未听到目标后续解说。")
            self.evidence["commentary"] = "silent"
            return
        heard: list[str] = s["recent_heard"]
        while before and heard[: len(before)] != before:
            before = before[1:]
        lines = heard[len(before) :]
        print("实际播出", *lines, sep="\n", flush=True)
        # Never persist free-form speech, which may quote arbitrary viewer input.
        digests = [hashlib.sha256(s.encode()).hexdigest() for s in lines]
        self.evidence.setdefault("heard_sha256", []).extend(digests)

    async def observe(self) -> None:
        await self.live()
        status = await self.api.call()
        require(status["game_permit"]["armed"] is False, "只读验收需要未授权输入")
        greeting = "贝莉你好呀，先别操作游戏，跟大家打个招呼吧！"
        viewer = dict(viewer_id="verify-greet", viewer_name="测试观众")
        await self.api.call("danmaku", text=greeting, **viewer)
        await self.speech(status["recent_heard"], 30)
        before = (await self.api.call())["recent_heard"]
        await self.goal(OBSERVE, 3, 45)
        done = await self.completed(50)
        require(done["game_permit"]["armed"] is False, "只读目标意外获得输入许可")
        await self.speech(before, 20, optional=True)

    async def pacing(self) -> None:
        await self.arm(5)
        before = (await self.api.call())["recent_heard"]
        goal = await self.goal(DEFAULT_GOAL, 8, 90)
        await asyncio.sleep(1.2)
        active = (await self.api.call())["game_link"]["active_goal_id"] == goal
        if active:
            for action, paused in (("pause", True), ("resume", False)):
                await self.api.call(f"game/{action}")
                link = (await self.api.call())["game_link"]
                require(link["paused"] is paused, f"节奏 {action} 失败")
                self.intent(f"game.pacing_{action}")
                if paused:
                    await asyncio.sleep(1.2)
        self.evidence["pacing_exercised"] = active
        await self.completed(95)
        await self.speech(before, 25, optional=True)

    async def decision(self, vote: bool) -> None:
        await self.arm(3)
        goal = await self.goal(BRANCH, 6, 60)

        def ready(s: Data) -> bool:
            link = s["game_link"]
            return bool(link["pending_decision"]) or link["active_goal_id"] != goal

        s = await self.api.until(ready, 45, "决策", 0.05)
        link = s["game_link"]
        if not (pending := link["pending_decision"]):
            self.evidence["error"] = "目标提前结束"
            outcome = link["last_outcome"]
            raise CheckFailed(f"目标提前结束 ({outcome}: {link['last_outcome_detail']})")
        options = list(pending["options"])
        require(pending["goal_id"] == goal and len(options) >= 2, "决策点不匹配")
        if vote:
            if s["active_vote"] is None:
                question = pending["question"]
                await self.api.call("vote/start", question=question, options=options, duration_s=15)
            else:
                require(len(s["active_vote"]["options"]) >= 2, "投票缺少第二项")
            for voter in ("voter-1", "voter-2"):
                await self.api.call("danmaku", viewer_id=voter, viewer_name=voter, text="2")
            await self.api.until(lambda s: s["active_vote"]["counts"][1] >= 2, 15, "两票")
            closed = (await self.api.call("vote/close"))["vote"]
            require(closed["winners"] == [1], "第二项未胜出")
            self.evidence["counts"] = closed["counts"]
        else:
            choice = dict(chosen_index=0, reason="operator_verify")
            await self.api.call("game/decision", decision_id=pending["decision_id"], **choice)
        done = await self.completed(70 if vote else 60)
        require(done["game_link"]["pending_decision"] is None, "仍有未解决决策")
        self.intent("game.decision_resolved", "agent" if vote else "operator")

    async def release(self, stage: str) -> None:
        hotkey = stage == "7b"
        if hotkey:
            await restore_obs(self.obs, self.scene)
            if (await self.api.call())["mode"] == "emergency_stop":
                await self.api.call("control/clear-emergency")
        await self.arm(2 if stage == "6" else 3)
        goal = await self.goal(WAIT, 4, 30)
        active = await self.api.until(lambda s: s["game_link"]["active_goal_id"] == goal, 5, "启动")
        prior_release = active["game_permit"]["last_release_id"]
        if stage == "6":
            print(">>> 请立即晃动鼠标或按一下方向键触发真人接管！ <<<", flush=True)
        elif hotkey:
            print(f">>> 请立即按下急停热键 {self.args.emergency_hotkey}！ <<<", flush=True)
        else:
            await self.api.call("control/emergency")

        async def released() -> bool:
            s = await self.api.call()
            permit = s["game_permit"]
            if not all(connections(s)) or permit["armed"] is not False:
                return False
            if stage != "7a":
                reason = "takeover" if stage == "6" else "emergency_stop"
                release = permit["last_release_reason"], permit["last_release_verification"]
                if release != (reason, "verified") or permit["last_release_id"] == prior_release:
                    return False
            if stage == "6":
                return s["mode"] == "live" and await obs_state(self.obs) == (self.scene, False)
            stopped = s["mode"] == "emergency_stop" and s["game_link"]["active_goal_id"] is None
            return stopped and await obs_state(self.obs) == (self.obs.config.safe_scene, True)

        await poll(released, timeout=10 if stage == "7a" else 35, desc="输入释放与 OBS 状态")
        self.evidence.update(armed=False, safe_scene=stage != "6", stage_muted=stage != "6")
        if stage != "7a":
            self.evidence["verified_release"] = "takeover" if stage == "6" else "emergency_stop"
        if stage == "6":
            await self.speech(active["recent_heard"], 25, optional=True)

    async def cleanup(self, failed: bool) -> None:
        try:
            if not self.logged_in:
                return
            status = await self.api.call()
            if failed and status["mode"] == "live":
                with suppress(Exception):
                    await self.api.call("control/pause")
            if not failed:
                require(all(connections(status)), "热拔出前通道已断开")
            if any(connections(status)):
                print("请在管理员 game-agent serve 窗口按 Ctrl+C，等待两条通道断开。", flush=True)
                await self.api.until(lambda s: not any(connections(s)), 60, "双通道断开")
                await self.api.call()
                self.evidence["host_survived"] = self.connected
        finally:
            await self.stack.aclose()


async def run(args: argparse.Namespace, db: Path, report: Path) -> int:
    v = Verification(args, db)
    code = 0
    stages = (
        ("0", "preflight", v.preflight),
        ("1", "host_launch", v.host_launch),
        ("2", "game_agent_connect", v.game_agent_connect),
        ("3", "readonly_observe", v.observe),
        ("4", "armed_goal_and_pacing", v.pacing),
        ("5a", "operator_decision", lambda: v.decision(False)),
        ("5b", "vote_decision", lambda: v.decision(True)),
        ("6", "takeover", lambda: v.release("6")),
        ("7a", "console_emergency", lambda: v.release("7a")),
        ("7b", "hotkey_emergency", lambda: v.release("7b")),
        ("8", "hot_unplug_and_cleanup", lambda: v.cleanup(bool(code))),
    )
    results: dict[str, str] = {}
    try:
        for key, name, action in stages:
            v.evidence = {}
            result = "PASS"
            try:
                if key not in args.selected:
                    result = "SKIP"
                elif code and key != "8":
                    result = "PENDING"
                else:
                    print(f"[{key}] {name}", flush=True)
                    await action()
                    if key == "8" and not v.connected:
                        result = "PENDING"
            except (asyncio.CancelledError, KeyboardInterrupt):
                code, result = 130, "PENDING"
            except Exception as exc:
                code, result = code or 1, "FAIL"
                reason = str(exc) if isinstance(exc, CheckFailed) else type(exc).__name__
                v.evidence.setdefault("error", reason)
                print(f"{name} · {reason}", file=sys.stderr)
            results[name] = result
            with report.open("a", encoding="utf-8", newline="\n") as stream:
                now = datetime.now().astimezone().isoformat()
                row = dict(timestamp=now, stage=name, status=result, evidence=v.evidence)
                print(json.dumps(row, ensure_ascii=False), file=stream, flush=True)
    finally:
        await v.stack.aclose()
    for name, status in results.items():
        print(f"{name:24} {status}")
    print(f"报告 {report}")
    return code


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--profile", type=Path, default=ROOT / "games/hsr.toml")
    parser.add_argument("--only", help="3,4,5a,5b,6,7a,7b")
    parser.add_argument("--skip-hotkey", action="store_true")
    parser.add_argument("--emergency-hotkey", default="ctrl+shift+f12")
    parser.add_argument("--connect-timeout", type=float, default=180.0)
    parser.add_argument("--no-restore-obs", action="store_true")
    args = parser.parse_args()
    fixed = {"0", "1", "2", "8"}
    choices = {"3", "4", "5a", "5b", "6", "7a", "7b"}
    selected = choices if args.only is None else {s.strip() for s in str(args.only).split(",")}
    if selected - choices or not 0 < args.connect_timeout < math.inf:
        parser.error("请检查 --only 阶段列表与 --connect-timeout 正数秒数")
    args.selected = (selected | fixed) - ({"7b"} if args.skip_hotkey else set())
    report = ROOT / "reports" / f"dual-agent-hsr-{datetime.now():%Y%m%d-%H%M%S-%f}.jsonl"
    report.parent.mkdir(exist_ok=True)
    with TemporaryDirectory(prefix="bellis-dual-agent-") as directory:
        return asyncio.run(run(args, Path(directory) / "host.db", report))


if __name__ == "__main__":
    raise SystemExit(main())
