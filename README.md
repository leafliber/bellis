# Bellis

贝莉（Bellis）是一个 AI VTuber 直播系统：一个角色同时承担沟通交流、观众投票和剧情游戏直播，由单一高层采用者决定做什么，由确定性运行时决定何时允许执行、怎样协调、如何停止。

## 当前状态

规范基线 v0.8，协议设计版本 0.8.0（拟议，未发布 SDK）。仓库包含 P0/P1 阶段的规范与机器可读契约、可运行的契约 SDK、模拟协议端点和检查工具。尚无 Bellis 宿主，没有接入真实 OBS、TTS、平台或游戏输入，生产验收全部 PENDING。

实施顺序：先做 [P0 安全骨架](docs/plan/P0.md)（授权、停止与事实查询），再做 [P1 媒体闭环](docs/plan/P1.md)（固定内容的增量播放）。P2 及以后阶段的设计冻结在 [docs/future/](docs/future/README.md)，进入对应阶段时再启用。

## 从哪里读

| 你要做的事 | 入口 |
| --- | --- |
| 以 agent 身份修改仓库 | [AGENTS.md](AGENTS.md) |
| 实现当前阶段 | [docs/plan/P0.md](docs/plan/P0.md)、[P0 契约简报](docs/generated/P0.md) |
| 了解系统设计 | [规范索引](docs/spec/README.md) |
| 查状态机、事件、错误码等的准确定义 | [contracts/](contracts/README.md) |

## 快速开始

需要 `.node-version` 指定的 Node 和 `package.json` 中固定版本的 pnpm。

```bash
pnpm install --frozen-lockfile
```

```bash
pnpm check
```

`pnpm check` 通过只说明文档、Schema、登记和 fixture 互相一致，不证明守卫实现、内容审核、设备停止、时延或游戏结果。
