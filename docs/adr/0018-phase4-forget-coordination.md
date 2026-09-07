# ADR 0018：Forget 屏障、回执与 tombstone 的持久协调

状态：宿主协调事务与真实 Core 单目标删除已实施；Legal Hold/保护对象实测和完整恢复矩阵仍开放。日期：2026-09-07。

## 决策

1. Migration 13 将 Forget 操作关联到已持久化的实际工具请求。操作记录保存原请求摘要、scope、屏障 generation、blocked/resolved/retained 状态及可选回执。原请求必须为 forget，包含策略、实际业务键和目标资源；未准备或跨 Session 的请求不能创建操作。
2. `phase4BeginMemoryForget` 在同一事务内保存操作归属，并推进策略 generation、封锁读/采用、抑制旧 Observe/Usage 与关闭旧效果预留。先提交这两个事实，才允许发出远端删除。精确重试必须仍拥有该 generation 的活动屏障；已完成或被新策略替代的屏障不能据此再次发送写入。
3. 远端结果未知时不调用完成接口，操作保持 blocked。可信对账可以按 Session/Tool Run 读取原请求及操作记录；Worker 重启不会自动发送请求或生成新键。明确的远端拒绝也不在此自动解除屏障，保留显式政策处置责任。
4. `phase4CompleteMemoryForget` 只接收有界回执：requestId、target/erased/protected/held 计数。计数必须是安全非负整数，分类计数之和不能超过 target；不能把缺项当作零。全部目标已擦除（或目标为零）时记录 resolved，并为授权目标保存永久 tombstone；held/protected 或未全部擦除时记录 retained、保持封锁。Core 的内容擦除不代表物理磁盘擦除。
5. 完成回执、tombstone 和策略更新属于同一事务。仅在该操作仍拥有原屏障 generation 时解除自身屏障；若出现更新的隐私屏障，则保留其 blocked 状态和 privacyRevision，仍补充已确认删除的 tombstone。精确回执重试不推进 generation 或改动当前策略，变更回执拒绝。
6. `MemoryHost.beginForget/completeForget` 先核对当前宿主范围和不可变实际请求，再在本地阻断上下文、取消投递、调用演出中断回调并等待持久事务。ACK 丢失或中断失败后，本地继续封锁，只接受同一操作和同一回执的重试；普通策略变更不能覆盖尚未确认的操作。重启后的读屏障与 tombstone 来自 DB。
7. 新记录每条最多 8KiB，最多 4096 条，不驱逐待对账操作；这不是整个 DB/WAL/审计的磁盘配额。Iris 注册层的 `beforeForget` 和 `afterForget` 可调用这些宿主方法，SDK 回执由可信适配层显式映射为通用计数。生产目标授权仍由 ADR 0017 的授权端负责。

## 验证与限制

真实 DB Worker 测试覆盖屏障重启恢复、原请求可读、精确 begin/complete 重试、变更回执拒绝、held/protected/部分未擦除保持封锁、旧删除完成不解除新隐私屏障，以及缺准备/缺屏障/非法计数拒绝。对 Bellis 临时数据库的触发器故障注入证明：操作记录写失败会回滚策略，完成记录写失败会回滚 tombstone 和策略。该测试不是 Core 私有数据库操作，也不是 A4 进程崩溃窗口验收。

MemoryHost 测试覆盖 begin 与 complete 的保存 ACK 丢失、本地持续封锁、拒绝换请求/回执和成功后的 tombstone 过滤。真实 Core 专项经 `registerIrisTools`、Decision Host、MemoryHost 和 DB Worker 确认一次、删除一次；HTTP 发出时已存在持久屏障，成功后 generation 为 2，回执和永久 tombstone 可在 Worker 重启后读取。原键重复删除结果一致，公共 getClaim 返回 404。

真实 held/protected 对象、删除过程中的各崩溃窗口、公共未知结果对账入口、通用生产目标授权和完整 Signal/Tool Result 隐私恢复仍未交付；FTS 搜索未就绪使整个四工具专项仍为 incomplete/退出 2。证据见 [Forget 专项](../evidence/phase4-forget-coordinator-probe.json)。
