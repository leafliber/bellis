# ADR 0047：Phase 4A 恢复验收范围冻结

状态：已接受。日期：2026-09-07。决定来源：用户明确要求停止继续切片，冻结既有恢复范围并完成检查、提交和收尾。

Phase 4A 的恢复 Gate 固定为以下八个窗口，目标为 Bellis Runtime、Core API、Core Worker，每组合 20 次：

| 系列 | 窗口 | 用例数 |
| --- | --- | --- |
| Cycle/Usage | Manifest 形成/adoption 前；adoption 后/Usage ACK 前；Usage ACK 后/宿主 delivered 前 | 180 |
| Observe | Observe 已持久化/HTTP 发布前；Core 已提交/ACK 未转发；SDK 已确认/宿主 delivered 前 | 180 |
| SSE | pending-persisted-before-host-ack；policy-committed-before-provider-cursor | 120 |

这是一次显式的范围冻结决定，冻结时已有 480/480 通过的证据，见 [固定安装物恢复原始报告摘要](../evidence/phase4-installed-sdk-full-recovery-summary.json)。不删除用例、不修改断言、不跳过组合、不降低 repetitions。

顶层聚合此前将 `status` 固定写成 `incomplete`，使所有用例通过后入口仍退出 2。现在计算 `expectedCases = coveredWindows.length × targets.length × repetitions`，并比较实际 `casesPassed`。达到 `requiredRepetitions=20` 且计数完全一致才返回 `covered-windows-passed`；完整执行但次数不足仅为 `smoke-passed`，不算正式 Gate 通过；计数不符仍为 `incomplete`。原有断言失败退出 1、缺少 Core 安装路径退出 2 并报告 NOT RUN 的语义保留。

原聚合 `remaining` 数组与恢复说明「仍需完成」一节整体移入 [Phase 4B 待办](../phase-4b-backlog.md)。Stage 效果耦合、额外崩溃组合、旧快照/cursor 扩展、磁盘/WAL 与活动 Scene 配额等不再作为 Phase 4A 恢复 Gate 的前置条件，也不因此宣称它们已完成。

本次收尾顺序：先提交全部工作树 WIP；修正聚合和范围文档；运行完整 `pnpm check` 与 `pnpm test:memory:iris:recovery`；两者退出 0 后提交全部改动并停止。既有其他 Phase 4 文档保留历史事实，遇到恢复范围冲突以本决定为准。本次收尾完成不表示 Phase 4B 已完成，也不自动开始新的切片。


本次实际执行结果：完整 `pnpm check` 退出 0；`pnpm test:memory:iris:recovery` 退出 0，24 个组合各 20 次、480/480，顶层返回 `covered-windows-passed`。WIP 提交为 `08bb567`，详见 [验收摘要](../evidence/phase4a-recovery-scope-freeze.json) 与 [原始报告摘要](../evidence/phase4a-frozen-recovery-summary.json)。按用户要求提交收尾改动后停止。
