## 4. 对象模型、状态与能力

> 第 4.3、4.7–4.10、4.12–4.13 节属于后续阶段，冻结在 [docs/future/spec/04-object-model.md](../future/spec/04-object-model.md)。

### 4.1 对象层级

```text
Session（直播会话）
├─ Goal（语义目标＋版本）
├─ SessionService实例（持续观察；不参加有限计划join）
└─ Activity（活动实例／生命周期／预算）
   ├─ ActivePlanRef → 不可变ActivityPlanSpec revision
   ├─ Task（稳定逻辑工作；由PlanNode或主控直接创建）
   │  ├─ Attempt 1（一次执行）→ Settlement 1
   │  ├─ Attempt 2（重试／恢复）→ Settlement 2
   │  └─ EffectIntent引用（相同业务效果跨尝试保持身份）
   └─ Scene（有限演出容器）
      ├─ Utterance → Segment → AudioStream / AudioChunk
      ├─ TextPresentation（文字降级，单独完成语义）
      └─ 有限动作／外部活动交接的Task引用
```

所有权树、任务依赖图、证据派生图是不同关系。`source_cycle_id`和`caused_by`只是来源，不自动拥有对象。一个对象只有一个显式生命周期owner；多个工作可以读取其结果，但不得成为互相冲突的取消者。

### 4.2 核心对象与ID

| 对象 | ID／版本 | 唯一含义 |
|---|---|---|
| Goal | `goal_id / goal_version` | 想达到的结果，不能直接写入ObservedState |
| Activity | `activity_id` | 一段直播业务及其任务／输出所有者，可长期运行 |
| PlanSpec | `plan_id / revision / digest` | 不可变声明式节点、绑定、条件、服务引用与策略 |
| PlanNode | `node_id` | 图中的定义位置，不等于某次执行；有限迭代有显式实例索引 |
| Task | `task_id` | 一项稳定业务工作；重试不改变业务身份 |
| Attempt | `attempt_id / attempt_no` | 一次执行；重试或暂停后恢复创建新ID |
| JobHandle | `task_id / current_attempt_id / revision` | Task查询与受控操作句柄，不另建Job状态机或新的owner |
| EffectIntent | `effect_intent_id / semantic_key` | 一个被授权的业务效果意图，不是网络请求ID |
| Operation | `operation_id` | 某次有限协议命令的幂等ID；同ID不同载荷拒绝 |
| Settlement | `settlement_id / attempt_id` | 清理与必要交接的证据，不把结果到达等同资源可复用 |
| Scene／Utterance | `scene_id / utterance_id` | 演出集合／一次连续表达，不能与OBS场景或游戏Activity混淆 |
| NarrativeRecord | `narrative_id / text_revision` | 游戏原文的出现实例；不是主播Segment |
| Checkpoint／ResumeTicket | 独立ID＋依赖版本 | 有限语义交接点／恢复依据，不是旧按键队列 |

协议不同时保留Job、Task、Attempt三套业务状态。UI可继续使用“工作”这个通用名称，但协议中的Task/Attempt不可混用。

### 4.4 权威归属与外部投影

| 数据 | 权威 | Bellis保存什么 |
|---|---|---|
| Bellis目标、活动、PlanRef、Task/Attempt | Bellis宿主 | 完整记录 |
| 游戏内部Plan／Task／Attempt／输入租约 | Game Runtime／Broker | `ExternalWorkRef`和带源revision的只读投影 |
| 本地音频输出 | Stage | 回执、已播范围、时钟域与不确定度 |
| 投票、致谢账本 | 对应业务引擎 | 权威状态或经统一存储接口的记录 |
| 游戏效果 | 游戏侧EffectLedger和核验器 | 效果意图映射、源事件与未知状态，不能自行宣称成功 |
| 公开发言效果 | Bellis＋Stage各自声明边界 | 提交许可、实际输出、资源结算，禁止混淆 |
| 长期记忆 | Iris，经PrivacyGateway | 必要引用／待提交记录／删除墓碑，不复制无限原文 |

外部活动交接Task默认只等“对端登记且owner交接得到确认”，不等待整场游戏结束。需要等游戏完成时另声明一个外部结果等待任务。`Scene.close`不把整场游戏或持续观察服务纳入有限演出join。

### 4.5 结果、终态与事实

“结果已计算”“动作已提交”“效果已观察”“业务条件已确认”“清理已结算”“观众已听见”不能互换。不能确认效果时记录UNKNOWN或IN_DOUBT并对账；不能将目标、模型声称、接口成功返回值写成已观察事实。

正常任务结论的变化只能通过新证据／对账记录追加。已终态Attempt、已提交Segment与已接受seal不被迟到消息修改或重开。

### 4.6 五类运行数据

| 类别 | 内容 | 写入与读取规则 |
|---|---|---|
| Observation | 帧区域、音频区间、平台事件、原始软件回执 | 观察者追加，含来源与观察时间；不是指令 |
| EstimatedState | 可能的页面、语音忙、目标位置、候选解释 | 受信Reducer合并，保留置信度、冲突、过期条件 |
| DesiredState | 活动目标、希望显示的场景、建议选择 | 主控只写目标域，不覆盖实际状态 |
| ExecutionJournal | 命令登记、接受、效果、清理、拒绝与对账 | 运行时和受信端点记录；高风险提交前必要持久化 |
| LongTermMemory | 重要经历、事实、公开发言与声称 | 隐私过滤后异步保存；不是实时状态总线 |

例：“希望切到游戏”“OBS接受切场景请求”“观察到目标源在Program输出”属于三个不同事实。`unknown`、`absent`、`stale`不能全部用null表达；未观察到某按钮，不等于按钮确定不存在。

### 4.11 代次、revision与序号

所有比较先匹配权威、对象scope和实例，再比较数值。不同对象的epoch即使数值相同也没有共享权限含义。一般执行请求要求精确等于当前代次；更大的外来数值不能自动获得权力。重启换实例，持久权威计数不回退；溢出前先撤权并轮换身份。

普通EventEnvelope不携带全局cancel_epoch。需要取消隔离的命令携带`cancel_fences[]`，每项明确scope_type、scope_id和cancel_epoch。Activity局部事故只递增被撤范围；普通弹幕不递增任何取消代次。Stage软收尾主要改变Utterance级dispatch_revision与cutoff，不能用Session级撤权误杀保留前缀。

各代次字段的唯一写入者、比较作用域、递增时机与接纳规则登记在`contracts/src/epochs.json`，表格见[P0 契约简报](../generated/P0.md#代次与序号)。

`DirectorRecord.source_seq/last_source_seq`用于模型候选流；`segment_seq/last_seq`用于已提交媒体。两者不是别名。宿主记录候选→正式片段映射，拒绝候选不占正式序号；异常或拒绝不能用映射压缩伪造normal完成。EventEnvelope.source_seq另属权威事件流，不与模型序号比较。所有sequence的起点、闭区间/半开区间和空值规则由相应Schema定义。

P0 的 operation 去重以认证主体、会话、grant、目标端点实例及业务 operation_id 为固定身份；其中尚未签发 grant 的管理动作以认证操作员、会话和 operation_id 为键。CLI 重启、新连接、caller_instance_id 改变不新建同一业务操作。原载荷、作用域、代次与原期限保持固定；连接挑战与传输 ID 可以更新，但不得借此再次产生效果。相同 operation 异载荷拒绝，已失效的原权只允许查询既有事实；新 operation 也不能绕过未知资源隔离。调用方实例本身必须与该次认证证明和连接一致。
