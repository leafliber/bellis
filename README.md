# Bellis

贝莉（Bellis）是一个 AI 主播的内核：一个角色在直播中和观众交流、发起投票、自主玩游戏并解说。语言模型决定做什么；确定性的安全核决定能不能做、怎么停；每项能力都是可以单独开关和替换的插件。

最终目标是在已适配的游戏中，以 VLA 方式完全自主游玩原神这类游戏（即时战斗、剧情理解、多样小游戏解谜），并最终支持无人值守直播。首个公开里程碑是《魔法少女的魔女审判》试播。

## 当前状态

设计阶段：仓库只有文档，尚无代码、依赖和 CI。当前阶段是 [P0 内核与安全核](docs/plan/P0.md)，开工前需要先在[技术基线](docs/plan/tech-baseline.md)中批准工程选型。

## 从哪里读

| 你要做的事 | 入口 |
| --- | --- |
| 了解项目 | [愿景与目标](docs/vision.md)、[总体架构](docs/architecture.md) |
| 实现当前阶段 | [P0 任务卡](docs/plan/P0.md) |
| 查选型是否已批准 | [技术基线与路线审核](docs/plan/tech-baseline.md) |
| 以 agent 身份修改仓库 | [AGENTS.md](AGENTS.md) |

## 相关仓库

- [bellis-game-runtime](https://github.com/leafliber/bellis-game-runtime)（私有）：游戏采集、感知、VLA 控制与输入代理。
- iris-core：长期记忆服务。Bellis 只召回直播间的公开事实，写入经隐私网关。
