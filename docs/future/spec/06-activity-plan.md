## 6. 活动目标与声明式计划

### 6.1 PlanDraft、PlanSpec与Activity

Goal定义希望达到的结果，Activity提供生命周期、授权和预算，Plan描述工作分解。`PlanDraft`为尚未采用候选；`PlanSpec`为固定digest的不可变对象，ActivePlanRef只指向一个已采用revision。候选可由人工、预登记模板或模型提出，但采用和签发执行许可属于宿主受信链。

两者共有且必须登记的顶层字段为：api_version、plan_id、revision、contract_bundle_ref、goal_ref、lifecycle、input_bindings、nodes、event_handlers、service_requirements、policies、limits、completion_contract、failure_policy；PlanSpec额外必填digest，PlanDraft不接受digest。精确形状见附录B.3及机器Schema。

Activity自身的持久化字段登记为附录B.6的ActivityRecord，包含lifecycle、活跃PlanRef、授权与监督代次、期限、被封锁范围和对账现场。lifecycle为finite或resident。有限目标按完成契约结案；resident用于受监督的常驻活动，在本次Session/授权的有限期限内持续接纳工作，不把一个子Task失败自动升级为活动终止。直接聊天可没有复杂计划图，但其Activity仍有owner、限额、期限和关闭政策。

digest采用RFC8785规范化后SHA-256，排除顶层digest自身；引用的契约bundle版本/digest在采用时固定。[S35] 仅结构测试的fixture使用PlanDraft，不伪造已采用对象摘要或已存在权限。

### 6.2 节点与结构所有权

| 节点 | 特有必填字段 | 执行语义 |
|---|---|---|
| Action | capability、capability_version、input_schema_ref、permission_scope_ref、inputs、result_contract、timeout_ms、effect_type；外部效果另需effect | 一个逻辑Task；执行/重试使用独立Attempt。 |
| Sequence | children、accepted_outcomes、timeout_ms | 子节点按声明顺序启用；前驱结果被接受且必要清理完成。 |
| Guard | condition、branches.true/false/unknown | 三值条件只选择一条路径，未选路径关闭。 |
| Switch | cases（case_id/condition/next）、else、unknown | case必须互斥；多个true为计划错误；含无法确定的竞争case走unknown，不按排列次序猜测。 |
| WaitEvent | event_names、expected_source、correlation、cursor、predicate、timeout_ms、on_timeout、on_gap | 先登记后派发，有限等待；缺口/超时都有命名出口。 |
| ParallelAll | branches（node/required）、concurrency、failure_mode、timeout_ms | 按兼容资源调度；require_overlap与排他冲突静态拒绝。 |
| BoundedRetry | child、max_attempts、total_timeout_ms、backoff、retry_reason_codes | 首版child只允许单个Action；同Task新Attempt，不重复实例化子图。 |
| Fallback | candidates、on_reason_codes、timeout_ms、require_effect_accounted=true | 有序尝试已注册替代，前项效果/清理可解释才切换，不用替代绕未知。 |

每节点共有id/kind；depends_on与enabled_by为可选且形状固定。结构节点管理的child只有一个结构owner；child不能同时被另一个容器或根调度器独立派发。图校验必须分别处理结构包含边、依赖边和分支门，不能把“父等待子完成”当作可以执行的反向依赖。

没有任意循环、代码谓词、Shell、eval或不可逆效果竞速。BoundedRetry是有限状态推进，不在图中回连成环。ParallelAll的可选分支也必须有限收尾；可选不意味着可以遗留未知输入。

### 6.3 输入绑定、依赖与结果

绑定写为`{"input_ref":{"node":"snapshot","path":"/choices"}}`，path采用JSON Pointer。该形状保留给绑定，不能夹带其它键。宿主先解析选中路径的可信不可变结果，再按Action引用的input_schema_ref二次验证。不存在路径、类型不符、未选分支引用或证据过期都拒绝；不能把缺失字段默认为null或true。

depends_on的每项固定node、accepted_outcomes、require_settled。默认后继需要接受的Task结局、必要结果/证据、Effect已解释与所需Settlement=SETTLED。只有显式只读artifact.available可提前驱动其它只读计算；副作用不能越过清理边界。

SKIPPED不是SUCCEEDED。非选路径按可达性传播SKIPPED；不会满足未明确接受SKIPPED的后继。若正常依赖失败而未显式接受该结果，后继BLOCKED并纳入failure_policy，不无限等一个已经不可能成功的前驱。

### 6.4 条件、分支和处理器

Predicate仅允许登记的all、any、not、eq、exists，递归深度、项数、值大小有上限。三值逻辑：all中有false为false，否则有unknown为unknown；any中有true为true，否则有unknown为unknown；not保留unknown。exists对有效对象的确实缺失字段为false，对证据无效/无法读取为unknown。结构/type错误在采用前拒绝，不混成运行时unknown。

Switch在可信同一快照上求值：恰好一个true且其余可判false时采用该case；全部false走else；任何无法排除的unknown走unknown；多个true拒绝并关闭相关准入。共享一个出口可通过显式受控合流实现，不能重复创建同一目标节点实例。

事件处理器登记handler_id、event_name、expected_authority、correlation_path、plan_template_ref、max_reentry、max_instances_per_occurrence、timeout_ms。失败处理器只允许close_dependents、settle_affected、request_review、reconcile_effect等登记动作，不接受脚本或任意能力名。派生工作沿原活动预算和Effect范围计数。

### 6.5 完成契约

completion_contract引用已登记的受信聚合器；failure_policy引用固定处理规则，而不是未登记的自由字符串表达式。契约必须覆盖SUCCEEDED、FAILED、EXPIRED、CANCELLED、BLOCKED、UNKNOWN；SKIPPED仅用于明确未采用/未选整体实例。

有限目标结案前，选中必需路径均已收尾、未选路径已关闭、清理与效果已解释。存在未决效果或缺失必要结果证明时为UNKNOWN；明确业务失败为FAILED；业务期限未满足为EXPIRED；停止前目标尚未完成且没有更准确失败/超时则CANCELLED；需要人类决策或已闭合但不满足成功条件为BLOCKED。已在有效期限内完成的目标优先保留SUCCEEDED，不能因随后stop请求或迟到通知变成取消。

投票示例固定audience_choice_completion@1：choose_1或choose_2的原效果确认且输入清理完成才可能SUCCEEDED。登记人工复核成功只是内部工作成功，选择Goal为BLOCKED。SessionService从不参加有限join；service_requirements中删除include_in_completion_join字段，传入即FIELD_NOT_ALLOWED。

### 6.6 校验与采用

静态依次检查严格JSON、Schema、全部引用、能力/效果类别、节点唯一性、图/结构owner、分支闭合、绑定类型、资源冲突、有限时限和预算。PlanDraft不能直接派发。通过后宿主再次检查owner、base_revision、关键证据、监督/ExecutionGrant、服务质量，固定契约bundle与digest，才采用PlanSpec并可靠登记待发送操作。

解析器不得自动填capability_version、permission_scope_ref、result_contract或timeout_ms。采用方也不能替不完整Action猜值。生成器可以基于已批准的完整模板生成候选，但模板展开必须在候选可见/重新校验之前完成，展开结果留digest与来源；这不是执行时补默认值。

### 6.7 控制能力与服务

游戏Action引用已批准能力、模式/profile与结果契约；一个Attempt可执行多个本地ControlFrame，不逐帧通过Bellis。业务选择/消耗仍保持独立EffectIntent。兼容策略更新可通过有限Action登记PolicyUpdate引用；需要应用成功的后继等待该更新全部终态分流，其它工作继续。

service_requirements仅含service_ref、required_quality_ref和on_unavailable。on_unavailable的等待受Node/Activity期限限制；服务引用释放由其Session或显式Activity owner管理，不因一个临时Task结束而停服。

### 6.8 Action字段与业务policy位置

Action的字段表由Schema生成，详见附录B.3。Action层不再接收游离`policy`对象；投票规则必须放在`inputs.rules: PollRules`内，策略修改必须放在已登记PolicyPatchInput里。这样不会同时存在Action.policy、Plan.policies和业务inputs三套不清楚归属的配置。

Action.result_contract定义单工作真实结果与必要结算，Plan.completion_contract定义目标聚合。两者不可替代，也不可作为同一对象的兼容别名。权限scope只是引用，不能凭字符串扩大已授予范围。

### 6.9 deadline、重试总时长与清理

当分支已选、前驱结果满足时，记录一次enabled_at；资源/服务/授权等待开始前即启用计时。无前驱根节点在采用时启用。每一层时限取最早边界：

```text
activity_deadline = adopted_at + limits.total_runtime_ms
node_deadline = min(enabled_at + Action.timeout_ms, activity_deadline,
                    所有结构父节点截止)
retry_deadline = min(retry_enabled_at + BoundedRetry.total_timeout_ms,
                     child_node_deadline, activity_deadline)
attempt_deadline = min(node_deadline, retry_deadline（存在时）, 当前执行授权截止)
```

max_attempts包含首次执行；total_timeout_ms覆盖排队、退避、准备、执行及暂停等待，不能按每次Attempt重算。Action.timeout_ms同样是该逻辑节点总预算，而不是“每尝试一次都重新获得”。需要独立单次执行上限时由受信能力TimingContract进一步取min，不可选模型可隐藏扩大的字段。尚未启用的依赖等待受Activity总截止和无进展预算限制。

暂停、恢复、Provider重试与授权续期均不重置enabled_at。REGISTERED/WAITING/RETRY_WAIT/PAUSED没有可能继续生效的执行且历史效果/资源已解释时，可直接EXPIRED；ACTIVE/QUIESCING到期进入STOPPING；RECONCILING的业务到期关闭重试但保留独立有限对账期限。

所有对象保存TerminationRecord，明确触发类型、reason、scope、requested_at、effective_fence_at、deadline_missed与证据。stop_timeout、prepare_timeout、guard_timeout、wait_timeout、reconcile_timeout不伪装operator_request。结果期限不吞清理责任：stop/cleanup/reconcile分别有限计时，超时进入对应UNKNOWN/QUARANTINED，相关新效果继续关闭。

### 6.10 感知、反思与恢复在计划中的位置

不新增Grounding、Reflection或Rollback节点类型。按需定位、诊断和恢复通过已注册Action及现有结果契约组合；不同Game Pack可以把只读定位封装在`game.validate_choice_context`内。附录A.2继续使用19节点两轮投票图，投票逻辑不依赖特定视觉算法。

定位Action完成但结果非FOUND时，只能重观察、选择已登记回退或请求人工，不触发选择。指针profile的choice_ref必须在游戏侧关联新鲜GroundingResult；非指针菜单导航可采用已验证的语义选择证据，不强制调用区域模型。

恢复提议不直接修改计划。确定性运行时或LiveDirector在已有预授权范围内采用完整恢复Action；改变目标／图／允许效果需正常PlanCandidate流程。没有安装的恢复能力必须静态拒绝。反思、审查、重观察和实际恢复均计入原recovery_budget_id；即使恢复另建Task也不能重置累计时间或次数。
