# 当前能力与验收状态

截至 2026-09-07，依据本地实现与既有证据核对；本次文档整理没有重新运行全量应用、真实 Core 或 Windows/OBS 验收。**核心基础已有实现，完整直播套件和真实游戏执行尚未交付。** 未来安排见 [双线路线图](../plans/README.md)，历史测试成绩不推定为当前所有配置通过。

## 实现与缺口

| 能力 | 当前事实与边界 | 后续出口 |
| --- | --- | --- |
| 协议、DB Worker、Scene、Decision Loop、Tool Runtime | 已有实现与确定性回归，见 [Phase 1](./phase-1.md)、[Phase 2](./phase-2.md)、[Phase 3](./phase-3.md)；原定全部性能目标未因此通过 | L6 真实负载/取消指标 |
| Stage 音频、字幕、确认与恢复 | 真实 Chromium/Worklet 链路与限定崩溃专项已有证据；不等于真实语音、物理听感或 OBS 联合通过 | L5.5、L6、J6 |
| 模型 | 已有 [OpenAI-compatible 适配器](../../apps/runtime/src/providers/model/openai-compatible.ts)；实际配置组合的直播体验仍需验收 | L5.1 |
| TTS | [Runtime 装配](../../apps/runtime/src/bootstrap/lifecycle.ts) 使用 `fakeSpeechProvider`；[Fake TTS](../../apps/runtime/src/application/phase-2/fake-tts.ts) 生成确定性测试波形 | L5.1 真实 Provider |
| Live2D / 主动表现 | [DOM Avatar](../../apps/stage/src/lanes/avatar/dom-avatar-lane.ts) 呈现动作文字徽标；完整 Cubism/Mixer/Presence 未交付 | L5.2 基础、L6 稳定性、L7 策略 |
| 直播平台 | 已有 Signal/Audience 基础，当前无完整正式平台插件和测试房间验收 | L5.3 |
| Studio / 公共插件 SDK | 当前应用目录主要为 Runtime/Stage；最小 Studio、公共插件宿主和 Session Activity 待实施 | S5、L5.4、G5 |
| Iris | 公共 SDK/HTTP、Context/Persona、Usage/Observe 等已有实现；仅已列范围通过，生产启动还有限定配置/工具边界 | [Phase 4 状态](./phase-4-status.md)、[Iris 运维](../guides/iris-runtime.md) |
| 历史恢复/容量 | 已有屏障、重验和逻辑预算；完整安全解除、旧快照/cursor/容量矩阵仍有缺口 | L6/L7，[承接表](../plans/phase-4/backlog.md) |
| 游戏平台 | 存在部分 GameIntent 类型，公共 GameProvider/Activity、独立 Runtime/FakeGame、真实捕获/输入均未由当前 Bellis 实现交付 | G5 公共接入、G6 首款真实游戏、G7 多游戏 |
| Launcher / 安装更新 | 尚无完整独立应用安装、签名更新、回滚和干净用户机器验收 | L8/G8/J8 |

## 已有验收结论

| 已记录的范围 | 结果与可追溯来源 | 不覆盖 |
| --- | --- | --- |
| Phase 4A 冻结恢复 | 8 窗口 × 3 目标 × 20 次 = 480/480，见 [冻结摘要](../evidence/phase4a-recovery-scope-freeze.json) | Phase 4B、任意快照/容量组合、所有活动 Stage 窗口 |
| 冻结时根检查 | 1054 项单元/性质、275 项集成、168 个生成契约；同一冻结摘要记录环境与命令 | 后续 SDK/直播/游戏新 Gate；独立 Provider 不自动包含在根 check |
| 连续链路 | 100 Cycle 的真实 Chromium、已安装 SDK/Core 链路，见 [连续验收](../validation/iris-continuous.md) | 长时真实直播、实际 TTS/模型音质、OBS 游戏同机负载 |
| Stage 崩溃专项 | 两个 Runtime 窗口各 20 次，见 [ADR 0046](../adr/0046-phase4-stage-effect-crash-recovery.md) | 与 480 例合并后的新矩阵或全部恢复范围 |

运行方法以 [构建指南](../guides/build-and-validation.md) 为准；当前环境、版本和远端 CI 必须另行核对。计划新增的 L/G/J Gate 均未运行，不能用这些历史数字填入其完成栏。

## 更新规则

按主题替换状态、附实际证据和限制；切片经过放提交/PR，长期历史放 [归档](../archive/README.md)。Phase 4 原细项状态继续由专页维护，本页只负责产品层面的准确入口。
