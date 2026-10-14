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
- [VTube Studio API](https://github.com/DenchiSoft/VTubeStudio)。

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
