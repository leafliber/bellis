## 4. 对象模型、状态与能力

> 冻结的后续阶段设计，不参与生成与校验；现行部分见 [docs/spec/04-object-model.md](../../spec/04-object-model.md)。

### 4.3 控制相关对象与ID

| 对象 | 身份／版本 | 权威及用途 |
|---|---|---|
| ControlCapability | capability_id＋capability_version | 游戏侧声明控制模式、支持场景、时间约束和验证范围；Bellis保存投影 |
| ActionSchema | action_schema_id/version/digest | 细粒度语义动作的类型、坐标系、单位和参数限制 |
| ControlProfile | profile_id/revision/digest | Game Pack键位/输入方式、校准、支持模式与版本依赖；只能受控变更 |
| PolicySnapshot | controller_instance＋policy_revision/digest | 某控制实例当前有效的不可变行为参数快照；不同于安全配置 |
| PolicyUpdate | policy_update_id＋base_policy_revision | 一次兼容参数修改的应用事务；状态由目标Game Runtime维护 |
| ControlFrame | producer_instance＋input_lease_epoch＋frame_seq | 当前Attempt下的一次有界组合输入；不是Bellis Task/Scene |
| Pulse | pulse_id＋可选effect_intent_id | 一次性短按、点击等动作的去重/效果关联，不因换frame重发 |
| ControlQuality | source_instance＋quality_revision | 当前模式、观察年龄、反应预算、进展、退化原因；不是权限本身 |
| DemonstrationEpisode | dataset_scope＋episode_id | 明确许可的离线控制示范；不归Iris记忆对象，不授予执行权 |

Task仍代表“接近目标／完成某次界面操作”，Attempt内可产生许多ControlFrame。普通连续控制按有界输入授权和局部日志管理；选择确认、资源消耗等业务效果仍经过EffectIntent，不能靠把它命名为Pulse/细动作绕过第7章。

PolicyUpdate的`APPLIED`只说明目标实例已启用某个参数revision；它既不是Task成功，也不是世界状态改变。Bellis桥接命令返回、外部更新状态、可见效果与任务结果必须分开查询和播报。

### 4.7 多维StateProjection

内核只管理通用信封和权限，领域字段由插件注册。至少分别呈现`broadcast / speech / audience_topic / game_input_context / narrative / affordances / supervision / provider_health`。对白、战斗、配音、直播发言可以同时存在，不用一个互斥mode覆盖所有状态。

冲突证据保留来源，由字段级策略决定采用、降置信或unknown；不采用全局“最后写入者一定正确”。高频位置读最新不可变快照；关键证词、选项出现和效果事件另走可靠记录。

### 4.8 观察年龄、根证据与版本

`observed_at`、`received_at`、`estimated_at`分别是证据产生、接收和推断完成。结果新鲜度始终由根证据及其适用条件决定，不能因为模型、裁剪或缓存刚返回而刷新TTL。含多个关键证据时保留各自来源与最早有效截止，不用平均年龄遮蔽过期依据。

跨机器时间必须有可验证映射和误差上界；没有映射则不能直接比较不同主机单调时间。执行期限以执行端可核验的域为准。VisualObservationRef固定根捕获实例、序号、时间、尺寸、游戏会话、input_context_epoch、transform_version与story_scope；新一次真实捕获产生新身份，即使像素完全一样。

根`transform_version`表示游戏客户区、DPI、采集源或根坐标映射变化。对同一根截图裁剪／缩放产生新的DerivedView身份，不递增根transform_version、不重置捕获时刻。只有依赖发生改变的候选和未执行内容失效，无关弹幕或另一个ROI不造成全局取消。

所有原始来源、派生视图和模型输出都可以作为证据引用，但派生产物不得伪装为新的现场观测。第13.9节定义当前支持的坐标回映方式，第15.15节区分旧行为先验和新执行依据。

### 4.9 四层能力快照

| 层次 | 含义 | 例子 |
|---|---|---|
| supported | 已安装实现支持 | game.choose_option |
| ready | 实例已准备且健康 | Runtime已配对，适配包已加载 |
| authorized | 当前主体和活动获许可 | 人工允许控制此会话 |
| available_now | 当前上下文允许且证据新鲜 | 目标选择页面仍存在，选项有效 |

`ExecutableCapabilitySnapshot`给主控最小必要能力、条件和不可用原因；它是规划辅助，不是永久执行凭证。实际派发和执行端接纳再次核验。`ready`不能从进程在线推断；`available_now`不能只根据静态Manifest。

### 4.10 观察请求权限

`read_snapshot`读取已有证据；`refresh_passive`重新捕获可见区域但不改界面；`inspect_active`需要打开菜单、转镜头或移动。后者必须变成声明副作用、目标、预算和恢复/退出条件的受控Task，不能藏在“只读查询”内部。

日志与发给模型的证据默认限制为目标游戏／获准来源，不采集无关桌面、登录页面或密钥。技术上可读不等于有公开或第三方外发许可。

### 4.12 三种数据生命周期与只读产物

| 生命周期 | 对象 | 权威和失效原则 |
|---|---|---|
| 可复用计算 | ComputeArtifact、经筛选的操作经验 | 可缓存但必须精确匹配依赖、用途和保留期；不附带执行许可 |
| 当前现场 | VisualObservationRef、DerivedView、GroundingResult、当前控制上下文 | 原始证据过期／页面或目标变化即失去执行适用性 |
| 不可改写历史 | ExecutionJournal、已提交输入前缀、Effect、已播范围、删除和授权记录 | 只能追加核验或撤销事实；恢复与反思不能覆盖 |

新增对象统一为不可变计算产物：GroundingRequest/Result、ComputeArtifact、ControlCandidate、ExecutionPrefix、CandidateRepairRecord、ReflectionRecord、RecoveryContextView、RecoveryProposal、RecoveryResult。生命周期仍由其创建Task/Attempt或本地控制调用管理；它们不是21组状态机之外的可执行actor。配置产物GroundingProfile、ComputeReusePolicy、CandidateRepairPolicy、RecoveryReviewPolicy与RecoveryCapability由受信配置或Manifest管理。

产物ID由所属运行时分配；更新以新ID和来源引用表示，不以对象内可变状态偷偷替换已采用内容。仅登记结构不表示已安装算法；exposure在契约目录区分game_local、task_local、bridge_readonly和trusted_config，读取同样受隐私与作用域检查。

### 4.13 计算复用契约

ComputeArtifact是可失效、可淘汰的优化，不是记忆或授权。instruction_encoding按指令摘要、Goal版本、编码制品、规范化版本及实际参与计算的语义参数摘要索引；visual_features额外绑定根观察和DerivedView。不能仅靠相同文字／图片hash跨任务、跨用户或跨剧情分支复用。

每条缓存含依赖stamp、用途scope、story_scope、删除代次、payload引用、字节数、计算时刻和有限保留截止。依赖的writer/scope/revision精确匹配；相同scope较新版本不能由客户端自升。依赖清单由后端受信实现声明，缺少必要依赖按CACHE_DEPENDENCY_MISSING拒绝，而不是默认为不相关。

复用时仍读取当前现场与执行授权。视觉缓存必须保持根捕获时间和截止；指令缓存即使仍有效也不能延长lease、Action deadline或编辑旧输入。隐私撤回、source删除、模型替换、story_scope不可见或Goal实质变化使相关条目失效；不能在恢复后从磁盘重新载入已撤销条目。缓存miss是正常计算路径，不是业务失败。

ComputeReusePolicy限制条目、内存/磁盘字节、保留期、每scope配额与失效策略；每scope配额不得大于对应全局容量，内存模式的磁盘配额必须为0。默认内存缓存，持久化仅在用途允许且重启重新核验后开启；payload为受控不透明引用，不允许从模型URL自动下载或反序列化任意可执行对象。
