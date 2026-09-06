# Bellis 文档索引

本文档目录按“长期设计、阶段实施、稳定协议、架构决策”四类维护。已交付能力以完成态参考和稳定协议为当前入口；Phase 2/3 开发指南保留为历史实施计划，不作为已通过全部 Gate 的证明。当前实现与待验收项集中见 [构建与验收状态](./build-and-validation.md)。

## 当前入口

- [系统架构设计](./architecture-plan.md)：产品能力、领域模型和长期里程碑。
- [技术选型基线](./technology-selection.md)：运行时、前端、存储、插件与发布技术栈。
- [Phase 1 完成态参考](./phase-1-reference.md)：已经交付的基础协议、公开入口、验收证据和后续兼容边界。
- [Phase 2 开发指南](./phase-2-development-guide.md)：阶段“演出纵向链路”的范围、工作包、Gate 和原定验收方式（历史计划）。
- [Phase 2 完成态参考](./phase-2-reference.md)：Phase 2 交付形态、验收证据与已知边界。
- [Phase 3 开发指南](./phase-3-development-guide.md)：阶段“Decision Loop”的范围、工作包、Gate 和原定验收方式（历史计划）。
- [Phase 3 完成态参考](./phase-3-reference.md)：Phase 3 交付形态、验收证据与已知边界。
- [Phase 4 构建指南](./phase-4-development-guide.md)：阶段“记忆与主动表现”的范围、工作包、Gate 和验收方式（待实施）。

## 稳定协议

- [Control WebSocket](./protocols/control-websocket.md)
- [Binary Media WebSocket](./protocols/binary-media-websocket.md)
- [Persistence & Recovery](./protocols/persistence-and-recovery.md)
- [Scene Execution](./protocols/scene-execution.md)

协议文档只描述已经实现并受测试保护的行为。当前阶段尚未完成的扩展只记录在开发指南中；通过 Contracts Gate、实现和协议一致性测试后，才写入稳定协议文档。

## 架构决策

- [ADR 0001：Canonical Core and Wire Contracts](./adr/0001-canonical-core-and-wire-contracts.md)
- [ADR 0002：Node.js 26 基线](./adr/0002-node-26-baseline.md)
- [ADR 0003：Phase 2 Scene Wire and Browser Boundary](./adr/0003-phase-2-scene-wire-and-browser-boundary.md)
- [ADR 0004：Phase 3 决策边界](./adr/0004-phase-3-decision-boundaries.md)
- [ADR 0005：Memory Provider 插件缝与 Persona 归属](./adr/0005-memory-provider-seam-and-persona-ownership.md)
- [ADR 0006：文档权威性、来源去重与 Phase 4 交付边界](./adr/0006-documentation-and-delivery-boundaries.md)

新增或改变冻结边界时创建新 ADR，不回写历史 ADR 的原始决策来掩盖变化。

## 文档维护规则

1. `architecture-plan.md` 回答“系统最终是什么”，不承载具体分支和任务安排。
2. `technology-selection.md` 回答“采用什么技术与为什么”，版本漂移通过独立变更更新。
3. 当前阶段开发指南回答“下一步如何实现和验收”；交付事实集中在完成态参考，历史计划明确标记归档，未通过的 Gate 不得标为完成。
4. `protocols/` 只记录已经冻结且由契约/实现测试覆盖的协议。
5. `adr/` 记录不可逆或跨包决策，包括替代关系和兼容影响。
6. 文档中的命令必须能从仓库根目录运行；规划中的新命令要明确标为阶段交付项。首次安装、构建顺序和 CI 覆盖以 `build-and-validation.md` 为准。
