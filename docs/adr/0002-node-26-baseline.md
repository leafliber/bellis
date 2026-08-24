# ADR 0002：开发与 CI 基线调整为 Node.js 26

> 状态：Accepted
>
> 日期：2026-08-19
>
> 决策人：项目负责人
>
> 决策范围：`engines.node`、CI Node 版本、`node:sqlite` 稳定性核验基线
>
> 关联文档：[Phase 1 完成态参考](../phase-1-reference.md) · [技术选型基线](../technology-selection.md)

## 背景

`technology-selection.md` 第 21 节冻结项与原 Phase 1 构建任务书曾规定：

- Runtime 使用 Node.js 24 LTS，最低 24.15，`engines.node` 固定 `>=24.15 <25`。
- 文档修订时的验证基线为 Node.js 24.19.0。

P0 开工环境核验结果（2026-08-19）：

- 开发机默认 Node 为 v26.5.0，未安装任何 Node 版本管理器（nvm/fnm/volta/asdf/n 均不存在），corepack 亦不可用。
- Node 26.5.0 内嵌 SQLite 3.53.3，满足选型文档「SQLite 3.51.3 或更高」的要求。
- `node:sqlite` 在 Node 24.15+ 为 Stability 1.2；Node 26 中该模块的稳定性只升不降，具体状态由 `pnpm runtime:check` 在固定版本上实测记录。

按构建指导第 0 节的执行优先级，改变冻结工程决策必须由项目负责人决策并记录 ADR，不得由执行 Agent 以「先做出来再说」的方式暗中变更。负责人已明确选择保留本机 Node 26 并放宽 `engines`。

## 决策

1. 开发与 CI 的 Node 基线从 Node.js 24 LTS（24.19.0）调整为 **Node.js 26（26.5.0）**。
2. `engines.node` 固定为 `>=26.5 <27`，`.npmrc` 保持 `engine-strict=true`，防止在未验证的解释器版本上安装或运行。
3. CI（Windows 11 / macOS）固定完整补丁版本 26.5.0，与仓库 `engines` 字段和后续发布清单保持同一版本口径。
4. `verify-runtime-baseline.mjs` 的双平台断言、Worker `stderr` 捕获和 Node/SQLite 版本输出要求不变，基线版本改为在 Node 26.5.0 上执行。
5. 不设置 `NODE_NO_WARNINGS`，不全局关闭 `ExperimentalWarning`；若 Node 26 对 `node:sqlite` 产生新的警告或平台差异，按既有规则让测试失败并评估。

## 不变更的内容

- TypeScript 7.x、ESM、pnpm Workspace、Oxlint + Oxfmt、`tsc -b` 作为类型检查唯一真相源等其余冻结项不变。
- `node:sqlite` 只能在 DB Worker 内使用的边界不变。
- 所有时间、序号、水位和协议格式约定不变。

## 影响与后续

- 正向：与当前开发环境一致，消除版本管理器依赖；SQLite 内嵌版本更新。
- 代价：脱离 Node 24 LTS 支持窗口的时间点更早；`node:sqlite` 稳定性核验对象从「24.15+ Stability 1.2」变为「Node 26 实测状态」，需在 Gate 1 交付说明中记录实测结论。
- 发布包随 Launcher 内嵌的 Node 运行时版本（原计划随应用分发的 node.exe）属于交付阶段决策，届时可独立选择长期支持版本并重新核验，不在本 ADR 范围内预先固定。
- 若未来需要回到 Node 24 LTS（例如为对齐发布基线），通过新的 ADR 与 CI 双版本过渡执行，不在业务任务中顺手漂移。
