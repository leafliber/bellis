# Bellis 文档索引

> 2026-09-06 架构审查修订：任务所有权、工具恢复事实、调用列表范围、场景终态、Seq 分段预留及 Provider 接缝以 [ADR 0007](./adr/0007-task-ownership-and-runtime-scope.md) 为准。

本文档目录按“长期设计、阶段实施、稳定协议、架构决策”四类维护。已交付能力以完成态参考和稳定协议为当前入口；Phase 2/3 开发指南保留为历史实施计划，不作为已通过全部 Gate 的证明。当前实现与待验收项集中见 [构建与验收状态](./build-and-validation.md)。

## 当前入口

- [系统架构设计](./architecture-plan.md)：产品能力、领域模型和长期里程碑。
- [技术选型基线](./technology-selection.md)：运行时、前端、存储、插件与发布技术栈。
- [Phase 1 完成态参考](./phase-1-reference.md)：已经交付的基础协议、公开入口、验收证据和后续兼容边界。
- [Phase 2 开发指南](./phase-2-development-guide.md)：阶段“演出纵向链路”的范围、工作包、Gate 和原定验收方式（历史计划）。
- [Phase 2 完成态参考](./phase-2-reference.md)：Phase 2 交付形态、验收证据与已知边界。
- [Phase 3 开发指南](./phase-3-development-guide.md)：阶段“Decision Loop”的范围、工作包、Gate 和原定验收方式（历史计划）。
- [Phase 3 完成态参考](./phase-3-reference.md)：Phase 3 交付形态、验收证据与已知边界。
- [Phase 4 构建指南](./phase-4-development-guide.md)：先完成 Phase 4A Iris 真实接入，再推进 Phase 4B 主动表现与扩展；按主题分册维护 A0–A4 工作包、接口映射与验收（实施中，见 [实施记录](./phase-4-implementation-status.md)）。
- [Phase 4 Iris 接入调研](./phase-4-iris-integration-research.md)：两仓库当前能力、契约差异、职责归属及本轮针对性验证。

## 稳定协议

- [Control WebSocket](./protocols/control-websocket.md)
- [Binary Media WebSocket](./protocols/binary-media-websocket.md)
- [Persistence & Recovery](./protocols/persistence-and-recovery.md)
- [Scene Execution](./protocols/scene-execution.md)

协议文档只描述已经实现并受测试保护的行为。当前阶段尚未完成的扩展只记录在开发指南中；通过 Contracts Gate、实现和协议一致性测试后，才写入稳定协议文档。

## 架构决策与历史

- [ADR 索引](./adr/README.md)：按编号查找架构决定、兼容性与归档关系。
- [Phase 4 存储容量](./phase-4/storage-capacity.md)、[历史恢复](./phase-4/history-recovery.md)：同主题的现行边界及历史依据。
- [Phase 4 当前实施状态](./phase-4-implementation-status.md)：主题状态与证据入口。
- [Phase 4 归档](./archive/phase-4/README.md)：冻结的切片历史。
- [证据维护规则](./evidence/README.md)：仓库只留有界摘要，逐次结果归 CI artifact。

## 文档维护规则

1. `architecture-plan.md` 回答“系统最终是什么”，不承载具体分支和任务安排。
2. `technology-selection.md` 回答“采用什么技术与为什么”，版本漂移通过独立变更更新。
3. 当前阶段开发指南回答“下一步如何实现和验收”；交付事实集中在完成态参考，历史计划明确标记归档，未通过的 Gate 不得标为完成。
4. `protocols/` 只记录已经冻结且由契约/实现测试覆盖的协议。
5. `adr/` 记录不可逆或跨包决策，包括替代关系和兼容影响。
6. 文档中的命令必须能从仓库根目录运行；规划中的新命令要明确标为阶段交付项。首次安装、构建顺序和 CI 覆盖以 `build-and-validation.md` 为准。

- [Phase 4 真实连续纵向验收：100 Cycle](./phase-4-continuous-validation.md)

- [Phase 4 真实进程恢复验收](./phase-4-recovery-validation.md)
