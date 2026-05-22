"""通用 HTTP API 驱动 — 兼容 OpenAI TTS API 和本地 VITS 部署。

支持两种模式：
1. openai: 兼容 OpenAI /v1/audio/speech 接口格式
2. vits: 兼容本地 VITS 部署的 /tts 接口格式
"""

from __future__ import annotations

import logging

import httpx

from bellis.core.models import TTSTask
from bellis.runtime.executors import TTSExecutor

logger = logging.getLogger(__name__)


class ApiTTSDriver(TTSExecutor):
    """基于 HTTP API 的 TTS 驱动，兼容 OpenAI TTS 和本地 VITS 部署。

    Attributes:
        _endpoint: API 端点 URL。
        _api_key: 认证密钥（本地部署可留空）。
        _voice: 音色标识。
        _model: 模型名称（OpenAI 模式使用）。
        _api_format: API 格式，``"openai"`` 或 ``"vits"``。
    """

    def __init__(
        self,
        endpoint: str = "http://localhost:9880/tts",
        api_key: str = "",
        voice: str = "default",
        model: str = "tts-1",
        api_format: str = "openai",
    ) -> None:
        self._endpoint = endpoint.rstrip("/")
        self._api_key = api_key
        self._voice = voice
        self._model = model
        self._api_format = api_format

    async def synthesize(self, task: TTSTask) -> bytes | None:
        """通过 HTTP API 合成语音。

        根据 api_format 选择请求格式：
        - openai: POST /v1/audio/speech，body={"model", "input", "voice", "speed"}
        - vits: POST /tts，body={"text", "speaker_id"/"voice", "speed"}

        Args:
            task: TTS 合成任务。

        Returns:
            音频字节数据，合成失败时返回 None。
        """
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"

        if self._api_format == "openai":
            payload = self._build_openai_payload(task)
        else:
            payload = self._build_vits_payload(task)

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(self._endpoint, json=payload, headers=headers)
                resp.raise_for_status()
                audio = resp.content
                if audio:
                    logger.debug("API TTS 合成成功: %d bytes, endpoint=%s", len(audio), self._endpoint)
                    return audio
                logger.warning("API TTS 返回空音频: endpoint=%s", self._endpoint)
                return None
        except httpx.HTTPStatusError as e:
            logger.error("API TTS HTTP 错误: %s %s", e.response.status_code, self._endpoint)
            return None
        except httpx.RequestError:
            logger.exception("API TTS 请求异常: endpoint=%s", self._endpoint)
            return None

    def _build_openai_payload(self, task: TTSTask) -> dict:
        """构建 OpenAI TTS API 请求体。"""
        return {
            "model": self._model,
            "input": task.text,
            "voice": self._voice,
            "speed": task.speed,
        }

    def _build_vits_payload(self, task: TTSTask) -> dict:
        """构建 VITS 本地部署请求体。"""
        return {
            "text": task.text,
            "voice": self._voice,
            "speaker_id": self._voice,
            "speed": task.speed,
        }
