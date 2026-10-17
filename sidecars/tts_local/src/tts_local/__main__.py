"""本地 TTS sidecar 的入口，由宿主的 `tts-local` 代理插件拉起：

    python -P -m tts_local --backend fake [假后端选项]

先用 Job Object 管住之后派生的全部进程（R-06），再启动后端、连接宿主。
"""

from __future__ import annotations

import argparse
import sys

from bellis_sidecar.processes import contain_descendants
from bellis_sidecar.protocol import SidecarHealthResult
from bellis_sidecar.runtime import SidecarOptions, run_sidecar

from .fake import FakeBackend, FakeConfig
from .service import register

PROVIDES = ('tts@1',)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog='tts_local')
    parser.add_argument('--backend', choices=['fake'], required=True)
    parser.add_argument('--sample-rate', type=int, default=24_000)
    parser.add_argument('--samples-per-char', type=int, default=4_800)
    parser.add_argument('--chunk-samples', type=int, default=2_400)
    parser.add_argument('--first-chunk-delay-ms', type=int, default=0)
    parser.add_argument('--chunk-delay-ms', type=int, default=0)
    parser.add_argument('--tone-hz', type=float, default=0.0)
    parser.add_argument('--crash-on', action='append', default=[])
    parser.add_argument('--workers', type=int, default=0)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    contain_descendants()
    backend = FakeBackend(
        FakeConfig(
            sample_rate=args.sample_rate,
            samples_per_char=args.samples_per_char,
            chunk_samples=args.chunk_samples,
            first_chunk_delay=args.first_chunk_delay_ms / 1000,
            chunk_delay=args.chunk_delay_ms / 1000,
            tone_hz=args.tone_hz,
            crash_on=tuple(args.crash_on),
            workers=args.workers,
        )
    )

    async def health() -> SidecarHealthResult:
        return SidecarHealthResult(ok=True, detail=f'backend={backend.name}')

    try:
        return run_sidecar(
            SidecarOptions(
                provides=PROVIDES, health=health, setup=lambda peer: register(peer, backend)
            )
        )
    finally:
        backend.close()


if __name__ == '__main__':
    sys.exit(main())
