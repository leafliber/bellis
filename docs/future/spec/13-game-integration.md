## 13. 游戏集成与剧情闭环

### 13.1 集成模式与独立运行

```text
Bellis LiveDirector采用目标
→ Bellis活动Task／外部工作预登记
→ game.bridge语义接口
→ Game Runtime自己的Plan／Task／Attempt／检查点
→ DomainController → 主机/桌面Input Broker → 游戏
→ 本地观察与Effect核验 → 带来源回执到Bellis
```

Bellis不复制游戏内部任务图，不编排每帧动作。集成模式下，独立Game Planner仅作为候选分析Worker，正式采用权属于Bellis；独立运行时可以由本地操作员/规划器接管，但必须显式交接，不能同时存在两个高层写入者。

高层`control_authority_epoch`与本地`input_lease_epoch`分开。宿主授权目标不是直接铸造键鼠许可。Input Broker以主机/交互桌面仲裁，游戏会话是逻辑范围；Stage从来没有键鼠能力。

### 13.2 Bridge能力面

| 能力 | 语义 |
|---|---|
| get_snapshot / list_capabilities | 最新摘要、证据年龄、动态可操作条件；不暗中操作界面 |
| prepare_activity | 提交活动候选、版本和约束，不立即产生游戏输入 |
| propose_policy_patch / get_policy_update / cancel_policy_update | 兼容参数候选、目标侧状态与有界取消；仅应用开始前且确认未生效可取消；APPLYING取消返回POLICY_CANCEL_TOO_LATE并查询 |
| get_control_capabilities / get_control_quality | 控制模式、动作/profile版本、时限、覆盖和当前新鲜度/健康摘要 |
| activate_activity / apply_candidate | 受限高层采用、返回外部活动句柄与实际阶段 |
| get_task / subscribe_events | 外部Task/Attempt只读投影、游标和有限重放 |
| request_observation | 区分已有／被动刷新／主动检查；主动检查需要Task授权 |
| request_checkpoint / quiesce / restore | 声明支持时使用，恢复重新核验、保留外部权威 |
| get_effect / reconcile_operation | 稳定效果与操作的核验，结果未知不重复点击 |
| stop / transfer_owner | 有界停止或交接；确认清理后才允许新冲突owner |

接口名称为拟议能力，不是现有Runtime已提供的API。远端不支持某项时通过Manifest禁用对应上层路线，不用本地假状态冒充。

本章可选接口沿用第9.3节Manifest声明和附录B.2固定错误映射；Bridge不能把目标侧静态不支持改成暂时不可用后无限重试，也不能以本地模拟quiesce/restore替代目标侧真实检查点与清理确认。

### 13.3 本地输入契约

游戏侧向Broker提交输入只有ActionCommand信封：`payload_type=control_frame`，payload必须是完整ControlFrame。高层有限语义操作先由Bridge登记为受控Task，经控制器和解释器编译，不能用另一种未登记payload直接进入Broker。

ActionCommand外层绑定operation_id、session_id、source_instance／authority_epoch、owner_ref、grant_id、trace_id和cancel_fences；ControlFrame内绑定目标主机／游戏会话、Task／Attempt、producer、输入lease、目标与control_mode、context_versions、动作/profile引用及deadline。字段的精确形状以第14.6节和附录B为准，不接纳扁平别名。Broker对撤权、上下文变化和命令接纳排序，清理旧后缀并确认隔离后才交接。

仅接口接受、观察到动作发生、业务成功证据成立分别回报。失焦、页面突变、证据过期、人工接管本地撤权；新主控返回不自动恢复。停止输入不等于暂停游戏，回退计划不撤销剧情或资源消耗。

第三方后端若不能保证全部自动输入源可隔离并确认停止，不进入安全热交接链路。可以仅用数据/建议能力，或经独占模式明确限制，不声称它已经成为可安全并行的控制器。

### 13.4 NarrativeRecord与主播Segment

`NarrativeRecord`至少包含：`narrative_id / story_session_id / occurrence_id / speaker / text_revision / text / choices / first_seen / last_seen / completeness / evidence_refs / input_context_epoch / story_scope`。

采集、理解、表达、推进独立记录：

| 维度 | 权威与状态内容 |
|---|---|
| capture | Game Runtime：partial/complete/gap与原始证据 |
| understanding | 关联分析Task结果：待分析、候选已解释、证据不足 |
| speech | 引用Bellis Utterance/Segment真实queued/输出/终态，不由游戏侧自报播完 |
| advance | Game Runtime Effect：未请求、已提交、已观察推进、未决 |

这些是跨对象投影，不再建一套与第11章竞争的媒体状态机。逐字显示是同一出现实例的text_revision更新；页面重复绘制不等于新对白。同样文字在另一个剧情时刻出现也可能是真的新事件，不能只按文本hash去重。

### 13.5 阅读节奏契约

| 场景 | 可推进条件与失败处理 |
|---|---|
| 手动推进对白 | 完整采集＋最短阅读时间＋当前profile规定的原声或必要朗读完成；有明确最长等待 |
| 普通评论 | 默认非推进前置；可延后，不能无限卡剧情 |
| 无障碍／必须朗读模式 | 绑定指定Utterance正常完成，取消/文字降级不冒充语音完成 |
| 选项页面 | 必须进入明确选择策略；LLM超时不能静默选默认项 |
| 自动消失对白 | 优先采集并保留缺口；不假设游戏能暂停，不等待评论而阻塞本地必要行为 |
| 未知页面 | 重新观察；必要时停止控制并接管，不依赖旧截图长串点击 |

Game Runtime报告原声busy/idle/unknown、来源、置信度与过期。Busy是新发言启动软条件；关键剧情可按预授权规则申请安全边界软收尾，普通音量变化不硬打断。到期unknown按有限等待或已批准策略处理，不能导致整场永久沉默。

### 13.6 剧情范围与证据推理

planner.game仅获得当前story_scope内被允许的证词、观察和疑点，不注入全攻略。结论保留evidence_refs并核验存在、来源、范围、时效及支持关系；角色证词与模型诊断不自动变成事实。

读档、剧情分支变化或游戏重启由Game Runtime分配新的真实story_scope。scope是带来源的范围身份，不可仅按字符串／数字大小判定“更早所以能读”。当前允许阅读的scope集合由受信剧情可见性策略给出；未证明可见的失败分支资料默认不进入新推理。

恢复可保留经审核的操作经验，例如“动画结束前不要再次确认”，但不能把未来答案或分支结果伪装成通用经验。ReflectionRecord、缓存、摘要、失败分析和公开评论均受同一范围约束；审计保留历史不代表主控可以读取，更不代表可以播出。第18.6–18.7节规定先过滤后注入。

模型训练先验无法靠Prompt消除。系统可验证的是输入来源与公开输出边界；无法支持的答案标推测或不采用，剧透检查不给主控回传未来答案。

### 13.7 游戏记忆与证据

Game Runtime保留原始必要证据和本地执行日志，向Bellis交语义事件/引用。集成模式的长期写入统一通过Bellis PrivacyGateway，游戏侧MemoryBridge不另外直写Iris；独立模式需要同等隐私契约并在接入Bellis时交接写入owner。

原始帧有界保留；关键证词适当固化；无关桌面和凭证不进入模型或直播。采集缺口、新旧状态差异、人工接管和未支持页面要在运营面板可见。

### 13.8 命令身份、版本和取消回执

Bridge.quiesce/restore与Controller保持同名。Task.pause/resume是业务层请求，网关显式路由并核对Manifest支持；不将HTTP/JSON-RPC端点同时登记pause与quiesce别名。Controller使用PREPARED，SessionService使用READY。所有旧命名仅由离线迁移器识别，线上未知字段/接口拒绝。

cancel_policy_update使用新的operation_id，指向原policy_update_id与当前目标实例。RECEIVED/VALIDATED/SCHEDULED可在policy_cancel_safe成立时CANCELLED；APPLYING无法证明确未切换则返回POLICY_CANCEL_TOO_LATE，不更改状态，原更新随后仍必须发布真实终态；APPLIED不可取消，回退是以当前revision为base的新更新。重复取消返回同一既有回执，不取消整个控制Task。

### 13.9 指定目标定位与派生视图

RankGround使用区域选择后局部定位的结构；本版将这一启发落实为可替换的只读定位适配器，不要求所有页面或所有后端使用该论文模型。[S39]

```text
已采用目标／冻结投票winner＋当前根截图
→ GroundingRequest（目标不可由定位器改写）
→ 简单固定适配、整图定位或区域选择后定位
→ GroundingResult＋根证据／派生视图／回映坐标
→ Game Runtime验证目标身份、页面、affordance和输入条件
→ 原有选择Action → Interpreter → ActionCommand／ControlFrame → Broker
→ 新观察确认Effect及输入清理
```

v0.8的DerivedView只支持根游戏客户区上的轴对齐裁剪与无padding缩放。`crop_root_px=(x0,y0,wc,hc)`、输出尺寸`(wv,hv)`，view点`(xv,yv)`到根点：

```text
xr = x0 + xv * wc / wv
yr = y0 + yv * hc / hv
xn = xr / root_width_px
yn = yr / root_height_px
```

像素位置使用连续坐标和半开边界，root原点为客户区左上。显示／OS屏幕坐标转换仍由已验证ControlProfile完成。旋转、透视、letterbox和非线性变换不在本版DerivedView支持范围，不能假设它们等价于resize；需要时先扩展契约与测试。

模型看到的局部view、根截图、目标描述和必要面板上下文必须关联同一请求及scope；例如“右侧面板第二项”不能裁掉面板语义后仍声称身份已确认。根DPI／窗口变化使旧结果失效；换ROI仅生成新view_id，不全局提升transform_version。

### 13.10 定位结果的拒绝与效力

| status | 含义 | 后续允许行为 |
|---|---|---|
| FOUND | 当前目标在声明范围得到核验，回映位置及依据齐全 | 仅形成动作候选；执行前继续检查新鲜度、目标、权限与Effect。 |
| ABSENT | 有覆盖与核验证据说明目标在本次受限检查范围不存在 | 不点击；等待／重观察／已批准回退。 |
| AMBIGUOUS | 多个相似候选无法可靠区分 | 不选相对最高分强行点击。 |
| INSUFFICIENT | 检查范围／证据／质量不足，无法断言存在或缺失 | 只读补证据，或申请有副作用的主动观察Task。 |
| STALE | 根观察、页面、目标或依赖已失效 | 丢弃坐标；按预算重新捕获与定位。 |

没有找到不是已证明ABSENT；排序第一不是已证明FOUND。GroundingResult的verification_ref必须指向受信核验步骤的证据，模型自己填字符串无效。非FOUND没有可执行location；score仅诊断且可为null，跨crop比较必须有经验证的校准策略。

定位尚未提交输入时的不确定属于感知质量，不能单独把整个Activity推进RECONCILING或创建IN_DOUBT Effect。输入已发出后结果不明则回到第7章对账，定位器不得为了“再找准一点”重发同一业务选择。

### 13.11 定位profile与首个游戏适配

GroundingProfile登记策略direct_adapter／full_frame／rank_then_ground、候选crop上限、最多定位调用数、最大根观察年龄、允许变换、目标核验规则与失败出口。首个profile保留已有简单适配作为基线；区域重排只在基线确有困难且测出收益的页面启用。

指针选择在`game.validate_choice_context`中建立choice_ref到目标、choice_instance、GroundingResult和根证据的关联；`game.choose_option`执行前再次校验，不能长期保存裸x/y直接复用。投票winner和Effect.semantic_key不因更换crop、模型或再次定位而变化。键盘菜单导航如有可靠语义证据，可不使用坐标定位。

默认rank_then_ground只做一次最终定位；增加Top-k、二次整图或重新采集属于显式有限回退，不根据单次坐标Token置信度自动循环。S39本身提示跨裁剪置信度与动态／多语言迁移的限制，不能将桌面基准结果视为中文剧情游戏验收。[S39]

P5先用脱敏静态页面、目标缺失、相似中文选项、DPI变化和动画中的页面测试只读输出，再持test_only验证实际选择。完整延迟包含采集、crop、重排、最终模型和坐标核验，不能只计算最终一次VLM调用。
