# Bellis

贝莉（Bellis）是一个 AI 主播的内核：一个角色在直播中和观众交流、发起投票、自主玩游戏并解说。语言模型决定做什么；确定性的安全核决定能不能做、怎么停；每项能力都是可以单独开关和替换的插件。

最终目标是在已适配的游戏中，以 VLA 方式完全自主游玩原神这类游戏（即时战斗、剧情理解、多样小游戏解谜），并最终支持无人值守直播。首个公开里程碑是《魔法少女的魔女审判》试播。

## 当前状态

当前阶段是 [P2 真实互动](docs/plan/P2.md)：接入 B 站弹幕、决策模型、投票、Iris 记忆与操作台。工程命令见 [AGENTS.md](AGENTS.md#常用命令)。

## 从哪里读

| 你要做的事 | 入口 |
| --- | --- |
| 了解项目 | [愿景与目标](docs/vision.md)、[总体架构](docs/architecture.md) |
| 实现当前阶段 | [P2 任务卡](docs/plan/P2.md) |
| 查选型是否已批准 | [技术基线与路线审核](docs/plan/tech-baseline.md) |
| 以 agent 身份修改仓库 | [AGENTS.md](AGENTS.md) |

## 相关仓库

- [bellis-game-runtime](https://github.com/leafliber/bellis-game-runtime)（私有）：游戏采集、感知、VLA 控制与输入代理。
- [iris-core](https://github.com/AirObject/iris-core)：长期记忆服务。Bellis 只召回直播间的公开事实，写入经隐私网关。
