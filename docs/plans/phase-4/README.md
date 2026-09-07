# Phase 4 构建指南

> 排期更新：本指南保留原 Phase 4 技术要求及章节编号，不能当作完整阶段已完成的证明。Phase 4A 保持冻结；Phase 4B 由 [直播线 L5–L7](../live/README.md) 承接，逐项对应见 [待办](./backlog.md)。后续工程顺序统一见 [双线路线图](../README.md)。

Phase 4A 接入 Iris 外部记忆；Phase 4B 承接主动表现和后续扩展。Phase 4A 恢复验收已按 [ADR 0047](../../adr/0047-phase4a-recovery-scope-freeze.md) 冻结并通过 480/480；这不表示整个 Phase 4 已完成。

本文是 Phase 4 原技术要求的查阅入口。已运行的验证和能力边界见 [当前实施状态](../../reference/phase-4-status.md)，安装、启动及凭据配置见 [Iris 运行说明](../../guides/iris-runtime.md)。不要把历史计划中的“尚未实现”或拟定接口当作当前代码状态，也不要从局部通过推导全部 Gate 完成。

## 按主题查阅

原长篇计划完整拆为以下分册，保留原 § 编号以便查找历史引用。

| 主题 | 原章节 | 内容 |
| --- | --- | --- |
| [范围与架构](./guide/scope.md) | §0–4、解释优先级 | A0–A4 工作包、不变量、依赖方向 |
| [契约与 Context](./guide/context.md) | §5–6 | Gate 0、贡献构建、快照屏障、预算和 Epoch |
| [Provider、Persona 与工具](./guide/memory.md) | §7–8 | 身份/隐私、公共 Iris 映射、受控工具 |
| [Observe、持久化与恢复](./guide/persistence.md) | §9 | 输入/实际输出事实、Outbox、ACK、Migration |
| [Stage 与主动表现](./guide/stage.md) | §10 | Avatar、Presence、抢占与协议（含后续目标） |
| [Runtime 装配与验收](./guide/acceptance.md) | §11–17 | Host、测试矩阵、Gate、指标、风险与交付要求 |

## 当前工作依据

- [构建与验收](../../guides/build-and-validation.md) 维护首次安装、构建顺序和 CI 覆盖。
- [连续验收](../../validation/iris-continuous.md) 与 [恢复验收](../../validation/iris-recovery.md) 维护可运行入口和实际覆盖。
- [存储容量](../../reference/phase-4/storage-capacity.md) 与 [历史恢复](../../reference/phase-4/history-recovery.md) 按主题整理已实现边界及历史决策来源。
- [Phase 4B 待办](./backlog.md) 维护冻结范围之外的未完成事项，不自动升级成 Phase 4A 前置条件。
- [ADR 索引](../../adr/README.md) 维护架构决策与归档关系；[证据规则](../../evidence/README.md) 规定摘要、原始 artifact 和历史追溯方式。

## 维护方式

当前状态按主题替换更新；构建分册只改相关设计和验收要求。逐轮测试输出、工作树状态、提交后停止等执行记录不继续追加到指南。历史过程已归档到 [实施历史](../../archive/phase-4/implementation-history.md)。只有跨包边界、协议、持久化兼容性或明确取舍发生变化时新增 ADR；一般实现进度写 PR，验收摘要更新已有主题证据。
