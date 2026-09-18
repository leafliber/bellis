## 附录D 外部参考

> 冻结的后续阶段参考资料；现行引用见 [docs/spec/d-sources.md](../../spec/d-sources.md)。S36–S39 为固定版本论文，2026-09-18 核对了方法与限制，未复现模型或测量本机性能。

| 编号 | 参考 | 本次使用与核验范围 |
|---|---|---|
| S1 | [Microsoft Speech语音合成](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-speech-synthesis) | 沿用既有记录；本版未逐项复核当前实现 |
| S5 | [Pipecat Interruptions](https://docs.pipecat.ai/pipecat/fundamentals/interruptions) | 沿用既有记录；本版未逐项复核当前实现 |
| S6 | [XState Actors](https://stately.ai/docs/actors) | 沿用既有记录；本版未逐项复核当前实现 |
| S9 | [Microsoft Speech降低延迟](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-lower-speech-synthesis-latency) | 沿用既有记录；本版未逐项复核当前实现 |
| S14 | [生成合成内容标识办法](https://www.cac.gov.cn/2025-03/14/c_1743654684782215.htm) | 本版查阅通用语义 |
| S15 | [拟人化互动服务暂行办法](https://www.cac.gov.cn/2026-04/10/c_1777558395078289.htm) | 本版查阅通用语义 |
| S20 | [OWASP LLM Prompt Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html) | 沿用既有记录；本版未逐项复核当前实现 |
| S22 | [OBS Compressor](https://obsproject.com/kb/compressor-filter) | 沿用既有记录；本版未逐项复核当前实现 |
| S23 | [OBS前端源码](https://github.com/obsproject/obs-studio/blob/master/frontend/widgets/OBSBasic.cpp) | 沿用既有记录；本版未逐项复核当前实现 |
| S25 | [B站官方公告入口](https://link.bilibili.com/p/eden/news) | 沿用既有记录；本版未逐项复核当前实现 |
| S26 | [游戏官方指南](https://manosaba.com/guidelines) | 沿用既有记录；本版未逐项复核当前实现 |
| S31 | [JSON Schema object](https://json-schema.org/understanding-json-schema/reference/object) | 本版查阅通用语义 |
| S32 | [OpenTelemetry Logs Data Model](https://opentelemetry.io/docs/specs/otel/logs/data-model/) | 本版查阅通用语义 |
| S35 | [RFC8785 JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785) | 本版读取RFC8785；采用对象的JCS摘要仍需实现阶段互操作测试。 |
| S36 | [Reinforcement Learning for Real-Time Vision-Language-Action Policies — 2609.18207v1](https://arxiv.org/html/2609.18207v1) | 2026-09-18核对固定版本HTML的方法与限制：慢候选与基于当前观察的有界编辑、价值选择分离。未复现模型，未测本机或游戏；Bellis对象/门禁为项目设计。 |
| S37 | [Decoupling Vision, Language, and Action for Efficient Multi-Task Robot Policies — 2609.18374v2](https://arxiv.org/html/2609.18374v2) | 2026-09-18核对固定版本HTML的方法与限制：独立视觉/语言编码条件化动作头，复用未变指令表示；结论限定已评估训练任务。未复现模型，未测本机或游戏；Bellis对象/门禁为项目设计。 |
| S38 | [Rollback the World, Keep the Reflection: Rollback-Induced Reflection for Long-Horizon LLM Agents — 2609.18304v2](https://arxiv.org/html/2609.18304v2) | 2026-09-18核对固定版本HTML的方法与限制：when/where/what恢复决策；世界恢复能力来自评测环境。未复现模型，未测本机或游戏；Bellis对象/门禁为项目设计。 |
| S39 | [RankGround: Efficient High-Resolution GUI Grounding via Lightweight Reranker-Guided Crop Selection — 2609.18690v1](https://arxiv.org/html/2609.18690v1) | 2026-09-18核对固定版本HTML的方法与限制：区域重排后定位；跨crop置信度、动态/多语言迁移有限制，非必然快于整图。未复现模型，未测本机或游戏；Bellis对象/门禁为项目设计。 |
