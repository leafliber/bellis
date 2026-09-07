# ADR 0032：Claim 纠正的事务内失效通知

状态：Claim Correct 及其撤回级联已实现并验证；其他资源更新和完整历史重验仍开放。日期：2026-09-07。

Core 的公开 Claim Correct 原先提交新修订、水位及后台投影任务，但没有同时产生应用 SSE 失效事件。后台 Worker 停止时，Bellis 因而可能继续采用引用旧修订的 Context。现在 supersede、dispute 和 retract 在 Canonical 事务中写入 `revision.invalidated.v1`；事件引用前一个修订，使用新修订身份组成稳定 eventId，并携带同事务的水位及资源自身的 tenant、agent、space/group 范围。

retract 会使引用链失去证据。该事务中产生的下游 Claim 和 Relation 撤回也逐项写入事件，各自保留范围并只截止到旧修订。它们仍通过原 change job 更新后台投影。事件不是永久删除证明；Core 不为这些撤回新增删除 tombstone。Bellis 现有失效处理保存有限修订截止值、取消旧 Context，并在宿主 ACK 后推进 Provider 检查点。新修订不会仅因这个截止值被阻止；是否能 Recall 仍由资源当前状态及权限决定。

所有事件与原纠正、引用失效和级联修订一起提交。任意通知插入失败会回滚整条链；原幂等键可重试，成功结果重放不增加事件。六项专项测试覆盖三种模式、通知失败回滚、三级 Claim 引用与 Relation、不同空间和原键重试；合并相关 Correct、HTTP、公共契约、并发、Outbox、任务删除及旧级联回归共 202 项通过，类型与 Ruff 检查通过。

最终候选 Core 0.13.0 wheel SHA 为 `8b03aa2b65a98ddcaf3c5044d2ae2f9ad45a6094c2b5263171915c376e780646`，Schema 19，170 个安装文件核验。相对上一候选 Schema 18，Migration 19 只增加任务删除查询索引，应用 OpenAPI 全文一致。探针按精确 hash 单独接纳，默认 Provider 的 Schema 上限和 SDK 0.11.1 依赖保持现有配置；SDK 0.11.2 候选仅在隔离检查点探针使用。

真实安装测试停止 Core Worker 后调用公开 Correct，将茶偏好从修订 1 改为修订 2。Bellis 在 Worker 重启之前收到通知、取消原 Context 并持久保存截止修订 1；原键重放只有一个事件。Worker 恢复投影后，新的 Context 实际包含修订 2 和新文本，排除旧修订。Bellis DB Worker 再启动仍保留策略和检查点。联合删除、410 缺口屏障/范围清单、检查点身份及 Chromium 三轮输出回归通过。证据见 [纠正事件验证](../evidence/phase4-claim-correction-probe.json)。

这证明公开 Claim Correct 及其 Canonical 撤回级联的通知闭环，不证明所有 Claim 写入路径、其他资源的普通修改、实际旧备份恢复或全量公共重验。清单逐项权威结论、远端一致性和安全解除仍按 ADR 0031 继续实施；完整 A4 恢复、容量、生产授权与 Phase4B Gate 保持开放。
