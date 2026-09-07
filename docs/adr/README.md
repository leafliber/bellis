# 架构决策索引

ADR 记录跨包职责、协议/持久化兼容性或需要长期解释的取舍，说明问题、决定、替代方案及影响。测试批次、wheel 更新和每轮进度写 PR 或更新主题摘要，不单独分配 ADR 编号。历史编号不重用，变更决策应显式说明替代关系。

## 当前决策

- [ADR 0001：Canonical Core and Wire Contracts](./0001-canonical-core-and-wire-contracts.md)
- [ADR 0002：开发与 CI 基线调整为 Node.js 26](./0002-node-26-baseline.md)
- [ADR 0003：Phase 2 演出 Wire 扩展与浏览器边界](./0003-phase-2-scene-wire-and-browser-boundary.md)
- [ADR 0004：Phase 3 决策边界——Signal 水位、Cycle Adoption 与恢复语义](./0004-phase-3-decision-boundaries.md)
- [ADR 0005：Memory Provider 插件缝与 Persona 归属——由外部记忆系统接管人格记忆](./0005-memory-provider-seam-and-persona-ownership.md)
- [ADR 0006：文档权威性、来源去重与 Phase 4 交付边界](./0006-documentation-and-delivery-boundaries.md)
- [ADR 0007：任务所有权、恢复事实与当前能力收敛](./0007-task-ownership-and-runtime-scope.md)
- [ADR 0008：Phase 4 Iris 接入与来源校验](./0008-iris-phase4-integration.md)
- [ADR 0009：Phase 4 Context 采用与 Iris 摘要兼容](./0009-phase4-context-adoption.md)
- [ADR 0010：Phase 4 输入观察与独立游标](./0010-phase4-input-observation-ledger.md)
- [ADR 0011：Phase 4 输出语义片段与渲染确认](./0011-phase4-output-segment-confirmation.md)
- [ADR 0012：Provider 状态与 Persona 持久读屏障](./0012-phase4-provider-state-and-persona-barriers.md)
- [ADR 0013：Memory 隐私版本与回写事务屏障](./0013-phase4-memory-policy-transactions.md)
- [ADR 0014：原始工具调用恢复与 Session 所有权](./0014-phase4-original-tool-calls-and-session-ownership.md)
- [ADR 0015：Iris 工具公共传输与未知写结果](./0015-phase4-iris-tool-transport-outcomes.md)
- [ADR 0016：可信工具实际请求的持久化与确认](./0016-phase4-prepared-tool-requests.md)
- [ADR 0017：Iris 四工具注册与可信宿主授权端口](./0017-phase4-iris-tool-registration.md)
- [ADR 0018：Forget 屏障、回执与 tombstone 的持久协调](./0018-phase4-forget-coordination.md)
- [ADR 0019：Core 0.13 搜索初始化与独立安装验收](./0019-phase4-core13-search-initialization.md)
- [ADR 0020：Iris 写目标预览与确认后核验](./0020-phase4-iris-tool-target-verification.md)
- [ADR 0021：待消费 Signal 与 Tool Result 的隐私版本](./0021-phase4-local-input-privacy.md)
- [ADR 0022：公共资源失效的持久接收与宿主确认](./0022-phase4-resource-invalidations.md)
- [ADR 0023：显式 Space scope 与启动期 Session 归属](./0023-phase4-explicit-memory-scope.md)
- [ADR 0041：Iris 启动配置与凭据引用](./0041-phase4-iris-launch-configuration.md)
- [ADR 0042：记忆屏障与 Runtime readiness](./0042-phase4-memory-readiness.md)
- [ADR 0043：凭据轮换与原事实恢复](./0043-phase4-credential-rotation.md)
- [ADR 0044：正式安装物与检查点请求对齐](./0044-phase4-installed-checkpoint-sdk.md)
- [ADR 0045：两端旧快照与事件分叉验收](./0045-phase4-core-snapshot-restore.md)
- [ADR 0046：真实 Stage 效果事务崩溃恢复](./0046-phase4-stage-effect-crash-recovery.md)
- [ADR 0047：Phase 4A 恢复验收范围冻结](./0047-phase4a-recovery-scope-freeze.md)

## 合并查阅的历史记录

原 0024–0028 的容量增量与 0029–0040 的历史恢复增量含有真实约束及大量切片验收记录，原文移至 [归档](../archive/phase-4/README.md)。按 [存储容量](../phase-4/storage-capacity.md) 和 [历史恢复](../phase-4/history-recovery.md) 查阅现行边界；归档不撤销原决定。其他 Phase 4 ADR 涉及独立边界或显式范围决定，继续保留。
