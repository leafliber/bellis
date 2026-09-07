# 验收证据

仓库保存可审阅的摘要：命令、环境/安装物版本与哈希、退出码、实际覆盖、限制及原报告来源。逐次 results/cases、Cycle 审计、Observation 身份和浏览器诊断保存到被忽略的 `artifacts/evidence/`、`test-results/` 或 `playwright-report/`，CI 通过 artifact 上传，保留 14 天。

## 当前入口

- [Phase 4A 冻结结论](./phase4a-recovery-scope-freeze.json)：根检查及 480/480 恢复结果。
- [冻结恢复摘要](./phase4a-frozen-recovery-summary.json)：各窗口/目标的记录数与重复次数。
- [连续 100 Cycle 摘要](./phase4-continuous-core-probe.json)。
- [当前能力与证据导航](../reference/phase-4-status.md)。

## 生成与维护

从仓库根目录执行；真实 Core 必须是单独安装并通过探针来源校验的环境：

```sh
IRIS_CORE_PYTHON=/absolute/isolated-venv/bin/python \
IRIS_PROBE_REPORT=artifacts/evidence/iris-probe-raw.json \
pnpm test:memory:iris:recovery
node scripts/evidence/summarize-report.mjs \
  artifacts/evidence/iris-probe-raw.json \
  docs/evidence/phase4-current-recovery-probe.json
pnpm evidence:check
```

CLI 的可选第三参数是实际 CI artifact URL；没有上传就不填写。Probe 默认也写到 `artifacts/evidence/iris-probe-raw.json`，需要保留多次本地运行时显式指定不同路径。失败可能发生在完整报告生成前，应同时保留测试诊断；只有真实退出码和报告才能支持验收结论。现有 CI 未配置独立 Core，上传步骤不表示真实 Iris Gate 已在 CI 运行。

优先更新同主题摘要，替代的执行结果由 Git 历史和 artifact 追溯，不按每个切片另建永久文件。`pnpm check` 检查每个 JSON ≤32 KiB、目录 JSON 总量 ≤1 MiB，禁止 `*-raw.json` 和逐次对象数组进入证据目录，并禁止跟踪生成目录。新增主题需要在预算内替换已被覆盖的摘要。摘要中的记录数不自行证明成功；保留原始 status、casesPassed、scope 和未完成项。

## 历史原始记录

2026-09-07 整理前的原始报告已经存在于 Git 历史，不为迁移重新上传或伪造 artifact 链接。压缩后的 `rawReportSource` 保存原 blob 的 `gitRevision`、`path`、字节数和 SHA-256；旧摘要中的 `rawReport` 等引用也补有历史 revision 与摘要路径。例如：

```sh
git show 89ac917daf02f40844e009a5fd7ed3d05cbbacca:docs/evidence/phase4a-frozen-recovery-raw.json > /tmp/phase4a-frozen-recovery-raw.json
```

本次工作区还在 `artifacts/evidence/history/` 留有被替换原始文件的本地副本；新克隆不包含这些副本。未压缩摘要内的 `sourceSha256`、日志路径和执行命令保持当时含义，不是对当前脚本路径或当前工作树的重新校验。历史 Git 对象不做重写，故 `.git` 大小不会随这次清理立即下降。
