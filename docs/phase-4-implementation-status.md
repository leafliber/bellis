# Phase 4 当前实施状态

截至 2026-09-07，Phase 4A 的冻结恢复 Gate 已通过：8 个窗口 × 3 个目标 × 20 次，共 480/480。结论来自已有验收记录；文档整理不构成重新运行恢复矩阵。范围以 [ADR 0047](./adr/0047-phase4a-recovery-scope-freeze.md) 为准，Phase 4B 与整个 Phase 4 仍有未完成项。

## 安装与运行

冻结恢复证据使用 Core 0.13.0 / Schema 20、SDK 0.11.2，记录 178 个 Core 安装文件及 4 个 SDK 文件核验。精确安装物 SHA、命令和退出码见 [冻结摘要](./evidence/phase4a-recovery-scope-freeze.json)。支持范围只以实测安装组合为准；当前运行入口为 `pnpm start:iris`，配置、凭据和 readiness 见 [运行说明](./iris-runtime-operations.md)。

## Context、Persona 与工具

已接入可取消的 Context 构建、来源 hash/身份/隐私检查，以及 adoption 事务中的 Manifest 和 Usage Outbox。Persona/Provider 状态与宿主策略通过 DB Worker 持久化；外部失效先建立屏障并取消旧工作，再确认事件游标。工具保留原调用、原请求和幂等身份，实际发送前等待持久化，未知写结果不能自动变成成功。

边界与证据分别见 [Context 决策](./adr/0009-phase4-context-adoption.md)、[隐私事务](./adr/0013-phase4-memory-policy-transactions.md)、[工具注册](./adr/0017-phase4-iris-tool-registration.md)、[资源失效](./adr/0022-phase4-resource-invalidations.md) 和 [显式 Scope](./adr/0023-phase4-explicit-memory-scope.md)。

## 输入、实际输出与连续运行

可信输入在接纳事务内写独立 Observe 游标和 Outbox；输出仅记录可信 Stage 确认的片段，确认事实与 Observe 投影同事务提交。取消的未确认后半段不作为观察或下轮历史。远端 ACK 前保留交付责任，恢复不重播旧 Scene。

真实 Chromium、Runtime/DB Worker、已安装 SDK 与 Core 的 100 Cycle 连续链路已留有证据，见 [连续验收](./phase-4-continuous-validation.md)。Stage 效果事务另有两个 Runtime 崩溃窗口各 20 次的专项证据；这 40 次不能合并为冻结恢复矩阵的新覆盖，见 [Stage 专项](./adr/0046-phase4-stage-effect-crash-recovery.md)。

## 存储与历史恢复

已实现新工作磁盘准入、数据库页上限、WAL 写入拦截、连接级事务预算及持久 Scene 收尾额度，详见 [存储容量](./phase-4/storage-capacity.md)。这些逻辑预算不等于操作系统独占空间，也未证明完整 ENOSPC/旧备份矩阵。

历史缺口已有持久屏障、范围清单、原 Recall 请求存证、批量核验结论和 Runtime 维护状态。正式 SDK 已接入事件身份检查点；单批 valid 不解除缺口。全部事实覆盖、跨批次一致性与安全解除仍未完成，详见 [历史恢复](./phase-4/history-recovery.md)。

## 验收与剩余范围

| 验收 | 已有结果 | 证据 |
| --- | --- | --- |
| 冻结时根 `pnpm check` | 退出 0；1054 项单元/性质、275 项集成、168 个生成契约 | [收尾摘要](./evidence/phase4a-recovery-scope-freeze.json) |
| 冻结恢复 | Cycle/Usage 180、Observe HTTP 180、SSE 120；480/480 | [恢复摘要](./evidence/phase4a-frozen-recovery-summary.json) |
| 连续纵向 | 100 Cycle，真实 Chromium/Core | [连续验收](./phase-4-continuous-validation.md) |
| 快照与 Stage 扩展 | 仅已列出的专项路径通过 | [恢复说明](./phase-4-recovery-validation.md) |

活动 Stage 的额外 HTTP/SDK ACK 组合、容量/旧快照/cursor 扩展，以及 MCP、Presence/Avatar 等后续能力集中在 [Phase 4B 待办](./phase-4b-backlog.md)。其余细分 Gate 未经对应证据不得标记通过。

## 文档维护

本页按主题替换更新，不追加切片日志。早期检查计数、失败记录与当时的 `incomplete` 判定保留在 [归档实施历史](./archive/phase-4/implementation-history.md)。新验收用同主题摘要替换旧结果，原始逐次记录保存在 CI artifact；追溯规则见 [证据目录](./evidence/README.md)。
