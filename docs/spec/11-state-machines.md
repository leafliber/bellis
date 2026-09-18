## 11. 状态机登记

> 第 11.7 节属于后续阶段，冻结在 [docs/future/spec/11-state-machines.md](../future/spec/11-state-machines.md)。

### 11.1 登记与适用范围

状态机、守卫与记录绑定登记在`contracts/src/state-machines.json`、`guards.json`与`object-records.json`；现行阶段的状态表见[P0](../generated/P0.md#状态机)与[P1](../generated/P1.md#状态机)契约简报。每个状态机标注最早实现阶段，按阶段分批实现。服务、控制器、计划、媒体和监督各有独立身份，不能共用一个status字符串或全局取消代次。

公开事件名表示已发生事实，形如`对象.过去式`，全部登记在events.json并可订阅；`scene.open`、`segment.commit`、`utterance.seal`这类`对象.动作`是宿主或端点命令，不是事件，也不进入事件目录。状态表中的短事件是对象内部输入，不能由插件或外部API直接发布。

事件入口先鉴权、严格Schema、对象/实例/代次匹配与幂等，再求值纯同步守卫。always表示没有额外业务守卫，不授予新增效果权限。表外转换拒绝且不产生副作用；终态吸收普通执行事件，新事实由Reconciliation追加。安全撤权不排在普通业务队列后。

### 11.2 正交字段与终止记录

Task/Activity在FINISHED时写一次outcome；Segment.flow_state仅在PLAYING区分FLOWING/BUFFERING。wait_reason、output_range/partial_output/uncertainty、children_closed、projection_quality、blocked_scopes、record_status、recovery_owner_ref和endpoint_stop_confirmed分别表示原因、事实或质量，不能冒充业务终态。

UtteranceAdmission只控制追加；seal.last_seq/close_reason接受后不改。soft/hard stop请求记录在TerminationRecord；只有实际截尾、ABORTED或异常发生才写termination_reason。单纯提出stop不把已经完整输出的原normal Utterance变成取消。

close_reason与termination_reason采用`contracts/src/termination-reasons.json`登记的同一词表；normal只适用于完整原输出。Error.reason_code使用`errors.json`登记的原因码，二者通过TerminationRecord关联，不互相覆盖。

### 11.3 共用守卫

守卫是运行时对已验证证据的纯同步判定，不发网络、不写审计、不在模型输入中接收true代替。[S29] 异步停止/持久化是转换动作和独立协调器职责。守卫标识及受信语义登记在`contracts/src/guards.json`，各阶段用到的守卫列在对应契约简报中。

### 11.4 状态转换表

转换表见契约简报：当前状态一格中的多个起点在登记中是明确数组。每条转换携带最早实现阶段；未启用的可选操作明确拒绝。核心安全撤权、deadline与已发生事实归约不能因功能开关被删除。

### 11.5 结果优先级与闭合

**Attempt和媒体输出对象：**先记录可信实际结果。若原任务/片段完整完成且停止并未实际截断，则SUCCEEDED/OUTPUT_COMPLETED/COMPLETED；明确失败为FAILED；未完成且由期限终止为EXPIRED；未完成且被授权取消为CANCELLED；无法解释效果/输出范围则UNKNOWN。软收尾只有关闭追加并验证保留前缀及尾部撤销后才ENDED_EARLY。

**Task与Activity：**closure_outcome先检验结果契约（含业务期限），随后区分真实失败、过期、取消、阻断和未知。一次stop请求不能推翻已按时达成的目标。Attempt成功不满足Task成功的所有条件，Effect确认也不替代Settlement。无法清理的旧资源即便行政结案，相关工作不视为成功交接。

**Scene：**children_closed后才聚合。非空Scene必须指定至少一个必需子对象；仅含可选子对象的集合在close时拒绝，避免没有结果依据。空集合显式EMPTY，不能用空集“全部成功”发COMPLETED或Utterance完成。非空必需子集合的优先级固定为：UNKNOWN > FAILED/REJECTED/BLOCKED/EXPIRED（映为FAILED）> CANCELLED > ENDED_EARLY/SKIPPED > 全部正常（COMPLETED）。可选子对象按预登记结果策略处理，但未知效果仍必须隔离；无未关闭子对象，必要资源已结算或已交独立隔离owner，才能形成相应关闭结论。

内部结果聚合先收集真实终态集合，再一次计算，不能“哪个事件先到就用哪个状态”。转换表中的aggregate守卫按该全序互斥。Scene的EMPTY、FAILED或ENDED_EARLY不会满足需要原Utterance正常播完的游戏动作。

### 11.6 未知入口和独立清理

所有UNKNOWN、活动级RECONCILING、Effect.IN_DOUBT、Settlement.QUARANTINED入口执行fence_and_handoff：在同一受信调度归约中固定incident及影响scope，先装禁止冲突新效果的本地栅栏，再更新状态与独立recovery_owner_ref；通过保留安全通道撤对应许可、停止/释放并查询；SettlementCoordinator与RecoveryCoordinator在原对象终态/插件卸载后继续持有责任。

本地栅栏、实际端点停止、可靠记录是三个事实。数据库满/预算耗尽不能阻止撤权，也不能把本地发送stop当成端点停止。record_status=pending/failed时保留封锁；需可靠账本的新副作用停止准入。异步动作不依赖即将终止actor存活。[S30]

重启创建新实例，不恢复旧grant、按键队列、PCM或未明操作。先应用删除/撤权墓碑、查询负责端点，再允许现场重新授权；日志缺失不等于没有未知效果。连本地拒绝栅栏也不能运行时，关闭业务派发并触发独立租约/OBS兜底。

局部未知只影响相关资源与依赖。回执丢失不擅自把远端实际APPLIED改成UNKNOWN；Bellis可以有未知投影，而目标Runtime继续已证明健康的旧/新有效闭环。对账和人工结案统一采用第7.7–7.8节，行政关闭不解除未经证明的资源隔离。

P0 的独立清理职责由监督组件实现，使用本阶段专用清理与隔离记录，不提前建立 P3 通用 Settlement 服务。监督归约停止请求，端点证明实际模拟效果与停止边界；宿主只保存带来源投影。重启记录缺失时将受影响安装目标保持隔离，不能把新进程的零计数、stopped 状态、新 scope 或新 operation 当作旧资源已清理证据。
