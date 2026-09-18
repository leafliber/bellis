## 14. 游戏控制：能力与动作协议

本章与第15章定义游戏侧控制契约。控制能力、动作解释、帧合成与输入提交由Game Runtime实施并权威维护；Bellis只保留公共Schema、外部引用、语义事件与状态投影（第3.9、4.4节）。当前剧情游戏优先验证waitable_step（第14.3节）。

### 14.1 四层控制语义与职责

细粒度语义动作与闭环技能是两种能力，必须分开声明；本设计将其落为以下契约。

| 层级 | 示例 | 执行方式 |
|---|---|---|
| Goal | 到达可交互位置／完成当前选择 | Bellis采用，游戏侧验证目标/覆盖 |
| ClosedLoopSkill | 持续接近目标、维持目标居中、逐步查看菜单 | Controller在有效Attempt内反复观察、选动作、核验进展 |
| SemanticAction | 镜头右转有限增量、短距离后退、选择当前选项 | 明确模式/坐标/单位/时域，由受信解释器编译 |
| PhysicalInput | 完整保持状态、相对鼠标位移、短按、绝对点击 | 唯一Broker核验后由后端提交；有界释放和去重 |

“保持居中”“绕障到门口”不能实现为解释器内不透明的长循环。需要反馈、进展和退出判断时应承认是闭环Skill，并暴露健康/进展；不能以接口名简单为由隐藏决策。

高层可以批准一次范围有限的界面探索，但不能把未知任意点击、账号、购买或解锁权限随同授予。动作允许不代表业务效果允许，资源消耗与选项确认继续经过Effect契约。

### 14.2 ControlCapability声明

在四层能力快照（第4.9节）之外，控制能力另需专用描述；“有视觉模型”不等于“能在该场景反应窗口内执行”。

ControlCapability及其TimingContract、ActionSchema、ControlProfile和PolicySchema机器定义见附录B.7。覆盖证据、所需观察/质量、资源、可选更新支持与失败出口必须形成可核验的完整声明；未测保持PENDING，不能只给模式名称。

`waitable_step`只在任务允许等待、当前有效状态可重新核验且动作风险被覆盖时可用。它可以使用VLM做步骤内决策，但不能将同一个长延迟后端直接改名为continuous_local。

`continuous_local`必须证明新观察驱动的本地闭环、健康续租、故障退出和时限表现。`unavailable`是能力判断，不是伪造一个“什么都能做”的第三种执行器。读得懂画面却没有可靠控制能力时明确报告缺口。

模式选择可在主控批准的能力范围内由Runtime确定；从只读升级为可输入、切换控制根owner或启用未批准后端必须重新授权。模式变化若影响动作语义/资源/目标，走检查点交接，不混用两套映射。

### 14.3 控制模式与准入

| 模式 | 运行方式 | 适用前提 | 失败处理 |
|---|---|---|---|
| waitable_step | 当前观察→受限VLM/规则选择一个或有限短动作→执行→重观察 | 页面/任务允许等待，作用域和结果可核验，所需时间预算可用 | 未知页面重观察；无可靠动作则等待/接管，不默认连点 |
| continuous_local | 本地规则/快速策略/可选局部预测持续读状态，产生短窗口控制 | 已验证场景覆盖，反应/感知/输入安全契约成立 | 局部有限恢复；旧策略或观察失效则明确降级/撤权 |
| unavailable | 报告支持/就绪/授权/覆盖/时限哪一层不足，不发新不适用输入 | 当前没有通过准入的执行组合 | 只读观察、固定安全动作或人工接管，须为已批准方案 |

此处unavailable为能力投影，不创建一个能执行任意动作的后备控制器。切换模式必须重新检查输入上下文、实例、目标与权限；没有新高层目标时只在预先批准的候选模式内选择。需交接根owner或改变语义profile时仍执行Settlement，不允许两个模式同时控制。

当前《魔法少女的魔女审判》优先验证waitable_step和剧情阅读。continuous_local及其学习/预测后端是独立扩展门槛，不作为首次聊天、投票或剧情选择的前置要求。

所有自动输入（包括只点一次的waitable_step）先通过C0公共控制基线；此后可在明确的受监督测试许可下进行P5真机验证，正式播出启用还须目标profile真机门禁与相应P8通过。只读Bridge/Narrative可以先行。C0只要求当前范围声明的动作与完整协议形状，不强制实现continuous_local、学习后端或MPC；字段不使用也须显式为空/中性值，不能省略完整ControlFrame（第25.3节）。

### 14.4 动作语义、坐标与版本

SemanticAction至少声明`action_type / reference_frame / input_mode / magnitude_or_duration / units / action_schema_ref / control_profile_ref / evidence_refs / dependency_versions`。协议将每种动作的允许字段、数值范围和缺省行为写死在Schema，不接受模型任意解释“左”“快一点”“持续”。

| 坐标/模式 | 定义注意点 |
|---|---|
| camera_relative角色移动 | 表示相对当前镜头的方向；没有可靠镜头映射时不得声称世界坐标位移 |
| character_relative移动 | 与镜头相对不能混用，切换需profile支持和明确版本 |
| viewport_normalized界面目标 | 明确当前游戏客户区、[0,1]有效范围、原点与transform_version |
| relative_pointer镜头 | 相对输入计数/位移单位，非天然角度；度数仅在校准模型可验证时使用 |
| menu_navigation | 目标菜单发生实例与允许方向/选项；不是世界移动键的同义词 |

版本分为ActionSchema（语义）、ControlProfile（设备/键位/灵敏度/模式）、Calibration（已测局部映射与有效域）、Transform（当前窗口/视图变换）、Policy（行为参数）和BackendArtifact（代码/模型）。不以一个全局版本替代这些真实依赖，也不因每帧更新撤销全部任务。

输入灵敏度、键位或坐标校准改变时，受影响未执行动作、候选和数据标签必须失效。模型训练、推理Prompt、历史动作和解释器都引用同一ActionSchema/profile组合；不兼容时拒绝而不是默默交换方向。确定性映射只保证提交的输入受约束，不保证实际位移或成功。

### 14.5 时间范围与短时承诺

| 范围 | 用途 | 约束 |
|---|---|---|
| planning_horizon | 上层或局部优化考虑多远 | 不直接授权同长的开环输入 |
| policy_validity | 当前行为策略何时、何场景仍适用 | 由目标/模式/版本/相关证据限制，返回时间不刷新依据 |
| action_commit_window | 一次可以不重新核验的最远执行范围 | 根据能力风险、反应预算、观察时效和本地监督设有限值 |
| input_lease / hold_deadline | 谁在什么时间前可保持/续行输入 | Broker本地强制期限；不能等任务结束才释放 |

动作分块只减少调用开销，不等于滚动闭环。长意图可以保留，未执行动作后缀必须可撤销；每个短窗口结束重新确认相关状态。菜单出现、目标丢失、角色状态不适用、窗口变化、观测过期和人工接管都触发相应后缀失效，不等长宏播完。

选择性分块限于经过验证的动作/场景组合，声明最大动作数、最大承诺时间、每步检查和失败出口。不可逆业务脉冲不能混在“向前移动若干步”的模糊宏中。系统可以预测多步但只承诺当前有限部分；预测约束成立不等于真实世界无失败。

### 14.6 ControlFrame：完整状态、版本与时间

ControlFrame由当前Attempt内单根控制者合成，ActionCommand为唯一输入命令信封。Frame不是LiveDirector直接操作键鼠的接口，也不是新Task。持续输入使用完整状态；缺held_controls、analog_axes或pointer_delta不是“沿用旧值”，而是整帧拒绝。

规范只采用嵌套context_versions与deadline；不接受旧扁平input_context_epoch/deadline_at_host_ms等同层别名。表、fixture与机器Schema从同一源生成。

{{control_fields}}

max_hold_ms从`deadline.issued_at_ms`（该帧在目标主机时钟域的生成/签发时刻）开始计算，不从收到或重传时刻开始。控制帧只允许目标主机本地生成；远程高层仅传语义请求。Broker拒绝未来issued_at、无法核验时钟域和过期帧。

```text
frame_hold_deadline = min(issued_at_ms + max_hold_ms,
                          deadline.expires_at_ms,
                          input_lease.expires_at_ms,
                          execution_grant.expires_at_ms,
                          observation_valid_until,
                          capability_commit_window_end)
```

一次保持不能超过最早边界；新合法帧可替换当前完整状态并按自身新授权有限续行，同帧重传不续期。旧帧拒绝时旧保持仍按原截止释放；上下文/授权失效则立即撤销，不等原hold期限。pointer_delta和pulse只执行一次，pulse持续期也受上述最早期限约束。

held_controls、analog_axes实际映射和pulses不得在同一物理控制上冲突。analog_axes必须覆盖profile要求的全部轴，没有轴用{}；空held_controls表示释放本lease负责的持续数字控制，不释放人工或其他新owner输入。frame_seq/frame_id在producer_instance＋input_lease_epoch内唯一；同身份不同载荷为完整性错误。

以下是无设备输入的结构fixture。continuous_local只用于验证完整字段，未取得对应C1门禁的真实部署仍禁止启用该模式。

{{frame_fixture}}

### 14.7 排序、重复、合并与部分提交

持续状态与一次性效果分别处理：

1. Broker按授权交接、策略生效边界和帧接纳形成受信本地顺序；同frame_id/seq同载荷重传只返回已记录回执，不重复pointer_delta或pulse，也不延长持键期限。相同身份不同内容拒绝。
2. 尚未接纳的旧纯持续状态帧可在明示latest-state队列策略下合并；已接纳帧和含一次性效果的帧不能静默覆盖。过期脉冲要记录未派发/丢弃原因，不补到未来无关帧上。
3. 新的完整状态帧可取代旧保持快照，但不得使旧的一次性相对位移重执行。pending pulse可以跨协议重传保留同pulse_id，只有核验无旧效果且仍被授权时才进入新有效帧；含业务效果者沿用同EffectIntent。
4. 部分操作系统输入提交成功、另一部分失败时，不能说“整帧已原子执行”。回执分别列接纳、实际提交子集、未知范围与清理；未知一次性效果不自动重试。
5. 键位交接由当前lease的本地账目执行，旧KEY_UP/迟到清理不得释放新owner的状态；先清理并确认旧输入隔离，再启用冲突owner。人工接管需要已验证的真实/合成区分或独立热键策略，不能只按网络frame模拟完成。

`ControlFrameReceipt.status`只作为局部回执枚举：`REJECTED / ACCEPTED / SUBMITTED / PARTIAL / UNKNOWN`；另含`applied_state_ref`、`submitted_pulse_ids`、`rejected_items`、`evidence_refs`、`cleanup_ref`和输出不确定度。SUBMITTED仍只是声明后端边界，不等于游戏效果。重复传输返回已有receipt，不能让回执状态本身重新触发输入。该枚举不是第11章之外另建的高层Task状态机。

去重表和窗口有界，但保留范围覆盖仍可能合法重传的输入生命周期；已出窗口的老序号直接拒绝而非当新包。重启必须新host/producer/lease代次，不从旧按键队列恢复。关键业务Effect登记的持久范围不随短期frame缓存回收。

### 14.8 局部输入与Effect的对应

| 输入类别 | 身份与结果 |
|---|---|
| 连续状态：移动轴／保持键集合 | ControlFrame＋有效lease＋本地持键台账；后继Task不逐帧join |
| 一次性输入：镜头相对位移／短按 | frame_seq／pulse_id去重；提交未知不能盲目重放 |
| 业务确认／资源处置 | 除上述输入身份外，必须关联稳定EffectIntent与semantic_key，确认当前对象/次数和可见结果 |

“把点击放进ControlFrame”“换一个pulse_id”“调高激进程度”都不产生新的资源消耗许可。执行器可将同一Effect编译为有限输入，但不得自动增加Effect次数。常规局部移动失败可以通过新观察继续纠偏；副作用未决的确认键/业务脉冲必须先对账。

局部提交按键成功、策略版本已应用与Task结果是不同事实。Settlement继续由拥有真实输入边界的Runtime/Broker确认，不能因高层PolicyUpdate任务返回APPLIED就提前释放另一个持续控制Task的资源。

### 14.9 配置与校准的失效传播

输入映射/profile、模型制品、校准有效域和动作Schema变更时，未执行候选及短时后缀按真实依赖失效。已经播出的解说只保留事实，不回滚；尚未播出的“我已完成”内容必须依据更新后的结果重新核验。

相容的小策略参数可按第15.7节应用；键位/灵敏度导致动作映射变化不自动归入普通PolicyPatch。若控制器没有验证兼容热切换能力，应在安全边界停用/新实例启动。训练数据记录原版本，不将新校准值回写旧样本来制造一致性。

### 14.10 能力不足报告

报告`capability_id / control_mode / unavailable_reason / required_condition / observed_quality / safe_fallback_taken / needs_operator`。只能选择已经注册并获授权的降级，不假定游戏支持暂停；释放输入也不保证角色在外部世界安全。

只读识别能力可继续用于给操作员提示，但不说“系统已经会玩”；未知实时场景不回退到无限云端逐键尝试。主控可在后续决策选择另一个已覆盖目标，不能放宽安全上限让能力看起来可用。

### 14.11 候选、真实执行前缀与提交边界

ControlCandidate是PolicyBackend内部未授权的连续动作候选，control_mode固定continuous_local。它绑定Task／Attempt／controller、Goal／target、动作/profile／policy版本、来源观察和有限候选期限。`stage=behavior_prior`只表示可参考的旧行为先验；`stage=executable_candidate`仍须通过解释与Broker，没有输入许可。

ExecutionPrefix由Broker／目标Runtime根据实际回执生成，包含已提交frame/step、未决命令、所依赖前缀revision和证据；不能由模型预测的“应该执行了几步”替代。`unresolved_command_ids`非空时，相关候选不得在不明前缀上修正续行，应先只读核验或执行已批准的安全退出。

CandidateRepairPolicy只允许经验证的连续camera_delta／movement_velocity参数范围，固定profile／单位、允许参数轴、最大单次改变量、绝对幅度、候选数和总时间。v0.8修正不改duration、不改目标／模式／授权、不添加pulse、不改变离散选项或资源消费，也不重编号业务Effect。

已登记提交的ActionCommand、ControlFrame、operation_id和pulse_id及其载荷保持不可变。修正仅从尚未提交的候选后缀生成新candidate_id，并保存base_candidate_ref；已经进入命令登记／执行端队列的步骤不再属于可修正后缀；即使后续取得栅栏／撤销证明，也只能在核验实际状态后另行规划，不改原提交身份。下游形成新的合法frame/operation身份，但同业务效果身份不得因此改变。

连续输入的纠偏是基于新反馈的新动作，不是重放未知的一次性位移。不能将镜头修正机制推广为对确认键、投票选择或外部提交的“残差点击”。
