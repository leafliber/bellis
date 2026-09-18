## 附录C 术语表

> 冻结的后续阶段术语，不参与生成与校验；现行术语见 [docs/spec/c-glossary.md](../../spec/c-glossary.md)。

| 术语 | 说明 | 见 |
|---|---|---|
| WaitRegistration | 在游标和关联条件下登记的有限事件等待；SATISFIED只表示收到匹配事实 | 第5.4节 |
| PollRound | 一轮独立开票、接票、冻结和结果生命周期；平票重开受预先规则限制 | 第16.4节 |
| DirectorRecord | 主控NDJSON中的完整结构记录；只有完整校验的Action才可采用 | 第5.2节、附录B.1 |
| lifecycle | Activity的finite/resident生命周期分类；resident不参加有限计划join | 第6.1、9.5节 |
| rules_digest | 采用后冻结投票规则的摘要，防止开票后修改计票或平票口径 | 第16.3节 |
| Input Broker | 目标主机／交互桌面上唯一的输入仲裁者，校验owner、上下文、时效与去重后提交和清理输入 | 第3.4、8.1节 |
| ActivityPlanSpec（PlanSpec） | 不可变声明式计划：节点、绑定、事件处理器、服务引用、策略、限制与完成契约 | 第6.1节 |
| ActivePlanRef／PlanCandidate | 指向已采用计划revision的引用／带base_revision与变更范围的待提交修订 | 第6.1、10.3节 |
| EffectIntent／semantic_key | 被授权的业务效果意图／在明确业务范围内识别重复效果的键 | 第7.3节 |
| Settlement | 清理与必要交接的证据；SETTLED不表示业务成功 | 第7.2节 |
| Reconciliation（对账） | 以追加的可信证据解释未决结果，不复活已终态对象 | 第7.7节 |
| IN_DOUBT | Effect无法确认是否发生；只读对账或人工行政结案，禁止自动再次发出旧范围效果 | 第7.4节 |
| QUARANTINED | 清理无法确认时隔离冲突资源并请求对账，不宣称安全交接 | 第7.2节 |
| SessionService | 平台连接、状态估计、NarrativeCapture、健康观察等持续服务；不参加有限计划join | 第9.1节 |
| Checkpoint／ResumeTicket | 可解释的暂停/交接边界／清理与快照核验后签发的恢复依据；不保存旧按键或未播PCM | 第10.2节 |
| NarrativeRecord | 游戏原文的出现实例；不是主播Segment | 第13.4节 |
| story_scope | 当前剧情范围及revision，限定证据与推理 | 第13.6节 |
| StateProjection | 通用信封加插件注册领域字段的多维状态投影 | 第4.7节 |
| supported／ready／authorized／available_now | 四层能力快照：实现支持、实例就绪、当前获许可、当前可操作 | 第4.9节 |
| ClosedLoopSkill／SemanticAction／PhysicalInput | 控制分层中的闭环技能／细粒度语义动作／物理输入 | 第14.1节 |
| ControlCapability | 游戏侧声明的控制模式、支持场景、时间约束和验证范围 | 第4.3、14.2节 |
| waitable_step／continuous_local／unavailable | 可等待逐步控制／已验证的持续本地控制／能力不足的投影 | 第14.3节 |
| ActionSchema／ControlProfile／Calibration | 细动作语义定义／键位、输入方式与版本依赖／已测局部映射与有效域 | 第4.3、14.4节 |
| TimingContract | 每个控制能力/Profile组合的观察年龄、决策与提交期限、承诺窗口、hold与续租等时限契约 | 第14.2、21.7节 |
| ControlFrame | 当前Attempt下由单一根控制者合成的完整持续状态＋一次性输入 | 第14.6节 |
| Pulse | 一次性短按、点击等动作，以pulse_id去重，可关联EffectIntent | 第4.3、14.6节 |
| input_lease／hold_deadline | 谁在什么时间前可保持/续行输入；由Broker本地强制期限 | 第14.5、15.4节 |
| ControlQuality | 当前模式、观察年龄、反应预算、进展、退化原因的摘要；不是权限本身 | 第4.3节 |
| PolicyBackend | 在已授权目标下选择短动作的算法中立后端：规则、反馈控制、学习策略或局部预测 | 第3.4、15.5节 |
| SemanticActionInterpreter | 把带模式、坐标系、单位与版本的细动作转换为受限ControlFrame | 第3.4节 |
| PolicySnapshot／PolicyPatch／PolicyUpdate | 控制实例当前有效的不可变参数快照／兼容参数修改候选／其应用事务 | 第4.3、15.7–15.10节 |
| control_critical | 本地快策略推理、必要感知和控制监督的独立资源接纳类别 | 第8.1节 |
| DemonstrationEpisode | 明确许可的离线控制示范；不归Iris，不授予执行权 | 第4.3、23.3节 |
| ModelArtifact | 记录digest、依赖、数据血缘、覆盖与批准证据的模型制品 | 第23.5节 |
| Iris | 外部长期记忆服务，经PrivacyGateway检索与写入 | 第18章 |
| deletion_tombstone（删除墓碑） | 删除/撤回的本地登记，阻止相关召回、公开输出和未提交写入 | 第18.4节 |
| viewer_claim | 某观众声称；重复、总结或多账号附和不升级成事实 | 第18.1节 |
| quiet_scope | 显式声明来源与到期时间的有限节目安静范围 | 第8.2、16.2节 |
| result_contract／completion_contract | 单个Action的结果证据与结算契约／计划根的聚合完成契约 | 第6.8节 |
| enabled_at／node_deadline | Action首次启用时间／覆盖启用后等待且不被重试恢复刷新的截止 | 第6.9节 |
| control.policy_applied | 唯一策略应用事实名；重传、查询与遥测不能另造应用事实 | 第15.13节 |
| C0公共控制基线 | 任何自动游戏输入的共同前置；不同于C1–C5可选扩展 | 第25.3节 |
| PlanDraft / PlanSpec | 尚未采用草稿／固定digest的不可变采用对象；字段严格分离 | 第6.1节 |
| blocked_scopes | Activity内受影响的局部效果/资源/依赖范围；不必改变活动生命周期 | 第7.7节 |
| ManualResolution | 认证人工提供证据或行政结案的条件更新，不是绕过安全的强制成功 | 第7.8节 |

### C.1 证据、计算与恢复术语

| 术语 | 本文含义 |
|---|---|
| 根观察／VisualObservationRef | 一次真实捕获的不可变来源与时效引用；新推断不重新定义其年龄。 |
| DerivedView | 同一根截图的受限裁剪／缩放视图，有确定坐标回映；不是新现场。 |
| GroundingResult | 对已指定目标的只读定位结果，FOUND仍不等于允许点击。 |
| ComputeArtifact | 可丢弃的编码／特征缓存，精确绑定依赖、用途与scope，无授权效力。 |
| behavior_prior | 较慢策略形成的行为先验；可参考不等于可直接执行。 |
| ControlCandidate | 当前Attempt内未授权的有限连续动作候选，区别于已提交ControlFrame。 |
| ExecutionPrefix | Broker实际提交事实和未决命令构成的前缀；不是预测执行序列。 |
| CandidateRepairPolicy／Record | 受信修正范围配置／一次产生新候选或拒绝的记录；不修改旧命令。 |
| ReflectionRecord | 有来源、条件、分类与用途的任务局部失败经验／诊断。 |
| RecoveryContextView | 当前Goal与新观察加筛选反思项的有限视图，不是第二套事实库。 |
| RecoveryCapability | 后端真实可恢复方法与白名单范围；Checkpoint本身不代表具有该能力。 |
| RecoveryProposal／Result | 无执行权的恢复提议／已执行恢复的实际结果证据，二者不能互换。 |
| 保护平面 | 不能随世界快照回滚的权限、Journal、效果/清理、公开事实、删除和预算记录。 |
| X-G/R/D/E | 定位、恢复、计算复用和候选修正的独立实验编号，未执行则PENDING_EXPERIMENT。 |
