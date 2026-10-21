# 参考资料

设计决策所依据的公开资料。外部资料只支持通用结论，具体到 Bellis 的数值和行为以本项目实测为准。厂商自报的延迟与性能不作为承诺。

## 插件内核

- [DeepSeek Harness 架构](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)、[Cordis 入门](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.md)、[防御性模式](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/defensive-patterns.md)：服务、依赖激活、可撤销注册、profile 与 patch、热替换。
- [Cordis 论文：A Programming Paradigm for Spatiotemporal Composability](https://arxiv.org/abs/2608.25512)：撤回语义的前提与边界。
- [Pipecat 管线](https://docs.pipecat.ai/pipecat/learn/pipeline)、[LiveKit Agents](https://docs.livekit.io/agents/build/anatomy)：语音 agent 的帧优先级、打断与插件模型。

## 安全

- [CaMeL](https://arxiv.org/abs/2503.18813)：特权与隔离模型分工、按能力放行动作。
- [Design Patterns for Securing LLM Agents against Prompt Injections](https://arxiv.org/abs/2506.08837)：动作选择、先计划后执行等模式。
- [Meta：Agents Rule of Two](https://ai.meta.com/blog/practical-ai-agent-security/)：不可信输入、敏感数据、对外动作三者至多占两项。
- [The Attacker Moves Second](https://arxiv.org/abs/2510.09023)：自适应攻击能突破多数分类器防御，需要多层兜底。
- [Crescendo](https://arxiv.org/abs/2404.01833)：多轮渐进越狱。
- [Qwen3Guard](https://arxiv.org/abs/2510.14276)：逐 token 流式审核与“有争议”分级。

## 实时语音与媒体

- [OpenAI Realtime 打断与截断讨论](https://community.openai.com/t/realtime-api-interruptions-dont-properly-trim-the-transcript/1000703)：上下文应截到观众实际听到的位置。
- [LiveKit 轮次调优](https://docs.livekit.io/agents/logic/turns/tuning/)、[LLM 内容过滤示例](https://docs.livekit.io/reference/recipes/llm_powered_content_filter)。
- [W3C Web Audio](https://www.w3.org/TR/webaudio-1.1/)、[W3C Secure Contexts](https://www.w3.org/TR/secure-contexts/)。
- [OBS 浏览器源](https://obsproject.com/kb/browser-source)、[obs-websocket 协议](https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md)、[obs-browser #406（Win11 定时器节流导致的音频问题）](https://github.com/obsproject/obs-browser/issues/406)。
- [VTube Studio API](https://github.com/DenchiSoft/VTubeStudio)、[VTS 录制与推流设置](https://github.com/DenchiSoft/VTubeStudio/wiki/Recording-Streaming-with-OBS)。
- [ws](https://github.com/websockets/ws)、[OWASP WebSocket 安全](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)、[Chrome 定时器节流](https://developer.chrome.com/blog/timer-throttling-in-chrome-88)。
- [MiniMax 双向流式 TTS](https://platform.minimax.io/docs/api-reference/speech-t2a-websocket-bidi.md)（[中国大陆版](https://platform.minimax.cn/docs/api-reference/speech-t2a-websocket-bidi.md)；鉴权见[同步 WebSocket 指南](https://platform.minimax.io/docs/guides/speech-t2a-websocket.md)，限流见[速率限制](https://platform.minimax.cn/docs/guides/rate-limits.md)）、[火山引擎双向流式 TTS](https://docs.volcengine.com/docs/DoubaoVoice/bidirectional-streaming-text-to-speech-websocket?lang=zh)（二进制帧、事件号与鉴权头见 [WebSocket 双向流式-V3](https://docs.volcengine.com/docs/6561/1329505)）、[Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS)。
- [Qwen3-ForcedAligner](https://arxiv.org/abs/2601.21337)：非自回归强制对齐，中日文字级时间戳。

## 直播平台

- B 站直播开放平台：[快速开始](https://open-live.bilibili.com/document/849b924b-b421-8586-3e5e-765a72ec3840)、[应用 API](https://open-live.bilibili.com/document/eba8e2e1-847d-e908-2e5c-7a1ec7d9266f)、[签名鉴权](https://open-live.bilibili.com/document/74eec767-e594-7ddd-6aba-257e8317c05d)、[长连接数据协议](https://open-live.bilibili.com/document/657d8e34-f926-a133-16c0-300c1afc6e6b)、[消息命令](https://open-live.bilibili.com/document/f9ce25be-312e-1f4a-85fd-fef21f1637f8)、[常见问题](https://open-live.bilibili.com/document/5dffc297-6fd2-41ff-bd45-6e8b89e2a68e)。
- 开放平台的社区实现（官方文档没写明之处交叉核对用，MIT）：[blivedm](https://github.com/xfgryujk/blivedm)（`blivedm/clients/open_live.py`、`ws_base.py`）、[bianka](https://github.com/vtb-link/bianka)。

## 模型与记忆

- 火山方舟：[模型列表](https://docs.volcengine.com/docs/ark/model-list)、[深度思考](https://docs.volcengine.com/docs/ark/deep-thinking)、[Chat API](https://ark.volcengine.com/region:cn-beijing/docs/chat-api.md)、[Base URL 与鉴权](https://ark.volcengine.com/region:cn-beijing/docs/base-url-and-authentication.md)、[GLM-5.3-flash 模型卡](https://ark.volcengine.com/models/glm-5-3-flash.md)。
- OpenAI 兼容的 Chat Completions（模型客户端按它收发）：[流式返回的块](https://platform.openai.com/docs/api-reference/chat-streaming)、[结构化输出](https://platform.openai.com/docs/guides/structured-outputs)、[函数调用](https://platform.openai.com/docs/guides/function-calling)；SSE 按 [WHATWG 的事件流格式](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation)解析。
- [iris-core 宿主接口契约](https://github.com/AirObject/iris-core/blob/main/docs/host-api.md)。
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)、[OTLP 文件格式](https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/protocol/file-exporter.md)、[OpenTelemetry GenAI 语义约定](https://github.com/open-telemetry/semantic-conventions-genai)。

## VLA 与游戏控制

- [Real-Time Chunking](https://arxiv.org/abs/2506.07339)、[Training-time RTC](https://arxiv.org/abs/2512.05964)、[FASTER](https://arxiv.org/abs/2603.19199)：动作块的实时执行与首动作时间。
- [Hi Robot](https://arxiv.org/abs/2502.19417)、[Figure Helix](https://www.figure.ai/news/helix)、[GR00T N1](https://arxiv.org/abs/2503.14734)、[Gemini Robotics](https://arxiv.org/abs/2503.20020)：快慢双系统与层间接口。
- [π*0.6 / RECAP](https://www.pi.website/blog/pistar06)、[RaC](https://arxiv.org/abs/2509.07953)：人工干预数据与离线强化学习。
- [Lumine](https://arxiv.org/abs/2511.08892)：原神中的 VLA，观测与动作频率、按需思考、时延与失败模式。
- [Game-TARS](https://arxiv.org/abs/2510.23691)、[NitroGen](https://arxiv.org/abs/2601.02427)、[VideoGameBench](https://arxiv.org/abs/2505.18134)：游戏 agent 的动作空间与实时性局限。
- [SAFE](https://arxiv.org/abs/2506.09937)、[FIPER](https://arxiv.org/abs/2510.09459)：学习策略的失败检测。

## Windows

- [Node child_process](https://nodejs.org/api/child_process.html)、[libuv Windows 进程实现](https://github.com/libuv/libuv/blob/v1.x/src/win/process.c)、[libuv 命名管道实现](https://github.com/libuv/libuv/blob/v1.x/src/win/pipe.c)。
- [命名管道安全与访问权限](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)、[交互式服务](https://learn.microsoft.com/en-us/windows/win32/services/interactive-services)。
- [timeBeginPeriod](https://learn.microsoft.com/en-us/windows/win32/api/timeapi/nf-timeapi-timebeginperiod)、[SetProcessInformation](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-setprocessinformation)。
- [SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)、[NVIDIA MPS](https://docs.nvidia.com/deploy/mps/latest/when-to-use-mps.html)、[Electron safeStorage（DPAPI 说明）](https://www.electronjs.org/docs/latest/api/safe-storage)。

## 合规

见[合规与许可](compliance.md)中各条目的链接。
