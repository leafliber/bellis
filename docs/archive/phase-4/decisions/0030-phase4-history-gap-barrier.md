# ADR 0030：历史缺口的宿主持久屏障

状态：宿主持久屏障、Provider 对 410 的报告与恢复已实现并验证；正式检查点请求、重验与解除协议尚未完成。日期：2026-09-07。

SSE 历史无法核验时，宿主需要拒绝旧 Context、采用和新交付，但不能把尚未判定失效的 Outbox 当成已删除内容。此状态与已知 Forget/tombstone 分开保存。

Migration 17 为每个 scope/provider 保存一个有界、幂等的历史缺口记录。Provider 通过可信生命周期 Port 报告原游标、可选原事件身份、缺口身份和原因。宿主先建立内存屏障、取消查询及交付并停止活动效果，再确认持久屏障；失败保留内存屏障，原请求可重试。重启从数据库读取屏障后仍拒绝采用。

策略读取在有未解决缺口时返回 blocked 与 historyBlocked；historyBlocked 是可选扩展，无屏障时保持原快照形状。Outbox Claim 跳过受影响的 Memory 行，已经在途的失败不增加重试次数或成为死信，原键与正文保留，失败在途行退回 pending；不会仅因缺口转为 dead。已取得可信远端 ACK 的完成事务仍可记录既有事实，不将中断解释为远端回滚。

已经通过原 Session、Scene、Segment、连接代际和内容校验的实际效果，仍在同事务保存确认事实及待投递观察；仅跳过未知历史阻塞，继续检查真实隐私状态、策略代际和 tombstone。新准备和新采用没有此例外。

本增量不提供无条件清除屏障接口。后续必须通过公开 Core 读取重验保存的资源及交付血缘，处理失效事实并建立新的 Context 代际后才能解除；不能以进程重启、普通策略修改或重新连通替代重验完成。完整历史缺口 Gate 保持未完成。

验证：根检查通过 1040 项单元/性质测试、250 项集成测试和 162 个生成契约；独立 Provider 82 项、类型检查与构建通过。新增三项 DB Worker 集成测试覆盖不可变 Outbox、断档后实际确认、重启、原 ACK、真实隐私撤销、失败回滚与其他 scope；宿主测试覆盖来源验证、取消、持久化失败及等待效果停止后 ACK。见 [本轮证据](../../../evidence/phase4-history-barrier-probe.json)。

Provider 接入：仅事件请求的 `IrisBoundaryError(code=history_unavailable,status=410)` 建立缺口；其他 HTTP 错误不伪造缺口。协商支持 `events.checkpoint.v1` 的 Core 遇到只有正游标、没有事件身份的旧状态时，在 Persona/SSE 读取前保存 `checkpoint_missing`。缺口保存完整原检查点及稳定 gapId，解析恢复状态时要求它与保存的游标/身份一致。

Provider 建立内存暂停后，同时尝试保存自身状态和调用宿主，以使本地状态存储失败时仍能立即安装宿主屏障。两项都成功才停止重试通知；任一失败保留原缺口，只重试相同通知，不再请求新的 SSE。宿主 ACK 不清除 Provider 缺口，重启重新报告并拒绝启动读路径；已缓存 Persona、静态兜底、Recall、Observe、Usage 和旧投递队列均不能越过屏障。stop 等待本次事件轮询退出。

接入验证：Provider 89 项测试及类型、lint、格式、构建通过；真实候选 SDK/Core 410 → Provider → MemoryHost/DB Worker 验证了旧 Context 取消、原 Usage 不变以及 Worker 重启后的双侧屏障。探针主动写入了分歧事件身份，不能作为实际旧 Core 备份恢复的证明。默认 SDK 仍为 0.11.1，正式成对请求待依赖发布授权与升级；全量重验及解除协议仍待完成。见 [Provider 接入证据](../../../evidence/phase4-provider-history-gap-probe.json)。
