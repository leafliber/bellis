"""本地 TTS sidecar 的入口，由宿主的 `tts-local` 代理插件拉起：

    python -P -m tts_local --backend fake [假后端选项]
    python -P -m tts_local --backend qwen3 --model 仓库 --model-revision 提交 --speaker 音色 ...

先用 Job Object 管住之后派生的全部进程（R-06），再连接宿主、完成握手；模型在后台加载。
生成卡在 CPU 侧，受 EcoQoS 影响明显（S-05），所以在 Windows 上启动时声明 HighQoS。
"""

from __future__ import annotations

import argparse
import os
import sys
import time

from bellis_sidecar.processes import contain_descendants
from bellis_sidecar.protocol import SidecarHealthResult
from bellis_sidecar.rpc import RpcPeer
from bellis_sidecar.runtime import SidecarOptions, run_sidecar

from .backend import Backend
from .fake import FakeBackend, FakeConfig
from .qwen import QwenBackend, QwenConfig
from .service import TtsService
from .trim import TrimConfig

PROVIDES = ('tts.local@1',)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog='tts_local')
    parser.add_argument('--backend', choices=['fake', 'qwen3'], required=True)
    fake = parser.add_argument_group('fake')
    fake.add_argument('--sample-rate', type=int, default=24_000)
    fake.add_argument('--samples-per-char', type=int, default=4_800)
    fake.add_argument('--chunk-samples', type=int, default=2_400)
    fake.add_argument('--first-chunk-delay-ms', type=int, default=0)
    fake.add_argument('--chunk-delay-ms', type=int, default=0)
    fake.add_argument('--tone-hz', type=float, default=0.0)
    fake.add_argument('--crash-on', action='append', default=[])
    fake.add_argument('--workers', type=int, default=0)
    fake.add_argument('--load-delay-ms', type=int, default=0)
    fake.add_argument('--startup-delay-ms', type=int, default=0)
    fake.add_argument('--load-error', default='')
    fake.add_argument('--aligned', action='store_true')
    qwen = parser.add_argument_group('qwen3')
    qwen.add_argument('--model', default='')
    qwen.add_argument('--model-revision', default='')
    qwen.add_argument('--aligner', default='')
    qwen.add_argument('--aligner-revision', default='')
    qwen.add_argument('--speaker', default='')
    qwen.add_argument('--language', default='chinese')
    qwen.add_argument('--device', default='cuda:0')
    qwen.add_argument('--dtype', default='bfloat16')
    qwen.add_argument('--chunk-ms', type=int, default=100)
    qwen.add_argument('--trim-threshold-dbfs', type=float, default=TrimConfig.threshold_dbfs)
    qwen.add_argument('--trim-margin-ms', type=int, default=TrimConfig.margin_ms)
    qwen.add_argument('--no-trim', action='store_true')
    return parser.parse_args(argv)


def build_backend(args: argparse.Namespace) -> Backend:
    if args.backend == 'qwen3':
        return QwenBackend(
            QwenConfig(
                model=args.model,
                model_revision=args.model_revision,
                speaker=args.speaker,
                language=args.language,
                aligner=args.aligner,
                aligner_revision=args.aligner_revision,
                device=args.device,
                dtype=args.dtype,
                chunk_ms=args.chunk_ms,
                trim=None
                if args.no_trim
                else TrimConfig(
                    threshold_dbfs=args.trim_threshold_dbfs, margin_ms=args.trim_margin_ms
                ),
            )
        )
    return FakeBackend(
        FakeConfig(
            sample_rate=args.sample_rate,
            samples_per_char=args.samples_per_char,
            chunk_samples=args.chunk_samples,
            first_chunk_delay=args.first_chunk_delay_ms / 1000,
            chunk_delay=args.chunk_delay_ms / 1000,
            tone_hz=args.tone_hz,
            crash_on=tuple(args.crash_on),
            workers=args.workers,
            load_delay=args.load_delay_ms / 1000,
            load_error=args.load_error,
            aligned=args.aligned,
        )
    )


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    contain_descendants()
    if args.backend == 'fake' and args.startup_delay_ms > 0:
        # 假后端：连接宿主之前先等一会儿，模拟启动慢的 sidecar。
        time.sleep(args.startup_delay_ms / 1000)
    backend = build_backend(args)
    services: list[TtsService] = []

    def setup(peer: RpcPeer) -> None:
        services.append(TtsService(peer, backend))

    async def health() -> SidecarHealthResult:
        return await services[0].health()

    try:
        return run_sidecar(
            SidecarOptions(provides=PROVIDES, health=health, setup=setup, high_qos=True)
        )
    finally:
        backend.close()


if __name__ == '__main__':
    code = main()
    # 模型加载或推理可能还在守护线程里跑：不做解释器收尾，直接退出（R-06）。
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)
