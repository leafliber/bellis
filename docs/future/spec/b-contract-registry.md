## 附录B 协议、字段、错误与事件登记

> 冻结的后续阶段设计，不参与生成与校验；现行部分见 [docs/spec/b-contract-registry.md](../../spec/b-contract-registry.md)。

### B.3 Plan与输入控制Schema

PlanDraft、PlanSpec、全部8种节点、DirectorRecord和ControlFrame均是机器Schema，不再只有Action顶层片段。required和additionalProperties=false同时使用；组合Schema不能因继承遗漏关闭额外字段。[S31]

Action不接受policy或completion_contract；Plan根必含failure_policy/completion_contract等引用；服务没有join开关。精确字段及必填属性如下。

{{plan_fields}}

结构Schema只证明字段形状；引用是否存在、绑定路径/分支可达性、动作物理冲突、lease/deadline范围、结果证据、Schema/profile对应和不可变digest仍由受信语义检查核验。交付包不把这些生产守卫伪造成“参数合法便返回true”。

### B.5 契约引用目录

{{contract_refs}}

注册表内语义规则是实现义务，不是已运行的验收证明。固定输入/结果/模板引用在每次采用中锁定；fixture@1仅用于本交付的离线结构/绑定验证。

### B.9 计算与恢复产物

以下不可变产物及辅助类型由bundle与object-records.json的artifact_types生成，不增加状态机或公开执行方法。来源、时间、坐标回映、执行前缀和保护范围的语义检查由对应受信运行时负责，登记在contract-registry.json的semantic_rules与guards.json；Schema通过不授予执行权。

{{artifact_fields}}

ActionCommand只接受ControlFrame；这些产物不能成为Broker的替代payload。实际定位或恢复能力须另有精确输入/结果、权限、效果和Manifest登记，尚未接入时返回unsupported。
