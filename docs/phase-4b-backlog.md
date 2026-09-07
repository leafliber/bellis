# Phase 4B 待办：迁出的恢复与容量工作

2026-09-07 根据用户明确指令及 [ADR 0047](./adr/0047-phase4a-recovery-scope-freeze.md)，Phase 4A 恢复验收冻结为 8 个窗口 × 3 个目标 × 20 次，冻结时已通过 480/480。下列工作从 Phase 4A 恢复 Gate 整体迁入 Phase 4B，不再决定 `test:memory:iris:recovery` 的通过状态。本次收尾不实施这些待办。

原 `scripts/iris-recovery-probe.mjs` 的 `remaining` 五项保留如下：

- Inside-adoption transaction rollback and complete Stage effect crash coupling
- effect record/Observe projection transaction before and after commit
- Active Stage output confirmation and effect projection crash coupling
- both-side older snapshots and all cursor divergence cases
- disk/WAL quotas, active-scene reserved capacity and full Runtime/Stage recovery

原恢复说明「仍需完成」一节的范围一并迁入：采用事务内部中断、效果记录/Observe 投影事务前后、全部旧快照组合与 cursor 偏差、磁盘/WAL 配额与活动 Scene 预留、Stage 效果恢复。已有六个快照场景、Stage 事务和其他专项证据继续保留，后续按具体范围复用；它们不增加或减少冻结的 480 例。

Stage 的新增崩溃组合、容量及 cursor 场景均归本待办。Phase 4B 原有多 Provider、MCP、Presence/Avatar 目标仍按构建指南执行，完成本次收尾不自动启动 Phase 4B。
