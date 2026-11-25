"""Guided Windows 11 + OBS acceptance. Run with the workspace Python from a console."""

import _winapi
import argparse
import asyncio
import json
import shutil
import signal
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory

from bellis_host import (
    HostConfig,
    ObsClient,
    find_watchdog_executable,
    resolve_llm_api_key,
    resolve_minimax_api_key,
)

ROOT = Path(__file__).resolve().parents[1]


async def confirm(instruction: str) -> None:
    print(instruction, flush=True)
    answer = await asyncio.to_thread(input, "确认观察到上述结果？[y/N] ")
    if answer.strip().lower() != "y":
        raise RuntimeError("操作员未确认")


async def obs_state(obs: ObsClient) -> tuple[str, bool]:
    scene, mute = await asyncio.gather(
        obs.request("GetCurrentProgramScene"),
        obs.request("GetInputMute", {"inputName": obs.config.stage_source}),
    )
    return scene.data["currentProgramSceneName"], mute.data["inputMuted"]


async def run(config: Path | None, report: Path, work: Path) -> int:
    check = "preflight"
    launcher = None
    host_handle = None

    def record(status: str, **details: object) -> None:
        row = dict(
            time=datetime.now().astimezone().isoformat(), check=check, status=status, **details
        )
        with report.open("a", encoding="utf-8", newline="\n") as stream:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")

    try:
        if sys.platform != "win32" or sys.getwindowsversion().build < 22000:
            raise RuntimeError("需要 Windows 11")
        cfg = HostConfig.from_toml(config) if config else HostConfig()
        if not cfg.enable_obs or cfg.director.model != "deepseek-v4.1-flash":
            raise RuntimeError("验收配置需要启用 OBS 并使用 deepseek-v4.1-flash")
        if not resolve_llm_api_key(cfg.director):
            raise RuntimeError("未找到慢主 Agent 的 API 密钥")
        if not resolve_minimax_api_key(cfg.tts):
            raise RuntimeError("未找到 MiniMax TTS 的 API 密钥")
        watchdog = find_watchdog_executable()
        async with ObsClient(cfg.obs) as obs:
            await obs.preflight()
            record(
                "PASS",
                watchdog=watchdog.name,
                model=cfg.director.model,
                safe_scene=cfg.obs.safe_scene,
                stage_source=cfg.obs.stage_source,
            )
            check = "launcher"
            cli = shutil.which("bellis-host", path=str(Path(sys.executable).parent))
            command = [cli] if cli else [sys.executable, "-m", "bellis_host.app"]
            launcher = await asyncio.create_subprocess_exec(
                *command,
                "live",
                "--db",
                str(work / "verify.db"),
                *(["--config", str(config)] if config else []),
                stdout=asyncio.subprocess.PIPE,
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
            )
            fields = {}
            async with asyncio.timeout(30):
                while "Console Login URL" not in fields:
                    raw = await launcher.stdout.readline()
                    if not raw:
                        raise RuntimeError("Host 启动失败")
                    name, _, value = raw.decode("ascii").strip().partition(": ")
                    fields[name] = value
            host_pid = int(fields["Host PID"])
            watchdog_pid = int(fields["Watchdog PID"])
            # Hold the process object across the manual checks, even if its PID exits.
            synchronize_and_terminate = 0x00100000 | 0x00000001
            host_handle = _winapi.OpenProcess(synchronize_and_terminate, False, host_pid)
            record("PASS", host_pid=host_pid, watchdog_pid=watchdog_pid)
            print(f"Host PID {host_pid}，Watchdog PID {watchdog_pid}")
            print(f"在浏览器打开一次性操作台链接 {fields['Console Login URL']}")
            check = "danmaku_speech"
            await confirm(
                f"在 OBS 切到包含「{cfg.obs.stage_source}」的普通场景并取消静音。"
                "确认操作台显示「已暂停」、Stage 已连接。点「开始直播」，发送一条测试弹幕，"
                "例如“请用一句话欢迎我”。听到回复、看到同步字幕，并在「最近实际播出」看到回复。"
            )
            record("PASS", evidence="operator")
            check = "interrupt"
            await confirm(
                "手动播报一段长文本，播放中点「打断发声」。确认声音立即中断且剩余文本未播出。"
            )
            record("PASS", evidence="operator")
            check = "console_control"
            await confirm(
                "点「暂停直播」恢复初态，然后依次点「开始直播」「暂停直播」「开始直播」。"
                "观察到「已暂停 → 直播中 → 已暂停 → 直播中」。"
            )
            record("PASS", evidence="operator")
            check = "obs_hotkey"
            await confirm(
                f"在 OBS 用热键切到「{cfg.obs.safe_scene}」或静音「{cfg.obs.stage_source}」。"
                "确认操作台显示「紧急停止」并给出 obs_external 原因。"
            )
            record("PASS", evidence="operator")
            check = "watchdog_fallback"
            await confirm(
                f"恢复普通场景并取消 Stage 静音，在操作台解除急停并开始直播。"
                f"输入 y 将强制结束本次 Host（PID {host_pid}）。"
            )
            before = await obs_state(obs)
            if before[0] == cfg.obs.safe_scene or before[1] or launcher.returncode is not None:
                raise RuntimeError("需要运行中的 Host、非安全场景与未静音的 Stage")
            if _winapi.WaitForSingleObject(host_handle, 0) != _winapi.WAIT_TIMEOUT:
                raise RuntimeError("本次 Host 已退出")
            _winapi.TerminateProcess(host_handle, 77)
            async with asyncio.timeout(10):
                while (after := await obs_state(obs)) != (cfg.obs.safe_scene, True):
                    await asyncio.sleep(0.1)
            if await asyncio.wait_for(launcher.wait(), 20) != 77:
                raise RuntimeError("启动器未确认本次 Host 的强制退出")
            record("PASS", evidence="OBS WebSocket", before=before, after=after)
            return 0
    except (KeyboardInterrupt, asyncio.CancelledError, EOFError):
        record("PENDING", reason="操作员中止")
        return 130
    except Exception as error:
        print(f"{check} 验收失败：{error}", file=sys.stderr)
        record("FAIL", error=type(error).__name__)
        return 1
    finally:
        if host_handle is not None:
            _winapi.CloseHandle(host_handle)
        if launcher and launcher.returncode is None:
            launcher.send_signal(signal.CTRL_BREAK_EVENT)
            await asyncio.wait_for(launcher.wait(), 30)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path)
    args = parser.parse_args()
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    report = ROOT / "reports" / f"live-verify-{stamp}.jsonl"
    report.parent.mkdir(exist_ok=True)
    print(f"本次验收报告 {report}")
    with TemporaryDirectory(prefix="bellis-verify-") as directory:
        return asyncio.run(run(args.config, report, Path(directory)))


if __name__ == "__main__":
    raise SystemExit(main())
