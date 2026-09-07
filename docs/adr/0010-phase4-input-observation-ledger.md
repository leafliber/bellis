# ADR 0010：Phase 4 输入观察与独立游标

状态：A2 输入侧实施；2026-09-06。服从 ADR 0007/0008；输出片段回执尚未实施。

## 可信输入边界

`Phase4MemoryOptions.observeInput` 是可信输入适配器的映射函数，不是模型工具或 Stage 消息。它显式提供已解析的 Core `actorExternalIdentityId`、被接纳的正文、role 和输入隐私标签；未配置或返回 null 的控制、开发与合成输入不生成 Observe。输入标签独立于公开输出的 `publicLabels`。显示名或 Signal 中未经验证的身份字段不能用于创建、绑定身份。

Core 的可信离线 `init --actor-provider ... --actor-subject ...` 原先已创建并验证身份；现在在初始化 JSON 和 0600 credential 文件中增量返回 `actor_external_identity_id`。未指定 actor 时不返回此键，不改变凭据权限。Bellis 探针通过这个公开入口取得 ID；不读取 Core 私有数据库。

## 原子输入接纳

`phase3_append_signal` 增加可选 observations，旧调用保持兼容。单 DB Worker 事务完成 Signal 接纳、每 Provider 观察事实、独立 sourceCursor 分配和 `memory.observe.v1` Outbox。Signal 去重仍是 `(sessionId, source, signal.id)`；重复输入保留首次事实，即使后续请求携带不同映射也不改写、不追加第二份观察。输入容量拒绝或任何观察校验/写入失败时，Signal 和游标一起回滚。

Migration 7 新增 `phase4_observe_streams` 和 `phase4_observations`。事实保留 event JSON、SHA-256、事实去重键、eventId/outboxId、来源游标与独立 ACK 时间。游标从 1 连续分配，使用十进制 TEXT 与 bigint，Core 边界上限为 18 位；不复用 ControlSeq、Signal sequence 或 SSE eventCursor。

sourceStream 由 app/agent/space、Bellis Session、身份范围、隐私版本、Signal source 的 SHA-256 构成。不同 Provider/agent/stream 独立推进。事件 ID 和 Outbox ID 在接纳事务内生成；重试只重发首次持久化内容。

## 投递、容量与恢复

Claim 对 `memory.observe.v1` 只领取各 partition 最早的未完成项。pending 退避、其他 Dispatcher 的 in-flight Lease 和 dead letter 都阻止同流后续项越过；其他流仍可领取。仅在 Provider 获得远端持久接收后，DB Worker 才在同一事务内完成 Outbox 并记录该事件 ACK。最大远端游标从不用于批量假定本地事件已经送达。

当前输入待确认容量固定为 10,000 项和 16 MiB 正文账本预算，dead letter 同样计入；超过预算以可重试的容量错误拒绝输入事务。输出侧的活动效果保留容量、全局磁盘配额、历史整理与显式修复入口仍需后续完成。

Iris 每批最多 100 项，批次幂等键以有序 Outbox ID 列表的 SHA-256 生成。ACK 必须覆盖全部事件且远端观察 ID 唯一，才允许成功返回。宿主目前每流每次发送一项，远端 ACK 与本地 ACK 之间中断时重发相同键；本地不使用第二个内存队列代替持久接收。

## 已验证与未完成

真实 DB Worker 测试覆盖去重、无观察输入后的独立游标、跨流 Claim、错误 Lease 持有者、dead letter 阻塞、事务回滚和重启重发。真实安装探针证明可信 user 输入经宿主 Outbox 获得 Core ACK，再次发送原事件仍成功；这是重发测试，不冒充进程崩溃矩阵。

Stage 片段计划/回执、效果与 Observe 原子事务、连续 ACK/remote cursor 对账接口、确认 Conversation、A3 持久失效屏障、A4 每窗口 20 次与 100 Cycle 验收仍开放。Scene commit、started、finished、音频收包或入队均不能替代真实输出确认。
