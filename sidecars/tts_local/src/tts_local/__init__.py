"""本地降级 TTS sidecar（R-10）：提供 `tts@1`，由宿主内的 `tts-local` 代理插件管理。

- `service`：`tts.info` 与 `tts.synthesize`，音频经通道的二进制帧送回；
- `fake`：假后端，按朗读文本长度产生正弦或静音，可配置首包延迟与“合成到一半崩溃”，用于测试与演练；
- `protocol`：由 `packages/protocol` 生成的 Pydantic 模型。

真实后端（Qwen3-TTS）与强制对齐（Qwen3-ForcedAligner）待模型下载获批后接入。
"""
