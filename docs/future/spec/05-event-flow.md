## 5. 事件流与非阻塞主控

> 冻结的后续阶段设计，不参与生成与校验；现行部分见 [docs/spec/05-event-flow.md](../../spec/05-event-flow.md)。

### 5.1 两个循环与单一采用边界

EventReactor持续接入、鉴权、归约、关联事件；DecisionLoop在可运行机会冻结快照、调用一次主控、接收有界结构化输出。主控默认推理并发为1；规划Worker、合成、审核、计票、Stage与游戏侧任务可以并行。

启动长工作：先登记Task与必要Attempt/外部操作，再派发并立即返回JobHandle。主控不等待`.result()`、整场投票、全部音频或游戏分析；结果和进度通过事件更新WorkRegistry。句柄返回不证明远端已经接受。

正在进行的普通主控调用不强行插入新Prompt。若它很慢，现有授权任务继续；推理自身的deadline或Token预算生效，不因新弹幕取消重开。

### 5.2 普通弹幕入流规则

```text
普通消息到达 → 规范化／安全分流 → 有界候选等待
             → 标记chat_pending，不改变任何对象范围的CancelFence
             → 下一允许选择点入选
             → 准备受限后续回复
             → 等已有发言自然结束后按分类队列选择
```

刷屏、礼物正文、昵称、@主播均不变成停止指令。新消息可以影响尚未采用候选的评分，不能替换在途回复或抢断发言。安全输入通常丢弃/隔离；只有受信检测确认**当前输出**存在风险或权限失效，才走安全停止，不因一条攻击消息本身触发全场中断。

### 5.4 不丢失唤醒的等待协议

WaitEvent首先在权威边界登记event_names、expected_source、correlation、cursor、predicate、timeout_ms、on_timeout和on_gap，之后才允许触发相关操作。存在事件已先发生的可能时，使用“登记→查询当前权威状态→从游标补读”，事件与查询结果幂等合并。

WaitRegistration有REGISTERED、ARMED与SATISFIED/TIMED_OUT/CANCELLED/GAP终态，登记在第11章。等待只占有界订阅额度，不持有发声/输入资源，不阻塞主控。predicate=unknown不满足等待；已知覆盖缺口走on_gap，不等到普通超时才伪装无事件。

event_names是显式有限集合，不用单一成功topic隐式代表整组事件。等策略结果时必须登记同update_id的applied/rejected/expired/cancelled/unknown五类终态；predicate只核验共同关联与有效事实，不能过滤掉非成功终态。任一匹配终态使WaitRegistration=SATISFIED，含义仅为“结果事件已收到”；WaitEvent结果携matched_event_name及原payload，后续Switch立即按实际APPLIED/REJECTED/EXPIRED/CANCELLED/UNKNOWN分流。等待成功不等于策略应用成功，也不等待失败对象再次发applied。等待超时和Task总截止分别记录，均不能刷新原业务期限。

WaitEvent/WaitSpec的predicate可用保留节点名$event读取当前事件，例如path=/event_name。$event不得作为Plan节点ID或Action输入绑定；它只在等待谓词中生效。EventCursor.after_seq=-1表示流首条之前；source_seq缺失的上游必须使用本地可靠入流游标并保留coverage缺口说明，不能将本地游标当上游完整性证明。

### 5.5 决策快照与结果失效

快照包含当前Goal与Plan版本、进行中Task和Attempt摘要、待处理信号、有限候选、动态能力、相关证据年龄和已播事实。无需每次把全日志送给模型。

新普通弹幕仅更新事件游标；游戏选项、voice profile、证据范围、前序发言结果等实际依赖变化时，定向使候选／未执行动作／未播片段重新校验或撤销。已播放事实不回滚；已在播安全片段是否软收尾按预授权规则，不能由普通弹幕触发。

候选来自旧Attempt时只能记迟到证据，不覆盖current_attempt_id或活跃结果。允许作为受控缓存引用时，也必须以新候选重新验证，不能恢复旧执行权。

### 5.6 主控输出与多工作协作

主控的唯一候选输入面为第12.2节DirectorRecord。普通聊天使用speech_segment/end_utterance；辅助分析和有限能力使用包含完整Action的action_proposal；登记计划采用、兼容策略修改和文字降级各有明确记录类型。`WorkRegistry.create_task`是宿主内部接口，模型没有额外的task.spawn命令或绕过Action校验的工具别名。

宿主在校验、权限和预算通过后登记Task/Attempt/外部关联并立即返回句柄；结果通过事件交回。主控不等待整场投票、全部TTS或游戏工作完成。已批准活动分支可确定性推进，不为每个步骤重新询问LLM。

可以在发言中准备有限后续回复。启动前核验前序Utterance的真实outcome与output_prefix_ref；要求COMPLETED的承接语不能接在提前终止后。独立模板可显式使用any_accounted，但不得暗示前文已正常说完。信号合并有最大等待，不使用不断刷新截止的无限防抖。

### 5.7 感知和恢复结果的事件接入

按需定位任务产生`grounding.result_recorded`，其中FOUND/ABSENT/AMBIGUOUS/INSUFFICIENT/STALE都是计算结果，不自动满足游戏选择成功。缺少结果的Provider失败／任务deadline仍用既有Task终态通知，等待方不得只等FOUND。

恢复动作的最终证据用`recovery.result_recorded`通知，保留原Task/Attempt与操作身份；这不是恢复授权或另一次实际操作。反思和上下文视图可通过已有`artifact.available`引用，载荷通过登记契约和访问控制解析。高频候选、ROI评分和缓存命中不逐帧进入Bellis可靠事件流；请求结果与必要故障保留可靠身份，普通进度可采样。

来源/实例/业务发生范围、任务结束和图分支规则沿用第5.3–5.5节。模型或截图中的指令不能铸造这些事件；普通弹幕仍不抢占当前工作。
