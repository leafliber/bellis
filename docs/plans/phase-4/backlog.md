# Phase 4B 待办：迁出的恢复与容量工作

2026-09-07 根据用户明确指令及 [ADR 0047](../../adr/0047-phase4a-recovery-scope-freeze.md)，Phase 4A 恢复验收冻结为 8 个窗口 × 3 个目标 × 20 次，冻结时已通过 480/480。下列工作从 Phase 4A 恢复 Gate 整体迁入 Phase 4B，不再决定 `test:memory:iris:recovery` 的通过状态。本页保留原始范围，执行按下表分配到直播线；截至本次文档修订仍未全部完成。

原 `scripts/iris/iris-recovery-probe.mjs` 的 `remaining` 五项保留如下：

- Inside-adoption transaction rollback and complete Stage effect crash coupling
- effect record/Observe projection transaction before and after commit
- Active Stage output confirmation and effect projection crash coupling
- both-side older snapshots and all cursor divergence cases
- disk/WAL quotas, active-scene reserved capacity and full Runtime/Stage recovery

原恢复说明「仍需完成」一节的范围一并迁入：采用事务内部中断、效果记录/Observe 投影事务前后、全部旧快照组合与 cursor 偏差、磁盘/WAL 配额与活动 Scene 预留、Stage 效果恢复。已有六个快照场景、Stage 事务和其他专项证据继续保留，后续按具体范围复用；它们不增加或减少冻结的 480 例。

Stage 的新增崩溃组合、容量及 cursor 场景均归本待办；原多 Provider、MCP、Presence/Avatar 技术要求保留在 [分册](./README.md)。后续排期由 [双线路线图](../README.md) 统一维护。

## 执行承接与关闭条件

| 原始范围 | 承接 | 当前状态 / 关闭条件 |
| --- | --- | --- |
| Avatar Mixer / Presence / Stage 装配 | L5.2、L6.2、L7.2 | 待完成；真实资源、抢占/释放/重连与策略各有证据 |
| 多 Provider / MCP | L7.1 | 待完成；真实选定组合与超时/权限/来源隔离通过 |
| adoption、effect/Observe 事务和活动 Stage 崩溃耦合 | L6.3，剩余组合 L7.3 | 已有专项仅按对应证据复用；L6 开工冻结 J6 必需集合，L7 前完成剩余命名集合 |
| 双方旧快照、cursor 偏差与历史安全解除 | L6.3、L7.3 | 已有屏障/重验，不等于全部恢复；未证明可解除时保持封锁，L7 关闭剩余范围 |
| 磁盘/WAL 配额、活动 Scene 预留、完整恢复 | L6.3、L7.3 | 已有逻辑预算；补关键收尾、压力故障与完整矩阵证据，不能把预算等同物理预留 |

各项细化时引用原窗口/目标/次数与已有报告，列出复用和新增部分；修改范围要显式记录理由，不能用无限组合延长任务，也不能静默删掉未通过项。新证据使用独立主题，不改变 ADR 0047 的 480 例判定。完整 Phase 4 只有全部原定 Gate 关闭后才完成。
