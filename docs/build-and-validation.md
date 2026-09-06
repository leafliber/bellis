# 构建与验收状态

> 2026-09-06 架构审查修订：任务所有权、工具恢复事实、调用列表范围、场景终态、Seq 分段预留及 Provider 接缝以 [ADR 0007](./adr/0007-task-ownership-and-runtime-scope.md) 为准。

此页维护当前可执行入口，历史 Phase 2/3 指南保留原始实施目标。未通过的指标不因脚本存在而视为完成。

## 首次运行

从仓库根目录执行。Node 的固定复验版本见 `.node-version`，pnpm 版本见 `package.json#packageManager`；安装时强制检查 engines。

```bash
pnpm install --frozen-lockfile
pnpm --filter @bellis/stage exec playwright install chromium
pnpm check
pnpm test:acceptance
```

`check` 依次执行 runtime baseline、全量 build、typecheck、lint、format、双 dialect 契约漂移、单元/性质/集成测试，能在无 dist 的检出上运行。`pnpm typecheck` 也通过完整的 workspace 源码映射解析内部包。
`test:acceptance` 依赖 check/build 生成的产物，依次执行 Phase 1 Demo、Phase 2 Demo、Phase 2 Crash、Phase 3 Demo 和 Chromium E2E。依赖及浏览器安装需要提前完成；安装完成后的确定性验收不依赖真实模型、外部记忆或商业资源。
`apps/stage/dist-web/` 是本地构建产物，由 `pnpm build` 生成并被 Git 忽略，不纳入源码提交。

## 能力与证据

| 能力 | 当前状态/权威文档 | 自动验证 | CI |
| --- | --- | --- | --- |
| 基础协议/DB Worker/恢复 | Phase 1 reference、protocols | check、demo:phase1 | Windows/macOS |
| Scene/媒体/三 Lane | Phase 2 reference、scene-execution | demo:phase2、demo:phase2:crash、test:browser | Windows/macOS |
| Decision Loop/独立工具调用列表/来源去重 | Phase 3 reference、ADR 0004/0006/0007 | check、demo:phase3 | Windows/macOS |
| 两 Cycle→真实浏览器、工具并行、urgent 取消 | Phase 3 浏览器专项 | test:browser 中 phase3-e2e | Windows/macOS |
| 子任务取消 P99 ≤100ms | 目标保留，统计性能验收尚未完成 | 当前功能测试证明取消传播；Demo 的 turnSettleLatencyMs 不等于 P99 | 不宣称已验收 |
| Memory 契约与 Iris 独立 Provider | 原型/独立包，见 Provider README | Provider 自身 typecheck/test/build | 不在根 workspace；独立验证 |
| 宿主 Context/Memory/Persona/Observe/Presence | [Phase 4 规划](./phase-4-development-guide.md)，ADR 0005–0008；4A Iris 接入优先 | 待实现；没有 demo:phase4 或 Iris 专项命令 | 不适用 |

CI 只代表其实际运行的平台与命令结果；本地测试结果不能代替固定 Node 版本的双平台运行。

2026-09-06 本轮修改前的基线复验（macOS、Node 26.8.1）：`pnpm check`、`pnpm test:acceptance` 全部通过，包括两组 Chromium E2E；Iris 独立包的 lint、format、typecheck、23 项测试及 build 通过。另在移除内部构建产物的隔离源码副本上验证 typecheck/build，复用已安装的外部依赖，未重新验证联网安装。CI 配置已补齐验收入口，固定 Node 26.5.0 的远端双平台结果仍以实际工作流为准。

## ADR 0007 本轮验证

2026-09-06，macOS / Node 26.8.1：

- `pnpm check` 通过：构建、类型、lint、格式、双 dialect 契约无漂移，899 项单元/性质测试与 193 项集成测试通过。
- `pnpm test:acceptance` 通过：Phase 1/2/3 Demo、四个 Scene 崩溃窗口和两组 Chromium E2E。
- Iris 独立 Provider 的 typecheck、23 项测试、build、lint 和 format 全部通过。

本轮回归覆盖 Turn 接受后立即关闭、连续 interrupt、后台工具排队后前台返回、执行事实写失败、durable 提交期间断线、Scene 执行截止、soft 准备超时/零预算/迟到丢弃、Worklet 开始确认与跨消息 Lane 偏差聚合、默认 Seq 预留/扩展失败/跨进程恢复、空工具目录和有界 evidence，以及无人格元数据的最小 Memory 贡献。

初次集成运行因沙箱禁止本机监听而返回 EPERM；在允许本机端口的执行环境中重新完成全套验证。浏览器本次样本的 hardLaneSkewMs 为 2.90ms、interruptLatencyMs 为 6.20ms，属于功能验收样本，不构成物理播放或取消 P99 统计结论。真实 TTS、模型 final 前 Prepare、首块预缓冲与 Phase 4 宿主纵向集成仍未交付。

## Phase 3 剩余性能验收

P99 的基准必须分别采样模型流停止、Tool 退出/资源释放、Stage 确认停止，固定起点为 Runtime 接受 interrupt 的单调时刻。跨时钟域先校准，记录样本数、平台、负载、误差上界和原始分位数。不得把一次 Turn idle、2.1s 的 Harness 总超时或“没有收到回执但继续成功”计为 100ms 子任务证据。

Phase 3 功能核心已交付；原计划的这一性能 Gate 仍开放。Phase 4 Gate 0 必须先记录此既有缺口，不能伪称全部 Phase 3 原定 Gate 通过。

## 契约变更与 Provider

Schema 改动后从根执行 `pnpm --filter @bellis/contracts build`、`pnpm --filter @bellis/contracts contracts:generate`、`pnpm contracts:check`；生成物与源变更一起审查。
Iris 处于独立 registry 过渡期，根 check 不包含它。其安装、宿主声明构建前置和独立验证见 [Provider README](../providers/memory-iris/README.md)。
Phase 4A 调研已单独核查 Provider/SDK/Core，结果及来源 hash、版本协商、partial proof 等接入差异见 [调研记录](./phase-4-iris-integration-research.md)。这些测试不代表真实 Bellis + Core 集成通过；后续必须补当前安装物和宿主实际效果/恢复验收。
Migration 只新增版本，不改历史 SQL/checksum；Signal 来源索引升级见 ADR 0006。
