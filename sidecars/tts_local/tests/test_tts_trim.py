import logging
import math
import struct

import pytest

from tts_local.__main__ import build_backend, parse_args
from tts_local.qwen import QwenBackend
from tts_local.trim import TrimConfig, audible_span, trim_bounds, trim_silence

RATE = 24_000


def pcm(*parts: tuple[float, float]) -> bytes:
    """依次拼接若干段 (时长秒, RMS dBFS) 的 440Hz 正弦；SILENT 量化后是全零。"""
    samples: list[int] = []
    for seconds, dbfs in parts:
        amplitude = 32767 * math.pow(10, dbfs / 20) * math.sqrt(2)  # 正弦的 RMS = 峰值 / √2
        count = round(seconds * RATE)
        start = len(samples)
        samples.extend(
            max(
                -32768,
                min(32767, round(amplitude * math.sin(2 * math.pi * 440 * (start + i) / RATE))),
            )
            for i in range(count)
        )
    return struct.pack(f'<{len(samples)}h', *samples)


SILENT = -120.0  # 量化后为全零


def test_finds_the_first_and_last_window_above_the_threshold():
    audio = pcm((0.5, -80), (1.0, -20), (0.3, -80))
    assert audible_span(audio, RATE, -55) == (round(0.5 * RATE), round(1.5 * RATE))
    # 底噪本身高于门限时整句都算有声。
    assert audible_span(audio, RATE, -90) == (0, len(audio) // 2)


def test_threshold_decides_what_counts_as_silence():
    # 句首有一段 -60dBFS 的轻声：门限 -55 时剪掉，门限 -65 时保留。
    audio = pcm((0.2, SILENT), (0.2, -60), (0.5, -20), (0.2, SILENT))
    assert audible_span(audio, RATE, -55) == (round(0.4 * RATE), round(0.9 * RATE))
    assert audible_span(audio, RATE, -65) == (round(0.2 * RATE), round(0.9 * RATE))


def test_keeps_a_margin_at_both_ends_without_running_past_the_audio():
    audio = pcm((0.5, SILENT), (1.0, -20), (0.5, SILENT))
    config = TrimConfig(threshold_dbfs=-55, margin_ms=30)
    margin = round(0.03 * RATE)
    assert trim_bounds(audio, RATE, config) == (
        round(0.5 * RATE) - margin,
        round(1.5 * RATE) + margin,
    )
    # 余量超出音频两端时截在两端。
    short = pcm((0.01, SILENT), (0.5, -20), (0.01, SILENT))
    assert trim_bounds(short, RATE, TrimConfig(margin_ms=100)) == (0, len(short) // 2)


def test_silence_only_at_the_start_or_only_at_the_end():
    head = pcm((0.4, SILENT), (0.6, -20))
    assert trim_bounds(head, RATE, TrimConfig(margin_ms=0)) == (round(0.4 * RATE), len(head) // 2)
    tail = pcm((0.6, -20), (0.4, SILENT))
    assert trim_bounds(tail, RATE, TrimConfig(margin_ms=0)) == (0, round(0.6 * RATE))


def test_all_silent_is_not_trimmed_to_nothing(caplog: pytest.LogCaptureFixture):
    assert audible_span(pcm((1.0, -70)), RATE, -55) is None
    assert trim_bounds(pcm((1.0, SILENT)), RATE, TrimConfig()) is None
    assert trim_bounds(b'', RATE, TrimConfig()) is None
    quiet = pcm((1.0, -70))
    with caplog.at_level(logging.WARNING, logger='tts_local'):
        assert trim_silence(quiet, RATE, TrimConfig()) == quiet
    assert [r.getMessage() for r in caplog.records] == ['整句都低于修剪门限 -55.0dBFS，原样送出']


def test_trim_silence_cuts_the_pcm_bytes():
    audio = pcm((0.5, SILENT), (1.0, -20), (0.5, SILENT))
    trimmed = trim_silence(audio, RATE, TrimConfig(margin_ms=30))
    start = (round(0.5 * RATE) - round(0.03 * RATE)) * 2
    assert trimmed == audio[start : start + len(trimmed)]
    assert len(trimmed) == (round(1.0 * RATE) + 2 * round(0.03 * RATE)) * 2


def test_a_partial_last_window_is_judged_by_its_own_length():
    # 最后一个窗只有 5ms，但响度够：算进可闻部分。
    audio = pcm((0.5, SILENT), (0.005, -20))
    assert audible_span(audio, RATE, -55) == (round(0.5 * RATE), len(audio) // 2)


@pytest.mark.parametrize(
    ('argv', 'expected'),
    [
        ([], TrimConfig()),
        (['--trim-threshold-dbfs=-60', '--trim-margin-ms', '40'], TrimConfig(-60, 40)),
        (['--no-trim'], None),
    ],
)
def test_command_line_configures_trimming(argv: list[str], expected: TrimConfig | None):
    backend = build_backend(
        parse_args(['--backend', 'qwen3', '--model', 'Qwen/x', '--speaker', 'vivian', *argv])
    )
    assert isinstance(backend, QwenBackend)
    assert backend.config.trim == expected
