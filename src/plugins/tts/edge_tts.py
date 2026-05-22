"""Edge-TTS 驱动 — 使用微软 Edge-TTS 在线服务合成语音。

依赖: pip install edge-tts
"""

from __future__ import annotations

import io
import logging

from bellis.core.enums import EmotionEnum
from bellis.core.models import TTSTask
from bellis.runtime.executors import TTSExecutor

logger = logging.getLogger(__name__)

# 情绪 → Edge-TTS 语气风格映射（edge-tts 不直接支持 emotion，
# 这里用 rate 微调来模拟：兴奋/开心稍快，悲伤稍慢）
_EMOTION_RATE_OFFSET: dict[str, float] = {
    "happy": 0.1,
    "excited": 0.15,
    "calm": -0.05,
    "shy": -0.05,
    "angry": 0.1,
    "sad": -0.15,
    "surprised": 0.05,
    "neutral": 0.0,
}


class EdgeTTSDriver(TTSExecutor):
    """基于 edge-tts 库的 TTS 驱动。

    Attributes:
        _voice: Edge-TTS 音色名称（如 ``zh-CN-XiaoxiaoNeural``）。
        _rate: 基础语速百分比字符串（如 ``"+0%"``）。
    """

    def __init__(self, voice: str = "zh-CN-XiaoxiaoNeural", rate: str = "+0%") -> None:
        self._voice = voice
        self._rate = rate

    async def synthesize(self, task: TTSTask) -> bytes | None:
        """使用 Edge-TTS 合成语音。

        Args:
            task: TTS 合成任务。

        Returns:
            MP3 格式音频字节数据，合成失败时返回 None。
        """
        try:
            import edge_tts
        except ImportError:
            logger.error("edge-tts 未安装，请执行: pip install edge-tts")
            return None

        # 计算语速：基础 rate + 情绪偏移 + task.speed
        rate_offset = _EMOTION_RATE_OFFSET.get(task.emotion.value, 0.0)
        speed_pct = int((task.speed - 1.0 + rate_offset) * 100)
        rate_str = f"{speed_pct:+d}%"

        try:
            communicate = edge_tts.Communicate(
                text=task.text,
                voice=self._voice,
                rate=rate_str,
            )
            buffer = io.BytesIO()
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    buffer.write(chunk["data"])
            audio = buffer.getvalue()
            if audio:
                logger.debug("Edge-TTS 合成成功: %d bytes, voice=%s, rate=%s", len(audio), self._voice, rate_str)
                return audio
            logger.warning("Edge-TTS 合成返回空音频: text=%r", task.text[:50])
            return None
        except Exception:
            logger.exception("Edge-TTS 合成异常: text=%r", task.text[:50])
            return None
