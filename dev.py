"""Bellis 开发启动器 — 同时启动后端 WebSocket 服务和前端 Vite 开发服务器。"""

import subprocess
import sys
import os
import signal
import threading

# 项目根目录
ROOT = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = ROOT
FRONTEND_DIR = os.path.join(ROOT, "bellis-web")

processes: list[subprocess.Popen] = []


def start_backend():
    """启动后端：uv run python -m bellis"""
    proc = subprocess.Popen(
        ["uv", "run", "python", "-m", "bellis"],
        cwd=BACKEND_DIR,
        shell=True,
    )
    processes.append(proc)
    return proc


def start_frontend():
    """启动前端：npm run dev"""
    proc = subprocess.Popen(
        ["npm", "run", "dev"],
        cwd=FRONTEND_DIR,
        shell=True,
    )
    processes.append(proc)
    return proc


def shutdown(signum=None, frame=None):
    """优雅关闭所有子进程。"""
    print("\n正在关闭所有服务...")
    for proc in processes:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
    print("所有服务已停止。")
    sys.exit(0)


def main():
    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    print("=" * 60)
    print("  Bellis 开发模式启动器")
    print("  后端: ws://localhost:8765")
    print("  前端: http://localhost:5173")
    print("  按 Ctrl+C 停止所有服务")
    print("=" * 60)

    # 启动后端
    print("\n[后端] 正在启动...")
    backend_proc = start_backend()

    # 启动前端
    print("[前端] 正在启动...")
    frontend_proc = start_frontend()

    # 等待任一进程退出
    try:
        while True:
            for proc in processes:
                ret = proc.poll()
                if ret is not None:
                    print(f"进程 {proc.args} 已退出 (code={ret})")
                    shutdown()
            threading.Event().wait(1)
    except KeyboardInterrupt:
        shutdown()


if __name__ == "__main__":
    main()
