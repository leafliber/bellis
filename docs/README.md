# Bellis 文档索引

本文档目录按“长期设计、阶段实施、稳定协议、架构决策”四类维护。阶段任务完成后，不再保留分支、文件所有权和 Agent 提示等临时执行文档；只保留完成态参考。

## 当前入口

- [系统架构设计](./architecture-plan.md)：产品能力、领域模型和长期里程碑。
- [技术选型基线](./technology-selection.md)：运行时、前端、存储、插件与发布技术栈。
- [Phase 1 完成态参考](./phase-1-reference.md)：已经交付的基础协议、公开入口、验收证据和后续兼容边界。
- [Phase 2 开发指南](./phase-2-development-guide.md)：阶段“演出纵向链路”的范围、工作包、Gate 和验收方式（完成态）。
- [Phase 2 完成态参考](./phase-2-reference.md)：Phase 2 交付形态、验收证据与已知边界。
- [Phase 3 开发指南](./phase-3-development-guide.md)：当前阶段“Decision Loop”的范围、工作包、Gate 和验收方式。

## 稳定协议

- [Control WebSocket](./protocols/control-websocket.md)
- [Binary Media WebSocket](./protocols/binary-media-websocket.md)
- [Persistence & Recovery](./protocols/persistence-and-recovery.md)

协议文档只描述已经实现并受测试保护的行为。当前阶段尚未完成的扩展只记录在开发指南中；通过 Contracts Gate、实现和协议一致性测试后，才写入稳定协议文档。

## 架构决策

- [ADR 0001：Canonical Core and Wire Contracts](./adr/0001-canonical-core-and-wire-contracts.md)
- [ADR 0002：Node.js 26 基线](./adr/0002-node-26-baseline.md)
- [ADR 0003：Phase 2 Scene Wire and Browser Boundary](./adr/0003-phase-2-scene-wire-and-browser-boundary.md)

新增或改变冻结边界时创建新 ADR，不回写历史 ADR 的原始决策来掩盖变化。

## 文档维护规则

1. `architecture-plan.md` 回答“系统最终是什么”，不承载具体分支和任务安排。
2. `technology-selection.md` 回答“采用什么技术与为什么”，版本漂移通过独立变更更新。
3. 当前阶段开发指南回答“下一步如何实现和验收”；完成后压缩为一个完成态参考。
4. `protocols/` 只记录已经冻结且由契约/实现测试覆盖的协议。
5. `adr/` 记录不可逆或跨包决策，包括替代关系和兼容影响。
6. 文档中的命令必须能从仓库根目录运行；规划中的新命令要明确标为阶段交付项。
