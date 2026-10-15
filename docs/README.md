# 文档索引

建议按顺序阅读：愿景 → 总体架构 → 当前阶段任务卡 → 任务卡列出的模块文档。

| 文档 | 内容 |
| --- | --- |
| [愿景与目标](vision.md) | Bellis 是什么、最终目标、里程碑、非目标、设计原则 |
| [总体架构](architecture.md) | 分层、进程、通道、编排、事件、状态、发声链路、游戏控制分层、监督模式、时延目标 |
| [合规与许可](compliance.md) | 法规、平台、游戏、素材与数据的准入清单 |
| [参考资料](references.md) | 设计所依据的公开资料 |

## 模块

| 模块 | 层 | 首次实现 |
| --- | --- | --- |
| [插件内核](modules/plugin-kernel.md) | 内核 | P0 |
| [安全核](modules/safety-core.md) | 安全核 | P0 |
| [状态存储](modules/state-store.md) | 安全核 | P0 |
| [发声](modules/speech.md) | 关键平面 / 普通插件 | P0 模拟，P1 真实 |
| [审核插件](modules/moderation.md) | 普通插件（可关闭） | P0 模拟，P2 真实 |
| [Stage、OBS 与形象](modules/stage.md) | 关键平面 / 普通插件 | P0 模拟，P1 真实 |
| [决策模型](modules/director.md) | 普通插件 | P0 回放，P2 真实 |
| [观众接入与投票](modules/audience.md) | 普通插件 | P0 回放，P2 真实 |
| [记忆](modules/memory.md) | 普通插件 | P2 |
| [游戏桥](modules/game-bridge.md) | 普通插件 | P3 |
| [运维：操作台、观测与评测](modules/operations.md) | 普通插件 | P0 仿真，P2 操作台 |

## 平台与计划

| 文档 | 内容 |
| --- | --- |
| [Windows 平台](platform/windows.md) | 进程、通信、凭据、定时、GPU、OBS、路径、CI 的约束 |
| [技术基线与路线审核](plan/tech-baseline.md) | 已批准的决策与待审核的技术路线 |
| [路线图](plan/roadmap.md) | 阶段、内容与出口 |
| [P1 任务卡](plan/P1.md) | 当前阶段 |
| [P0 任务卡](plan/P0.md) | 已完成的阶段 |
| [真机探针](plan/spikes.md) | 需要在 Windows 真机上验证的假设 |
