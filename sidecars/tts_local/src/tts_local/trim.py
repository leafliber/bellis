"""修剪一句合成音频句首句尾近乎无声的部分。只依赖标准库（三平台 CI 不装 numpy）。

Qwen3-TTS 每句前后带几百毫秒的近乎无声（真机约 -70…-90dBFS），可闻部分只占句长的七八成。
句首的静音让 Qwen3-ForcedAligner 把头几个字对进静音里，字幕早出；
句尾的静音让字幕在声音结束后才清除。
所以 qwen3 后端整句生成后、送出与对齐之前先修剪；对齐用修剪后的音频，时间戳相对修剪后的开头。

按 10ms 窗的 RMS 找第一个与最后一个高于门限的窗，两端各留一段余量，免得切到辅音的起音与尾音。
全句都低于门限时不修剪（由调用方原样送出并记日志），不修成空。
"""

from __future__ import annotations

import logging
import math
import sys
from array import array
from dataclasses import dataclass

#: 判断有声的窗长。
WINDOW_MS = 10

log = logging.getLogger('tts_local')


@dataclass(frozen=True)
class TrimConfig:
    #: 窗 RMS 相对满幅（32768）的门限。缺省 -55dBFS：S-07 的真机录音里句首句尾的底噪在
    #: -64…-90dBFS，开口的第一个窗约 -33…-28dBFS；门限比底噪的偶发尖峰高约 10dB，比开口低约 20dB。
    threshold_dbfs: float = -55.0
    #: 两端各留的余量。缺省 30ms（三个窗长）：留住门限以下的起音与衰减尾巴，
    #: 句首句尾不会突然开始或截断。
    margin_ms: int = 30


def _samples(pcm: bytes) -> array[int]:
    samples = array('h')
    samples.frombytes(pcm[: len(pcm) - len(pcm) % 2])
    if sys.byteorder == 'big':
        samples.byteswap()  # PCM 是小端。
    return samples


def audible_span(pcm: bytes, sample_rate: int, threshold_dbfs: float) -> tuple[int, int] | None:
    """16 位小端 PCM 中第一个到最后一个高于门限的窗的采样下标 [开始, 结束)。

    全都低于门限时为 None。最后一个窗不满 10ms 时按它自己的长度算均方值。
    """
    samples = _samples(pcm)
    count = len(samples)
    window = max(1, sample_rate * WINDOW_MS // 1000)
    # 比较均方值，不开方：门限换算成每个采样的平方。
    limit = (32768.0 * math.pow(10.0, threshold_dbfs / 20.0)) ** 2

    def loud(start: int) -> bool:
        chunk = samples[start : start + window]
        return sum(x * x for x in chunk) > limit * len(chunk)

    starts = range(0, count, window)
    first = next((i for i in starts if loud(i)), None)
    if first is None:
        return None
    last = next(i for i in reversed(range(first, count, window)) if loud(i))
    return first, min(count, last + window)


def trim_bounds(pcm: bytes, sample_rate: int, config: TrimConfig) -> tuple[int, int] | None:
    """修剪后保留的采样下标 [开始, 结束)（含两端余量）；全句都低于门限时为 None。"""
    span = audible_span(pcm, sample_rate, config.threshold_dbfs)
    if span is None:
        return None
    margin = sample_rate * config.margin_ms // 1000
    return max(0, span[0] - margin), min(len(pcm) // 2, span[1] + margin)


def trim_silence(pcm: bytes, sample_rate: int, config: TrimConfig) -> bytes:
    """修剪后的 PCM；全句都低于门限时原样返回并记一条日志。"""
    bounds = trim_bounds(pcm, sample_rate, config)
    if bounds is None:
        log.warning('整句都低于修剪门限 %sdBFS，原样送出', config.threshold_dbfs)
        return pcm
    start, end = bounds
    return pcm[2 * start : 2 * end]
