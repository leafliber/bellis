# 脚本入口

所有公开命令从仓库根目录运行，`package.json` 中的命令名保持稳定。

| 目录/文件 | 职责 | 入口 |
| --- | --- | --- |
| `iris/` | Iris 公共边界探针、恢复子进程、安装物核验、Cycle 审计 | `pnpm test:memory:iris` 及其专项命令 |
| `demos/` | Phase 1–4 Demo、Stage 测试宿主与 Phase 2 崩溃演示 | `pnpm demo:phase1`、`pnpm test:acceptance` |
| `evidence/` | 原始报告摘要化与证据预算检查 | `pnpm evidence:check` |
| `test/` | Harness 与摘要生成器的测试 | `pnpm test:scripts` |
| `workers/` | Node/SQLite 运行基线 Worker | `pnpm runtime:check` |
| `start-iris-runtime.mjs` | 正常运行入口 | `pnpm start:iris` |
| `check-generated-contracts.mjs`、`verify-runtime-baseline.mjs` | 仓库级检查 | `pnpm contracts:check`、`pnpm runtime:check` |

逐次报告归属与保留方式见 [证据规则](../docs/evidence/README.md)。
