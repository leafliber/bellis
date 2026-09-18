## 附录A 端到端场景走查

本附录的轨迹说明各章规则如何组合；状态名称与合法转换以第11章为准。

> 冻结的后续阶段设计，不参与生成与校验；现行部分见 [docs/spec/a-walkthroughs.md](../../spec/a-walkthroughs.md)。

### A.1 普通聊天的最小路径

```text
弹幕A入流 → 安全选择 → Task(reply_A)登记
→ Attempt(reply_A,1)启动主控流／或接入当前主控输出
→ scene.open / utterance.open
→ Segment0定稿、审核、提交、流式合成／输出
→ Segment1继续准备；弹幕B/C仅等待
→ utterance.seal(normal)；各音频EOS校验；输出排空
→ utterance.output_completed
→ Scene关闭并聚合；对应Attempt结果成立
→ 发声资源清理确认、Settlement=SETTLED
→ Task FINISHED(SUCCEEDED)，下一候选可开始
```

主控推理本身可作为只读compute Task；“发言Task”以子Scene实际输出作为结果。实现时用不同能力/result_contract区分，不把模型生成完成的Attempt误当整段发言完成。派发返回句柄，主控不阻塞等待上述整条路径。

### A.2 投票选择完整PlanDraft

以下是离线文档fixture，api_version=bellis.activity/0.8.0。它包含19节点，其中17个完整Action和两个Switch；所有能力/结果/输入/权限/模板/完成与失败引用均在本交付契约注册表登记。采用对象还须生成和验证digest、绑定真实权限/上下文，不能直接将本fixture用于真机。

第一轮winner→announce_1→revalidate_1→choose_1；第一轮tie且无已知缺口→draft_2→explain_2→vote_2；第二轮winner进入choose_2；第二轮仍平/零票/缺口走review_2；任何三值条件unknown走对应review_unknown。两轮均在开票前说明同一冻结规则，且选择动作前再次核验页面。

{{plan_fixture}}

投票规则在inputs.rules内，不存在Action.policy；服务不含include_in_completion_join。每Action有结果和总timeout_ms；两轮耗时共同受180000ms活动总预算限制。第二轮不是重试第一次投票，round_index最多2；所有choose引用相同current_choice_once@1/choice_instance，不能重复产生业务效果。

未选路径递归关闭SKIPPED；采纳某一分支不能读取另一路未执行结果。第一轮无winner的样本不会去解析revalidate_1的winner_id，二次输入Schema检查只作用于实际启用路径。结果/失败合同已在registry固定：成功要原选择效果确认及输入SETTLED；人工复核只得到BLOCKED；超时/失败/未知按真实原因结案。

### A.3 已知回执丢失与重试

```text
Task T，Attempt A1，Effect E
→ E意图登记，operation O1派发
→ 游戏可能已选择，但回执丢失
→ A1=UNKNOWN；Task=RECONCILING；E=IN_DOUBT
→ Broker清理得到确认，Settlement可以SETTLED
→ 仍禁止重复选择，因为Effect未确认
→ 只读核验找到选择已经发生：追加Reconciliation，E=CONFIRMED
→ Task依据证据结案，不启动A2，不重发O1的新效果
```

只有确认无效果、旧派发不可能再生效、清理完成且授权仍有效时，才允许同E的新Attempt A2；仍累计同恢复预算。结果UNKNOWN与资源已清理可同时存在，不能混成一个success布尔量。

### A.4 从推进游戏切到复盘

操作员提出新的活动目标/策略→候选基于当前revision准备→标出保留的剧情采集服务、已完成证据、正在安全播放的无关表达→受影响游戏推进Task到检查点并清理→重新检查页面/效果→本地PlanRef提交→外部Runtime实际应用回执→新增复盘分析Task。

不清空整个Session、不重新读已播剧情、不重开已完成投票、不把游戏暂停理解成时间冻结。已经结束的Task保持结果，尚未运行后继可以重排；旧Goal相关候选失效，无关状态继续。

### A.5 安全拒绝与后续发言

Segment0已经安全输出，Segment1审核拒绝→原Utterance关闭追加并软收尾/硬停→未播尾部SKIPPED→原结果ENDED_EARLY或BLOCKED/FAILED→新安全过渡Utterance按许可播放。

预准备的下一句若依赖原Utterance COMPLETED则作废/重生成；独立投票面板仍可显示真实结果。过渡完成、Scene关闭、业务Task失败结算都不能误触发原“正常播完后选择”的条件。

### A.6 兼容调参与聊天并行的完整轨迹

```text
Game Task A / Attempt A1：continuous_local在Policy r12下跟踪目标
→ 本地持续使用新观察产生短ControlFrame，Broker有界续租
→ Bellis正在播放已审核Utterance U；新普通弹幕只排队
→ 主控在允许决策点采用参数候选P（base=r12，目标/实例/期限绑定）
→ Game Runtime登记PolicyUpdate P；主控立即取得外部句柄继续调控
→ P校验通过，等待一个有界本地决策边界；A1在r12下继续
→ 本地再次校验，应用r13，固定effective_control_seq，隔离旧未执行后缀
→ 新帧使用r13；不重开A1、不释放根owner、不重播U
→ control.policy_applied进入Bellis；此时只能说参数已应用
→ 后续观察显示目标更居中／距离改变，才产生对应进展事件
```

若另一个更新先应用、目标已变或候选过期，P被拒，不能改base重试。如果r12也已不适用，本地立即按能力降级，不能等待云端替代方案。控制帧与策略revision是游戏侧权威记录，Bellis不替它更新“已应用”。

### A.7 感知冻结与输入续租

假后端持续返回同一个capture_sequence而控制循环仍正常tick：超过该能力观察有效窗后，健康续租拒绝，Broker在许可边界释放本系统保持键并拒绝旧帧。原Task按已注册降级/接管路径推进，普通弹幕和安全字幕可以继续。

反例测试：界面静止但新的捕获序号与有效采集时间持续产生，不能仅因像素hash相同就误报冻结。两种情况都要记录实际依据、时限与停止边界，不用“有心跳”证明闭环正常。

### A.8 组合输入重复、迟到与未知效果

ControlFrame F包含后退保持状态、相对镜头增量和一个独立短按。F重复到达：只返回原receipt，不再次转镜头、短按或延长保持时间。下一纯状态帧可以改变保持集合，但不能顺便重放F的脉冲。

若后端只确认部分输入已提交，标PARTIAL/UNKNOWN和可确认子集；涉及业务Effect的短按进入对账，不能换frame/pulse ID再次发送。旧owner交出控制后到达的KEY_UP不会释放新owner的状态；做不到可靠交接的后端不得进入该模式。

### A.9 策略已应用但回执丢失

目标Runtime已经应用r13并保留原事实，但Bellis没有收到确认：外部投影标未知，保持update_id和当前owner。主控不得重新提交r12→r13来“补上”；通过get_policy_update查询原event_id、revision、生效边界与证据，原事实重放只消费一次。查询不是新应用事件，不能把查询时间当applied_at。若目标自身已因证据缺口终态UNKNOWN，则以Reconciliation追加查明的历史事实而不重开终态；若仍不可靠，按目标侧可确认条件控制或降级，宿主不宣布策略成功。

即使P最终APPLIED，也不会自动结束跟踪Task；正常Task结果仍等待目标证据、Effect和Settlement。恢复历史未知不复活任何终态Attempt。

### A.10 人工接管与可选示范

人工接管优先撤销自动输入，完成可核验清理；未开启示范用途时只保留必要运行审计。已获许可时记录接管前观察、真实输入组合、当前目标/profile、来源与结果，标为rescue或其它实际类型；不自动标专家正确。

离线整理、训练和真机批准完成后才可能部署新后端；原直播里的接管事件不自动修改当前模型、不回灌未经审核的Iris事实，也不自动重新取得输入授权。

### A.11 超时后收到真实完成

A1已派发，Node截止触发STOPPING；停止请求发出后收到端点最终水位，证实效果在截止前完成、只是回执迟到。A1=SUCCEEDED、deadline_missed按实际时间核验，清理SETTLED后Task可SUCCEEDED，停止触发记录保留。若效果实际截止后才发生，Effect仍CONFIRMED，要求按时的Task=EXPIRED；不补点。无可验证最终水位则UNKNOWN。

### A.12 常驻聊天的局部未知

chat Activity.RUNNING中的Scene U1输出回执缺失；U1=UNKNOWN并封锁该发声资源/效果范围，Activity保持RUNNING。被动观察和无冲突计算继续；取得Stage实际停止/输出对账后，释放对应资源，新Utterance重新授权。Activity不会因一次未知自动FINISHED；Stage资源未清理时也不会用新U2越过隔离强行说话。

### A.13 证据永久丢失后的人工结案

旧游戏选择Effect.IN_DOUBT，游戏重启使结果证据丢失。操作员close_unresolved→CLOSED_UNRESOLVED，旧Task UNKNOWN，旧semantic_key墓碑保留。随后由Broker/主机证明旧输入已清理或安全隔离，建立新game_session/真实选择发生scope并重新授权；新活动可以继续。仅游戏窗口消失不构成旧OS输入清理证明。

### A.15 投票结果不变，目标重新定位

第一轮平票→按预先冻结规则第二轮得到winner_B→原结果播报normal完成→Game Runtime读取新根截图→GroundingRequest固定winner_B与原choice_instance→产生FOUND结果并验证root/view映射→choice_ref绑定该结果→执行前再次核验→同一EffectIntent的一次选择→确认效果与输入清理。

如果根窗口变化或目标歧义，旧坐标不使用；按预算重新观察或人工接管。重新定位不重开投票、不更改winner、不生成第二个业务效果。以下为只读合成定位产物，不含输入许可：

{{grounding_result_fixture}}

### A.16 失败后的经验筛选，不恢复旧世界陈述

Attempt A1尝试在动画未结束时选择，结果已证明无效果且完成清理。运行时保存失败事实；反思记录“应等待页面稳定”的操作经验和“可能是布局变了”的诊断假设，二者不混成已证实事实。

若Activity与Task仍开放、deadline／预算仍允许，经当前scope与隐私过滤生成RecoveryContextView，以新观察为当前状态。A2是新Attempt；同一选择沿用EffectIntent，不能重用A1的lease。若A1实际为UNKNOWN，停在只读对账，不由诊断决定重试。

{{reflection_record_fixture}}

### A.17 慢候选到达时目标位置发生变化

候选P基于较早观察，表示在当前Goal下有限镜头调整。新观察显示同目标移动，语义scope与profile仍匹配；Broker的ExecutionPrefix证明哪些输入已提交且没有未决命令。编辑器只对尚未提交的连续后缀产生新候选E；E带新观察、prefix引用及不超过当前授权的期限。

解释器把E编译为新ControlFrame，Broker再次核验；不改P或既有frame载荷。若前缀在计算中变化、目标已切换、出现确认pulse或提交范围不明，则拒绝修正并按当前合法降级处理。没有路径能用Q分数绕过这些检查。

### A.18 游戏读档与不能回滚的历史

操作员批准某Game Pack已验证的game_save恢复范围。系统撤旧输入、核对Effect与清理、登记新的恢复Action与必要Effect，再通过受控输入读档。恢复后读取真实新画面并核验存档后置条件，生成新story_scope与RecoveryResult。

原分支已播内容、旧选择Effect、墓碑、费用与授权记录继续存在。新上下文过滤原分支剧情答案，只保留经复核且确实独立的操作经验。已FINISHED的Task不会重开；必要的新Task保留supersedes_task_id与原恢复预算引用。若读档回执不明，恢复Action结案UNKNOWN并只读对账，不再次自动读档。
