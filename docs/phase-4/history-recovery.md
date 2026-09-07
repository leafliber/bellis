# Phase 4 历史恢复

本页按恢复流程整理原 ADR 0029–0040；每轮版本、命令、测试计数和过程性缺口保留在 [历史决策归档](../archive/phase-4/README.md)。原编号与原决策继续可追溯，后续正式 SDK 接入以 [ADR 0044](../adr/0044-phase4-installed-checkpoint-sdk.md) 为准。

## 按职责查阅

| 职责 | 已实现边界 | 历史依据 |
| --- | --- | --- |
| 事件检查点 | 绑定事件身份与游标；过滤后的数字不连续不等于丢失历史 | [0029](../archive/phase-4/decisions/0029-phase4-event-checkpoint-identity.md) |
| 缺口屏障 | 先停止旧 Context/投递/活动效果，再持久确认；重启保持屏障，不把未知历史直接当成删除 | [0030](../archive/phase-4/decisions/0030-phase4-history-gap-barrier.md) |
| 固定范围 | 清单绑定 scope/provider、gap、策略代际及来源摘要，分页完成不表示核验完成 | [0031](../archive/phase-4/decisions/0031-phase4-history-revalidation-inventory.md) |
| 纠正通知 | Core Canonical 事务内产生旧修订失效事件，保留范围，区别于永久删除 | [0032](../archive/phase-4/decisions/0032-phase4-claim-correction-events.md) |
| 公开读取保护 | Recall 发布和原请求重放核验候选、Persona、修订和授权 | [0033](../archive/phase-4/decisions/0033-phase4-recall-replay-revalidation.md) |
| 批量核验 | 只读接口每批核验 1–16 个完整原请求，返回 valid/unavailable；结论仅覆盖同批读取快照 | [0034](../archive/phase-4/decisions/0034-phase4-recall-batch-revalidation.md) |
| 原请求存证 | SDK 发送前等待实际请求持久化，不从 Manifest 摘要伪造旧请求 | [0035](../archive/phase-4/decisions/0035-phase4-original-recall-requests.md) |
| 结论持久化 | 批次、清单摘要及逐项原请求身份原子保存，重启保留去重与覆盖进度 | [0036](../archive/phase-4/decisions/0036-phase4-history-verification-records.md) |
| 独立调度 | 维护 Verifier 与已停止的普通 Provider 生命周期分离，发送前核验策略与身份 | [0037](../archive/phase-4/decisions/0037-phase4-recall-revalidation-coordinator.md) |
| 恢复发现 | 从持久缺口/清单发现原 runId，并绑定宿主取消，不自动替换旧代际清单 | [0038](../archive/phase-4/decisions/0038-phase4-history-recovery-discovery.md) |
| 后台维护 | 每 Provider 单一 worker；每轮结束后等待间隔，取消后保留实际在途责任 | [0039](../archive/phase-4/decisions/0039-phase4-background-history-recovery.md) |
| Runtime 装配 | 持久缺口进入维护状态，live 200、ready 503；停止决策与普通投递，后台核验继续 | [0040](../archive/phase-4/decisions/0040-phase4-runtime-history-recovery.md) |

## 当前限制与证据

当前恢复只核验已支持范围内的原 Recall 请求。原 Observation/Usage 等全部事实、跨批次一致性、旧代际重新授权、远端权限变化完整覆盖与安全原子解除仍未完成。单批 valid、连通恢复、空 SSE 或最大 source cursor 都不能解除宿主缺口。维护状态在当前宿主生命周期内保持，没有公开强制解除入口。

Runtime 的启动发现、运行期缺口、重启、取消和错误清理证据见 [装配摘要](../evidence/phase4-runtime-history-recovery-probe.json)。正式 SDK 检查点与快照路径分别见 [ADR 0044](../adr/0044-phase4-installed-checkpoint-sdk.md)、[ADR 0045](../adr/0045-phase4-core-snapshot-restore.md)。早期记录中的 `incomplete` 和旧默认 Schema 是当时的事实；冻结恢复范围以 [ADR 0047](../adr/0047-phase4a-recovery-scope-freeze.md) 为准，其余工作见 [Phase 4B 待办](../phase-4b-backlog.md)。
