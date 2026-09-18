## 7. Task、Attempt、Effect与清理结算

> 冻结的后续阶段设计，不参与生成与校验；现行部分见 [docs/spec/07-task-effect-settlement.md](../../spec/07-task-effect-settlement.md)。

### 7.1 Task与Attempt的身份划分

`WorkRegistry.create_task`先登记目标、输入、所有者和结果契约，再返回JobHandle。每次实际派发创建Attempt，记录尝试序号、执行实例、operation、授权代次和截止。TaskRecord、AttemptRecord与JobHandle的完整持久化字段登记在附录B.6，实现的存储层和SDK类型从那里生成。

Task创建时将绑定解析后的实际输入冻结为TaskInputSnapshot，与Task登记在同一本地事务中；直接创建且没有PlanNode的Task也必须有快照。快照绑定精确输入Schema、不可变Plan引用（无Plan时null）、所用输出证据引用和内容摘要；input_schema_ref必须与快照一致，摘要按本协议JCS规则核验。重试/恢复复用该快照并重新核验依赖有效性，不重新读取活动当前Plan或重解已变化的上游输出。语义输入改变须创建新的已授权Task。

同Task最多一个仍可能产生冲突副作用的有效Attempt。旧Attempt已业务失败但尚未隔离/清理时，不得启动冲突的新Attempt。并行只读候选应建为明确子Task，不能在一个Task下偷偷竞速不可逆效果。

重试、恢复、不兼容执行器替换产生新attempt_id；旧终态不重开。结果回执可能先于accepted到达：来源/效果证据核验后允许直接记录实际结论，不伪造中间接受事件。暂停申请与自然完成竞争时以实际结果结案，不凭空制造SUSPENDED和恢复票据。Task仍可继续，因为它的业务目标尚未结案。只有目标、真实发生实例或允许效果本身改变，才按新业务建立新Task/Effect并保留supersedes关系；单纯换ID不能重做未决效果。

### 7.2 结果与Settlement

`AttemptResult`的字段与`SettlementRecord`一同登记在附录B.6：结果含outcome、证据与输出引用、依赖版本、效果引用、清理要求、部分效果标记和不确定说明；清理项、负责端点、记录状态与隔离/退役标记属于Settlement。

结果产生与资源清理分开：

```text
Attempt得到可信业务结论
        ↓
Attempt进入不可变终态；记录结果
        ↓
Settlement收集：停发／尾部撤销／按键释放／租约交还／必要端点确认
        ├─ SETTLED：所需清理全部确认，可按结果契约放行后继
        └─ QUARANTINED：隔离冲突资源，请求对账，不宣称安全交接
```

SETTLED不表示业务成功；FAILED可以已清理。SUCCEEDED也可能清理未完成，此时后继不能取得冲突资源。UNKNOWN效果即使输入已清理，也不能满足“效果成功”或自动重复的条件。

无外部资源的纯计算可以结果与settlement同一次本地提交。未派发工作的直接取消/过期同时归还本地接纳计数；已有外部准备或资源时先完成Settlement，不能借no_effect跳过清理。游戏清理以Game Runtime/Broker确认作为权威；Bellis不能依据RPC连接断开自行宣布按键已释放。

### 7.3 EffectIntent与操作去重

| ID | 去重范围 |
|---|---|
| operation_id | 同一协议命令的重传 |
| attempt_id | 同一逻辑工作的某次执行 |
| effect_intent_id | 同一业务效果在重试/恢复/计划修订间的身份 |
| semantic_key | 在明确业务范围内识别“是不是又做同一件事” |

例：当前`choice_instance_id`上的一次选择，不因重开投票、重试网络或主控重新规划就自动变成第二次合法选择。实际资源消耗、账号/支付默认禁用；“再做一次”必须是新的明确目标与重新授权，不能靠换ID绕过。

EffectIntent固定目标、预期效果、最大次数/成本、权威Runtime、依据和载荷摘要，字段见附录B.6的EffectIntentRecord。同semantic_key存在已确认或未决效果时，拒绝重复创建相同效果；真正的新业务须给出新的发生范围和授权，而不是仅换字符串。

游戏局部输入（持续状态、一次性输入、业务确认）与EffectIntent的对应见第14.8节。

### 7.4 副作用提交流程

```text
登记效果意图并持久化（需要可靠记录的副作用）
→ 实例／Attempt／权限／上下文／semantic_key核验
→ 登记有限operation并派发
→ 对端接受：只说明SUBMITTED/ACCEPTED
→ 重新观察：效果发生了吗？
→ 验证业务成功证据
→ 记录CONFIRMED、NO_EFFECT_VERIFIED或IN_DOUBT
→ 必要清理结算
```

录制日志失败时，不继续需要该记录的正式／不可逆操作。音频每个采样和游戏每个常规按键不逐次同步落盘；正式片段许可、关键业务效果与有界本地输入授权采取不同持久化粒度。

`NO_EFFECT_VERIFIED`需可信证据，不是“没有收到回执”。确认无效果、旧Attempt已settled且重试政策允许后，可以沿用原effect_intent_id授权新Attempt；账本追加新提交轮次，不删除旧证据。`IN_DOUBT`先查询和对账，禁止自动再次发出效果。

### 7.5 外部游戏效果映射

Bellis创建高层语义效果请求并映射`remote_effect_intent_id`；游戏侧登记提交和可见效果证据。宿主“请求已登记”与远端“输入已提交”是两种事件，不能共用一个模糊success。

Bridge先本地登记外部工作关联，再派发。响应丢失保留owner与待对账记录；通过远端operation/effect查询确认，不创建无人持有的后台游戏活动。游戏Runtime没有查询/隔离能力时，该后端不能被宣称支持安全重试或热交接。

### 7.6 累计恢复预算

Task与Effect共同绑定`recovery_budget_id`，统计所有层的尝试次数、总时长、Provider成本和已发生效果。Provider三次＋插件三次＋活动三次不能变成不受记录的乘法重试。

只读技术重试、重新观察、业务重执行分开计数。旧效果未决、安全撤权、隐私拒绝不沿普通重试链继续。恢复政策先近端有限修复，再领域控制器，再Task重规划，再主控调整，必要时直接人工。

### 7.7 局部未知与活动级对账

Attempt终态UNKNOWN保持历史；Task可进入有限RECONCILING，以新证据完成逻辑工作，或在确认无效果、旧派发已隔离、资源SETTLED且预算有效时创建新Attempt。对账期限耗尽则Task以UNKNOWN结案，后续事实通过Reconciliation追加。

局部子任务、Scene或Effect未知只更新Activity.blocked_scopes，Activity原生命周期保持RUNNING/QUIESCING/PAUSED/STOPPING。只要主owner、ActivePlanRef和无关工作授权可判定，常驻聊天、被动观察和其它安全工作继续。

Activity进入RECONCILING仅用于活动owner/活跃PlanRef无法确认，或有限目标必需完成依据整体不可解释。进入时保存return_state、close_request与reconcile_deadline。对账解决后依可信事实回原RUNNING、PAUSED、QUIESCING，或进入STOPPING继续关闭；有限目标确已完成才FINISHED。对账期间stop/deadline都关闭新接纳，并使后续走关闭分支；不得在解除歧义后自动复权。

所有未知入口执行fence_and_handoff。资源隔离和独立恢复职责不依赖数据库写入成功，也不随业务actor终止而消失。具体强制顺序见第11.6节。

### 7.8 人工确认、行政结案与新发生范围

ManualResolution必须包含resolution_id、incident_id、object_ref、expected_revision、operator_id、decision、reason、evidence_refs、old_scope_ref、new_scope_ref、requested_at和authorization_ref。操作员界面展示已知/未知范围、效果去重键、清理状态和决定后果；执行采用对象revision条件更新，同ID不同载荷拒绝。

| 决定 | 合法结果 | 仍保留的限制 |
|---|---|---|
| attest_confirmed | 操作员提供可审计且契约允许的实际观察证据，经验证走Effect.reconcile_confirmed；Task若尚未终态可按契约结案。 | “我猜已做完”不能充当证据；不改变已终态Attempt。 |
| attest_no_effect | 证据证明未发生且旧派发再不能生效，走reconcile_no_effect。 | 还要Settlement、当前授权及剩余deadline，不能直接重试。 |
| close_unresolved | Effect由IN_DOUBT到CLOSED_UNRESOLVED；未结Task/活动可以UNKNOWN终结自动对账。 | 旧semantic_key保留未知墓碑；不得把它改成CONFIRMED或NO_EFFECT_VERIFIED。 |
| retire_resource | 负责端点证明旧实例不能再影响目标、输入/音频已清理或安全隔离，Settlement可按retirement_verified结算。 | 游戏进程重启、换epoch或人类勾选本身不证明OS按键/旧音频安全。 |
| abandon_cleanup | Settlement由QUARANTINED到ABANDONED，停止无限自动尝试，长期隔离记录接管。 | 不是SETTLED，原资源仍不可复用；独立新资源必须另有无冲突证明。 |

semantic_key按权威、game_session、story_scope、真实choice_instance/业务发生实例及操作族计算，不能按poll_id或attempt_id重置。游戏重开或新存档可能产生真实新scope：核验旧输入通路已撤、旧效果不会影响新scope，并经操作员采用新目标后，可使用新EffectIntent继续。旧scope的未知事实不删除；同一个仍可能重复的旧scope仍不自动重做。这解决证据永久丢失后的运营退出，同时保留防重复安全性。

已终态UNKNOWN/ABANDONED/CLOSED_UNRESOLVED不复活。后来取得证据，追加Reconciliation及资源注册表的核验解封事实；不能重写旧结果或让旧执行器恢复权限。

### 7.10 失败记录与下次尝试的依据

P3即保留结构化失败记录的最低信息：任务目标引用、来源Attempt、尝试过的操作、实际结果与证据、未决Effect、清理、时限和可核验的失败原因。可以由确定性代码整理，不要求每次失败调用模型，也不要求先接Iris。

ReflectionRecord在这些事实之上保存有限的操作经验、剧情知识或诊断假设。每项具有独立ID、分类、证据与适用依赖；模型猜测保留hypothesis，不因重复或重新总结升级evidence_backed。过去“当时在菜单里”的描述属于历史，恢复后的当前界面必须从新Observation重建。

下一Attempt使用经第10.7节审查、第18.6节过滤的RecoveryContextView；不直接拼接整个失败日志。相同错误指纹重复达到配置上限、状态循环或无进展可触发审查，但不能把暂时找不到目标写成Effect.IN_DOUBT。已派发动作结果不明时仍先对账，反思没有资格证明“应该没点到”。
