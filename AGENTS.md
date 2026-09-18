# 给 Agent 的工作规则

本文件是 agent 的唯一规则入口；其它 README 只做介绍和索引。

仓库现有：P0/P1 阶段的规范与机器可读契约、契约 SDK、模拟协议端点和检查工具。尚无 Bellis 宿主，没有接入真实 OBS、TTS、平台或游戏输入；生产验收全部 PENDING。

## 从哪里开始

1. 读当前阶段的任务卡：[docs/plan/P0.md](docs/plan/P0.md)（完成后再做 [P1](docs/plan/P1.md)）。
2. 读同阶段的契约简报：[docs/generated/P0.md](docs/generated/P0.md)。其中有该阶段的状态机、守卫、不变量与测试 ID、命令、事件、错误码和字段结构。
3. 只按任务卡列出的小节读 [docs/spec/](docs/spec/README.md)，不要通读规范。

不要读：

- `docs/future/`：P2 及以后、C0–C5 阶段的冻结设计，不实现、不校验。只有任务明确要求迁回某阶段时才读，迁回方法见 [docs/future/README.md](docs/future/README.md)。
- `contracts/generated/` 下的文件：它们是生成物，体积大。查类型用契约简报，或用 `jq '."$defs".X' contracts/generated/bundle.schema.json` 取单个定义。

## 改什么、改哪里

| 内容 | 编辑位置 |
| --- | --- |
| 规范说明、取舍理由、流程 | `docs/spec/<章节>.md` |
| 字段、状态机、守卫、事件、错误码、命令、代次、不变量、测试映射 | `contracts/src/*.json`（文件说明见 [contracts/README.md](contracts/README.md)） |
| SDK、工具、测试、宿主实现 | `packages/`、`tools/`、`tests/`；新可运行入口放 `apps/`，接入的插件放 `plugins/` |
| `contracts/generated/`、`docs/generated/` | 不手改，运行 `pnpm generate` 重建 |

## 命令

先切到 `.node-version` 指定的 Node，然后：

```bash
pnpm install --frozen-lockfile
```

改了 `contracts/src` 或 `tools/` 的生成逻辑之后，先运行：

```bash
pnpm generate
```

任何改动之后都运行下面这条命令，CI 跑的是同一条：

```bash
pnpm check
```

`pnpm check` 依次执行：生成物漂移检查、契约与文档一致性检查（报告写入 `reports/check.json`）、TypeScript 类型检查、Biome 和 `node:test` 测试。只跑测试用 `pnpm test`；阶段门禁用 `pnpm gate --phase P0`，退出码 2 表示 PENDING。

## 常见改动

- **加字段**：改 `contracts/src/schema.json` 中对应定义。所有对象都是封闭的：新字段同时写进 `properties` 和 `required`，不适用时用显式 null。正文需要解释时在对应章节加一句，不要在正文另列字段表。
- **加状态或转换**：改 `state-machines.json`。转换必须带 `guard` 和 `phase`；守卫要先登记在 `guards.json`。记录的状态字段引用生成的 `<状态机>State` 枚举，不要手写状态列表。
- **加事件**：只改 `events.json`，写清 authority、payload_schema、reliability、dedupe。`EventName` 枚举和 EventEnvelope 的载荷绑定由生成器派生。事件名写成已发生事实（`对象.过去式`）；`对象.动作` 是命令，登记在 `commands.json`。
- **加错误码**：只改 `errors.json`。每个 reason_code 只属于一个类别并给出 `retry_disposition`；ErrorEnvelope 的绑定由生成器派生。
- **加命令**：在 `commands.json` 登记，并在 `schema.json` 定义输入/结果类型；`RpcRequest` 由生成器派生。
- **加不变量**：在 `invariants.json` 登记性质（requirement）与必测方向（scenario），编号不可复用；`first_required_phase` 必须是现行阶段。同时在 `verification.json` 登记对应测试（只写 ID、阶段、runner、适配器与证据要求，不重复性质和必测方向），状态保持 `NOT_IMPLEMENTED` 和 `PENDING_SUT`，直到真实 SUT 跑过。

`contracts/src` 中每个条目的阶段都必须属于现行阶段（目前是 P0、P1），`pnpm check` 会拒绝其它阶段的条目。

## 写代码的约束

- 只做当前阶段的小范围改动。新增抽象要说明它解决的当前场景，不为未来需求预建框架；目录在首个实现时创建，不预建空包；跨包复用、独立运行或权限隔离有具体需求时再拆包。
- 每个模块交付：职责和不负责的范围、输入输出 Schema、状态与所有权、资源、时限/背压/清理、失败与恢复、模拟实现、测试场景和实际覆盖报告。
- 契约先改：关键契约变更先在 `docs/spec` 与 `contracts/src` 同步落定并写明理由，再改实现和测试。
- 守卫、审核、设备停止都是受信逻辑。不要用返回 true 的适配器让检查变绿，不要在插件里绕开权限“先跑通”，也不要把完整文件播放或同步等待包装成流式或非阻塞。
- Game Runtime 与 Iris 是独立仓库，Bellis 只提供公共契约、桥接和投影。

## 文档约束

- 规范只有一份：直接改正文，不新建“补丁”“增补说明”“vNext”文档，也不写历史版本叙述、迁移表或评审记录。
- 同一规则只写一处；正文不复制登记表（字段、状态、事件、错误都在契约简报里）。
- 不编造版本号、实测数值或“已通过”。未验证写 PENDING，未实现写 unsupported。

## 提交

- 不要 `git add .`，按路径添加，避免带上凭据或样本中的个人信息。
- 文档（`docs/`、`contracts/src`）提交与实现提交分开；生成物随其源一起提交。
- 真实配置、凭据和运行数据不进版本库，示例只放脱敏占位值；`reports/` 是每次运行的输出，不入库。
- 运行数据按实际落盘目录加入 `.gitignore`，不要用通配规则忽略 JSON 或数据库文件，以免把契约和测试样本一起忽略。

## 校验失败时

`pnpm check` 会打印失败项和诊断：

- `Generated files are out of date`：运行 `pnpm generate` 后重新检查。
- `phases`：登记里出现了非现行阶段的条目。要么改成现行阶段，要么移到 `docs/future/contracts/`。
- `fsm.<状态机>`：状态不可达、没有到终态的路径、(状态, 事件) 重复或守卫未登记。
- `records.<状态机>`：缺少记录绑定、记录不封闭，或状态字段没有引用 `<状态机>State`。
- `invariants-and-tests`：测试 ID 与不变量或阶段不一致，或 runner 与实现状态不符。
- `docs.*`：链接失效、引用了不存在的章节号、引用的 `[Sn]` 不在附录D、代码围栏不配对，或残留 `{{占位符}}`。

## 证明边界

检查通过只说明文档、Schema、登记、fixture 与生成物互相一致。它不证明守卫实现正确、内容审核有效、设备真的停止、时延达标或游戏结果成立。报告和提交信息里不要把“检查通过”说成“验收通过”；验收只能由真实 SUT 证据经 `pnpm gate` 判定。

## 目录

```text
AGENTS.md              本文件（agent 规则）
README.md              项目简介
docs/spec/             现行规范（P0/P1 相关章节，保留原章号）
docs/plan/             当前阶段任务卡、技术基线、技术探针
docs/generated/        各阶段契约简报（生成物）
docs/future/           冻结的后续阶段设计与登记（不校验）
contracts/src/         机器可读登记（编辑源）
contracts/fixtures/    结构校验样例
contracts/generated/   合成 Schema、TS 类型、登记快照、预编译校验器（生成物）
packages/contract-sdk/ 契约 SDK 与模拟协议端点
tools/                 generate / check / gate 以及 spikes/ 技术探针
tests/                 SDK 与工具测试，不替代生产 SUT
reports/               检查与探针输出，每次运行重写，不入库
```
