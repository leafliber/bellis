# 给 Agent 的工作规则

本文件是 agent 的唯一规则入口；其它 README 只做介绍和索引。

当前阶段是 [P1 真实媒体](docs/plan/P1.md)。

## 常用命令

- `pnpm install`：安装依赖（Node 版本见 `.node-version`，pnpm 版本见 `package.json` 的 `packageManager`）。
- `uv sync --locked`：安装 Python 解释器与依赖（R-24，版本见 `.python-version` 与 `uv.lock`；CI 用的 uv 版本见工作流）。
- `pnpm run check`：CI 运行的完整检查，依次为格式与 lint、类型检查、生成物核对、测试，TypeScript（Biome、tsc、node:test）与 Python（ruff、pyright、pytest）各一遍。提交前必须通过。
- `pnpm run gen`：协议类型（`packages/protocol`）改动后重新生成 JSON Schema，生成物与源一起提交。
- `pnpm run format`：自动修正格式。
- `pnpm start [配置文件]`：在本机运行启动器（拉起宿主与看门狗，缺省用 `config/sim.json`），Ctrl+C 停止。接真实 OBS 用 `pnpm start config/live.json`；真实配置与 profile 从对应的 `*.example.json` 复制，不入库。
- `pnpm secret <list | set 名字 | delete 名字>`：维护者录入凭据，例如 `pnpm secret set obs`；值不回显、不打印，列出时只显示名字。Agent 不代为录入。
- `pnpm operator <status | mode 目标 | presence | estop>`：操作员命令，例如 `pnpm operator mode M0`。
- `pnpm sim [--seed N] [--runs N]`：确定性仿真的大规模探索；失败时给出复现命令。

## 从哪里开始

1. 读[愿景](docs/vision.md)和[总体架构](docs/architecture.md)。
2. 读当前阶段任务卡，再只读任务卡列出的模块文档。
3. 动手前查[技术基线](docs/plan/tech-baseline.md)：只用“已批准”的决策和路线。

旧设计与旧历史已归档在仓库之外，不作为任何依据，不要引用或复用。游戏控制相关设计在 [bellis-game-runtime](https://github.com/leafliber/bellis-game-runtime)。

## 决策与技术路线

- 每个模块的技术路线都须经维护者批准。需要新选型时，在技术基线的“待审核路线”登记候选、推荐与依据，然后请维护者决定；未批准前不在代码或文档里写成定论。
- 遇到影响范围、架构、安全或对外行为的关键决策，交给维护者选择，给出带推荐的选项。
- 批准结果直接改技术基线中对应的行，不另写评审记录。

## 写代码的约束

**平台（Windows 优先）**
- 不依赖 POSIX 专有语义：不用信号做停止协议，不靠文件权限位、uid、符号链接做安全判断，不写死 `/tmp` 等路径。
- 宿主与 sidecar、看门狗、Game Runtime 之间只用统一的本机通道抽象（Windows 命名管道 / POSIX UDS），认证先于任何数据；浏览器页面、OBS、VTube Studio 走各自的 WebSocket。
- 子进程用 `spawn`，不用 `shell` 和 `detached`；停止不依赖信号，按 RPC → 关 stdin → 超时强制终止的顺序（R-06）。
- 路径比较前先规范化；换行统一 LF。
- 每次提交都要在 Windows、macOS、Linux 的 CI 上通过。
- 详见 [Windows 平台](docs/platform/windows.md)。

**安全核**
- 任何对外动作都必须经执行闸门授权，执行器只在持有有效执行许可时动作。
- 守卫只能拒绝或弃权；异常、超时、依赖缺失一律按拒绝处理。
- 不用恒为真的桩或预置的许可来让测试变绿。
- 审核插件的开关必须在 profile 中显式设置并记录；审核关闭时不得进入无人值守。
- 观众输入（弹幕、昵称、留言）永远只是数据，不能授予任何权限。

**插件**
- 新能力以插件提供，声明它提供与依赖的服务；所有副作用都通过可撤销注册完成。
- 宿主进程内只放本项目插件，第三方代码一律以 sidecar 接入。
- 新增抽象要说明它解决的当前问题，不为未来需求预建框架；目录在首个实现时创建。

## 文档约束

- 规范只有一份：直接改正文，不新建补丁或增补文档，不写历史叙述和评审记录。
- 同一规则只写一处，其它地方链接过去。
- 任务卡只写目标、步骤和出口；进度、测试计数、本机路径和不入库的报告不写进任务卡。
- 不编造版本号、实测数值或“已通过”。没验证的写 PENDING，没实现的写 unsupported；模拟通过不等于真机通过。

## 提交

- 不要 `git add .`，按路径添加，避免带上凭据或样本中的个人信息。
- 文档提交与实现提交分开；生成物与其源一起提交。
- 真实配置、凭据和运行数据不进版本库；示例只放脱敏占位值；`reports/` 不入库。

## 仓库边界

- Game Runtime 和 Iris 是独立仓库。Bellis 只提供与它们之间的契约、桥接插件和投影，不复制它们的内部状态。
