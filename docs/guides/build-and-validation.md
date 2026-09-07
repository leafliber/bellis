# 构建与验收

本页仅维护当前可执行入口和环境要求。完成事实见 [当前能力状态](../reference/current-status.md)，后续工作见 [双线路线图](../plans/README.md)。早期多轮测试计数、旧 `incomplete` 判定与切片经过已移至 [验收历史快照](../archive/phase-4/build-validation-history.md)，不能作为当前命令状态。

## 首次运行

以下命令从仓库根执行。Node 固定基线见 `.node-version`，pnpm 见 `package.json#packageManager`。本地 SQLite 原生部分需要 C 编译器：macOS/Linux 使用 cc，Windows 使用 Visual Studio Developer 环境的 cl.exe；细节见 [原生构建](../../packages/persistence/native/README.md)。

```sh
pnpm install --frozen-lockfile
pnpm --filter @bellis/stage exec playwright install chromium
pnpm check
pnpm test:acceptance
```

`check` 先检查 evidence 和 scripts，再做 Runtime 基线、build/typecheck/lint/format、契约漂移及单元/性质/集成测试。`test:acceptance` 依赖构建产物，运行 Phase 1/2/3 Demo、Phase 2 Crash 和 Chromium E2E。安装依赖/浏览器后，确定性验收不依赖真实模型、商业角色或外部记忆；这也意味着它们不证明真实直播已完成。

`apps/stage/dist-web/` 是忽略的构建产物。真实 Core 不包含在根 workspace 检查内；独立 Provider 和真实联合探针按下节运行。

## 命令入口

| 命令 | 实际覆盖/前提 |
| --- | --- |
| `pnpm check` | 根 workspace 回归，不自动验证独立 Iris Provider 或真实服务 |
| `pnpm test:acceptance` | Demo/崩溃窗口/浏览器功能链；部分浏览器用例另有显式环境开关，按实际结果记录 skip |
| `pnpm test:browser` | 已构建 Stage 的 Chromium E2E |
| `pnpm evidence:check` | 摘要大小、原始逐次记录和被跟踪生成目录检查 |
| `pnpm test:scripts` | 摘要生成与 Cycle 审计反例检查 |
| `pnpm contracts:check` | 双 JSON Schema dialect 生成漂移 |
| `pnpm start:iris --config /absolute/path/to/iris-runtime.json` | 使用可信配置启动 Runtime，准备方法见 [Iris 运维](./iris-runtime.md) |
| `pnpm test:memory:iris` | 构建根包、独立 Provider 检查与公共接口探针；需要已安装的隔离 Core |
| `pnpm test:memory:iris:tools` / `pnpm test:memory:iris:invalidations` | 真实 Core 工具与外部失效专项 |
| `pnpm demo:phase4:iris` | 真实 Chromium → 已安装 SDK/Core 的输出确认与 Observe/Usage 链 |
| `pnpm test:memory:iris:continuous` | [100 Cycle 连续专项](../validation/iris-continuous.md) |
| `pnpm test:memory:iris:recovery` | [冻结 480 例恢复](../validation/iris-recovery.md)，不以剩余 Phase 4B 决定本 Gate |
| `pnpm test:memory:iris:stage-recovery` / `pnpm test:memory:iris:stage-observe-recovery` | 活动 Stage 相关专项，覆盖和结果按对应报告，不能自动并入冻结矩阵 |
| `pnpm test:memory:iris:snapshots` | Core/Host/双方快照专项；部分路径不等于全部旧快照组合通过 |

上述脚本以根 [package.json](../../package.json) 为源；Iris 探针开关与 Demo 文件分组见 [脚本索引](../../scripts/README.md)。缺 Core 路径返回未运行，不将 skipped/退出 2 记作通过。

## Iris 独立环境

先准备非 editable 的隔离 Core 安装、可用公共 API/Worker 及所需初始化/凭据，安装兼容组合以 [Provider 矩阵](../../providers/memory-iris/compatibility-matrix.json) 和报告为准；不从相邻 Core 私有源码导入。

```sh
pnpm --dir providers/memory-iris install --frozen-lockfile
pnpm build
pnpm --dir providers/memory-iris typecheck
pnpm --dir providers/memory-iris test
pnpm --dir providers/memory-iris build
pnpm --dir providers/memory-iris lint
pnpm --dir providers/memory-iris format:check
IRIS_CORE_PYTHON=/absolute/isolated-venv/bin/python \
pnpm test:memory:iris:recovery
```

依赖与权限要求见 [Provider README](../../providers/memory-iris/README.md)、[Iris 运维](./iris-runtime.md) 和各 [专项说明](../validation/README.md)。恢复完整运行应保留命令、退出码、安装物 hash、窗口数和限制。历史检查使用的 SDK/Core 组合不能自动扩展为全部版本支持。

## CI 与新阶段验收

现有 [CI](../../.github/workflows/ci.yml) 的 push 过滤为 main、master、codex/**，另有 pull_request 触发；phase4/dev 分支推送不自动证明 CI 已运行。阶段实施时让目标分支/PR 被实际覆盖，Windows/macOS 结果以工作流为准，不把本地通过冒充远端通过。

Phase 5 的入口为 [L5 + G5 + J5](../plans/phase-5.md)。真实 LLM/TTS、Cubism、平台和 OBS 是 L5 Gate；无游戏 FakeGame/干净包 consumer 是 G5 Gate。后续真实输入、多游戏与发布分别见各线计划。当前没有新的 `test:live`、`test:game` 或 `demo:phase5` 命令，落地后才加入本表。

公共包检查要求两仓独立构建，联合 consumer 只安装 tarball/wheel，不靠相邻源码、editable/link 或未解析 workspace 依赖。实际服务/角色/账号/机器条件缺失时完成确定性工作，真实 Gate 保持未运行。

## 变更与文档维护

Schema 修改后执行根 `pnpm --filter @bellis/contracts build`、`pnpm --filter @bellis/contracts contracts:generate` 与 `pnpm contracts:check`，源和生成物一起审查。Migration 只新增版本，不修改历史 SQL/checksum。

文档迁移需检查所有仓内 Markdown 相对链接、代码注释路径与示例路径；用户设计原文与证据 JSON 保留 hash/历史含义，不因路径整理重写测试成绩。历史原始报告、录屏和 Playwright 诊断归 artifact，仓内预算见 [证据规则](../evidence/README.md)。

一个可独立验证和回滚的切片形成一个提交。已获推送授权时保存到指定远端并核对 SHA；工作区改动不在 push 中。历史巨大提交不因整理而重写，文档不重复保存每轮工作区状态和测试计数。
