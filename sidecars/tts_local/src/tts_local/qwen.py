"""Qwen3-TTS 后端（R-10）与 Qwen3-ForcedAligner 强制对齐（R-11）。

依赖在根 pyproject 的 `tts-local` 组里，只在 Windows 真机安装（R-24）；三平台 CI 不装，
所以这里按名动态导入，类型检查与测试都不需要它们。模型权重放在仓库外的 Hugging Face 缓存，
按提交固定版本；运行时只读本地缓存，不联网下载（宿主还会设 HF_HUB_OFFLINE）。

- qwen-tts 0.1.1 不提供流式生成：一句整段生成后再按块送出，首包时间就是这一句的生成时间。
- 它也不把停止条件传给生成循环：取消时立即停止送出音频，但 GPU 上的这一句会生成完，
  下一句等它结束。
- 注意力用 PyTorch SDPA，不用 FlashAttention（R-24）。生成与对齐共用一把锁，同一时刻只有一个用 GPU。
- 整句生成后先修剪句首句尾近乎无声的部分（见 `trim`），再送出与对齐：
  送出的、对齐的与应答里的总采样数都是修剪后的，时间戳相对修剪后的开头。
"""

from __future__ import annotations

import asyncio
import importlib
import threading
from collections.abc import AsyncGenerator
from dataclasses import dataclass, field
from typing import Any

from bellis_sidecar.runtime import run_blocking

from .backend import Loaded, Stamp
from .trim import TrimConfig, trim_silence


@dataclass(frozen=True)
class QwenConfig:
    #: Hugging Face 上的模型仓库与固定的提交。
    model: str
    model_revision: str
    speaker: str
    #: qwen-tts 的语言名，例如 `chinese`；对齐用同一语言。
    language: str
    #: 空串表示不做强制对齐（只用插值）。
    aligner: str = ''
    aligner_revision: str = ''
    device: str = 'cuda:0'
    dtype: str = 'bfloat16'
    #: 送出音频的块长。
    chunk_ms: int = 100
    #: 修剪句首句尾近乎无声的部分；None 表示不修剪。
    trim: TrimConfig | None = field(default_factory=TrimConfig)


def _module(name: str) -> Any:
    return importlib.import_module(name)


class QwenBackend:
    name = 'qwen3'

    def __init__(self, config: QwenConfig) -> None:
        self.config = config
        self._gpu = threading.Lock()
        self._tts: Any = None
        self._aligner: Any = None
        self._sample_rate = 0

    def processes(self) -> list[int]:
        return []

    def _snapshot(self, repo: str, revision: str) -> str:
        hub = _module('huggingface_hub')
        try:
            return str(hub.snapshot_download(repo, revision=revision, local_files_only=True))
        except Exception as error:
            raise RuntimeError(f'本地缓存里没有 {repo}@{revision[:7]}，先下载模型权重') from error

    def load(self) -> Loaded:
        torch = _module('torch')
        config = self.config
        if config.device.startswith('cuda') and not torch.cuda.is_available():
            raise RuntimeError('CUDA 不可用')
        dtype = getattr(torch, config.dtype)
        qwen_tts = _module('qwen_tts')
        tts = qwen_tts.Qwen3TTSModel.from_pretrained(
            self._snapshot(config.model, config.model_revision),
            device_map=config.device,
            dtype=dtype,
            attn_implementation='sdpa',
        )
        speakers = tts.get_supported_speakers()
        if speakers is not None and config.speaker.lower() not in speakers:
            raise RuntimeError(f'模型没有音色 {config.speaker}，可选：{", ".join(speakers)}')
        languages = tts.get_supported_languages()
        if languages is not None and config.language.lower() not in languages:
            raise RuntimeError(f'模型不支持语言 {config.language}')
        detail = None
        if config.aligner:
            # 对齐模型加载失败不影响合成：只用插值，并在状态里说明。
            try:
                qwen_asr = _module('qwen_asr')
                self._aligner = qwen_asr.Qwen3ForcedAligner.from_pretrained(
                    self._snapshot(config.aligner, config.aligner_revision),
                    device_map=config.device,
                    dtype=dtype,
                    attn_implementation='sdpa',
                )
            except Exception as error:
                detail = f'强制对齐不可用，只用插值：{error}'[:200]
        self._tts = tts
        self._sample_rate = int(tts.model.speech_tokenizer.get_output_sample_rate())
        return Loaded(self._sample_rate, detail)

    def _generate(self, text: str) -> bytes:
        np = _module('numpy')
        with self._gpu:
            wavs, _ = self._tts.generate_custom_voice(
                text=text, speaker=self.config.speaker, language=self.config.language
            )
        wav = np.clip(np.asarray(wavs[0], dtype=np.float32), -1.0, 1.0)
        pcm = bytes((np.round(wav * 32767)).astype('<i2').tobytes())
        trim = self.config.trim
        return pcm if trim is None else trim_silence(pcm, self._sample_rate, trim)

    async def synthesize(self, text: str) -> AsyncGenerator[bytes]:
        if self._tts is None:
            raise RuntimeError('模型尚未加载')
        pcm = await run_blocking(self._generate, text)
        step = 2 * max(1, self._sample_rate * self.config.chunk_ms // 1000)
        for offset in range(0, len(pcm), step):
            yield pcm[offset : offset + step]
            await asyncio.sleep(0)

    def _align(self, text: str, pcm: bytes) -> list[Stamp]:
        np = _module('numpy')
        audio = np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768.0
        with self._gpu:
            results = self._aligner.align(
                audio=(audio, self._sample_rate), text=text, language=self.config.language
            )
        return [
            Stamp(str(item.text), float(item.start_time) * 1000, float(item.end_time) * 1000)
            for item in results[0]
            if str(item.text)
        ]

    async def align(self, text: str, pcm: bytes) -> list[Stamp] | None:
        if self._aligner is None:
            return None
        return await run_blocking(self._align, text, pcm)

    def close(self) -> None:
        self._tts = None
        self._aligner = None
