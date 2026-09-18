## 12. 流式表达与媒体同步

> 第 12.2 节属于后续阶段，冻结在 [docs/future/spec/12-media-streaming.md](../future/spec/12-media-streaming.md)。

### 12.1 流式能力声明

LLM可见文本增量、TTS文本增量输入、TTS音频增量输出/Stage消费是三件事。能力协商分别声明`incremental_text_input / audio_delivery / audio_scope / timing_granularity / flow_control`。不能只写一个streaming=true。

正式低延迟路径按已定稿、已审核的稳定语义片段增量提交，不等完整回答或全部音频。仅支持完整音频的适配器可用`audio_delivery=complete_segment`兼容；不能据此声称片段内部音频也流式。至少一个真正音频增量消费组合进入P2验收。

### 12.3 双文本、读音与不可变绑定

| 字段 | 含义 |
|---|---|
| display_text | 审核后字幕文字，不是原始弹幕直通 |
| spoken_text | 真正送入TTS的规范化朗读文字 |
| speech_markup | 宿主从白名单生成的发音/停顿控制，不接收任意外来SSML |
| alignment_map | 朗读span到显示span的多对多映射，Unicode码点半开区间 |
| voice_profile / pronunciation_profile | 音色、许可、语言、语速、词典、情绪能力与版本 |
| approved_prefix_digest / output_prefix_ref | 逻辑已批准前缀／实际已输出事实，二者分开 |

缩写、数字、多音字、角色名和安全昵称先规范化，再最终审核。修改读法、词典、voice或文本后旧凭据和旧音频不能复用。映射不可靠时显示完整片段字幕，不用字数比例冒充逐词时序。

已提交片段内容不可修改。流式审核可以检查已批准的有序前缀并与实际已播情况关联，不要求每个采样重新审核；前驱被SKIPPED或内容依赖改变时，受影响的未播片段必须失效重审，避免“去掉中间一句”形成新风险组合。

### 12.4 普通合成与受控推测合成

```text
完整可见记录 → 稳定语义片段 → 双文本/读音/最小外发检查
                          ├─ 必需内容审核 → 审核凭据
                          └─ 可选推测TTS → 有界隔离缓存（不可播放）
审核＋权限＋依赖＋预算＋voice/hash一致
                          ↓
                segment.commit可靠记录
                          ↓
        普通模式此时请求TTS / 推测模式释放匹配音频
                          ↓
             Stage当前片段预缓冲＋审核字幕就绪
                          ↓
             在本地时间线上边收边播
```

`speculative_tts`默认关闭。开启需外发许可、Provider用途核对、有限浪费预算、隔离凭证、拒绝销毁与泄漏测试。未经公开审核的内容可以在被批准的推测支路合成，但**不能进入Stage可播缓冲**；拒绝/超时/改文后原hash音频销毁。

必需审核阻塞正式许可；审核服务不可用不能按时限直接放行。语义片段不能按固定字数切出未完成意思。当前片段正常启动不等待全回答seal、所有音频EOS、完整词级对齐或复杂表情。

可选表情时限与必需准备并行；已满足开口条件后不额外等装饰。迟到表情只允许加入尚未经过的有效时间位置，不能补到另一个话题。需要严格动作的特殊Scene使用独立策略。

### 12.5 Utterance级seal与Scene关闭

| 操作 | 语义 |
|---|---|
| scene.open | 打开有限演出容器并登记owner，不授权未来任意内容 |
| utterance.open | 创建连续发言，固定voice、audio_scope和输出边界 |
| segment.commit | 冻结并采用一个连续编号片段；绑定审核、双文本、依赖与资源 |
| utterance.seal | 冻结最后已提交seq与close_reason，停止追加；不是播完 |
| scene.close | 冻结子对象集合，不含last_segment_seq，不代表所有子对象成功 |
| audio.eos | 音频流末采样声明；还需连续性、边界和解码尾部验证 |
| segment.output_completed | 指定片段实际输出完成 |
| utterance.output_completed | 仅normal完成；全部必需片段/EOS/输出排空满足 |

Scene、Utterance、Segment的持久化字段登记为SceneRecord、UtteranceRecord与SegmentRecord（字段见[P1契约简报](../generated/P1.md#字段结构)），含追加状态、last_seq、cutoff、dispatch_revision、承接依赖、flow_state与实际输出范围。seal记录一旦接受不可改变。没有提交过片段可last_seq=-1，但空发言不满足正常播出完成。后续发生提前结束，另记termination_reason、cutoff和撤权，不重写normal seal历史。

正常完成要求：Admission=SEALED且reason=normal；至少一个已提交片段；0..last_seq全部唯一且OUTPUT_COMPLETED；对应音频流全部EOS_VALIDATED；无拒绝后截尾、SKIPPED、取消、失败、未知或后来异常终止；声明输出边界已排空。任何过渡模板的完成不能替代原对象条件。

### 12.6 音频流作用域与格式

`audio_scope=segment`为默认：每Segment一个有效AudioStream，独立EOS；允许上一片段播放时下一片段合成。`audio_scope=utterance`可选：一个流覆盖多Segment，必须有可靠`audio.segment_boundary`和逐片段许可隔离。打开Utterance时锁定，不中途换模式。

流格式固定编码/PCM类型、采样率、声道；AudioChunk含流实例、seq、采样偏移/数量或可验证解码映射、长度和校验。EOS包含`final_sample_exclusive`；按半开区间核验连续性。网络包边界不是语义片段边界。

重包同内容只回执不重播；同序号不同内容拒绝；乱序有限缓存；缺片过期失败。连接断开不能冒充EOS。完整音频未生成时使用冻结文本摘要、流绑定与分片校验，不要求先拿到最终文件hash才播放。

连续TTS无法可靠隔离未获许可后缀时，禁用其跨片段推测，降级segment模式或拒绝该能力组合。已确认输出的音频不能为恢复而从头重试。

### 12.7 Stage媒体链路

```text
已授权增量音频 → 有界媒体通道 → 解码/重采样Worker
             → 有限PCM环形缓冲 → AudioWorklet
                                   ├─ 音频输出
                                   └─ 内容位置/欠载/回执 → 字幕/口型
```

`decodeAudioData()`面向完整音频文件，不应被当作任意网络分片解码器；AudioWorklet适用于自定义音频处理，具体OBS内嵌浏览器兼容性仍须探测。[S10][S11]

音频处理回调只做有界复制/混音/游标更新，不做网络、模型、数据库、长锁或大分配。SharedArrayBuffer只在环境满足安全条件时可用，不是强制依赖；否则用有界可转移缓冲，不能为性能关闭浏览器保护。

### 12.8 内容时间与同步

`p_content`为声明本地输出边界上的内容位置或有误差说明的估计。字幕与口型随内容推进，不随token到达、TTS回调或墙钟推进。Provider产生的正常静音属于内容；欠载补零不增加内容位置。

Web Audio的调度时间与输出位置不同，`getOutputTimestamp()`可用于关联音频输出和性能时钟；其可用性与OBS路由必须实测，不直接用currentTime冒充已输出。[S2] 宿主不逐字发定时消息；Node定时器不是精确媒体时钟。[S3]

字词标记迟到只用于未来位置，缺失则片段字幕；发音映射不可靠不做伪逐词高亮。VTube Studio按软同步测量，一个Avatar适配器统一合成待机、口型和表情后注入，不让多个插件抢同参数。[S4]

### 12.9 背压与EOS

分别限制未审核文本字节、已定稿未合成时长、隔离音频、可播PCM、待播Utterance和网络发送窗口。Stage反馈credit；上游高水位暂停后续追加/合成；Provider不可暂停时有限承接，超预算按故障策略终止，不无界缓存。

预缓冲有最小启动、目标和最大量。短片段可靠EOS且数据全到时可小于启动目标。欠载进入PLAYING.BUFFERING，冻结内容位置并限时恢复；长期缺片不跳过后宣称成功。文本结束、seal、EOS、片段播完、整段输出完成分别记录。

### 12.10 软收尾、硬停与前序依赖

软收尾来源限认证操作员、受信安全/依赖规则和预授权剧情事件，普通弹幕不能触发。SceneDirector在同一归约中关闭UtteranceAdmission、冻结本次close_request并停止后续commit；然后发送带dispatch_revision的有限尾部栅栏请求。Stage按其本地顺序决定实际cutoff：已开始且安全的片段可到有限边界，之后的未播许可撤销。宿主不能仅凭自己的排队视图假定Stage尚未开口。

QUEUED和OPENED同样先进入DRAINING，确认所有尾部撤销/无输出后才能ENDED_EARLY；不直接跳过核验。若子Segment已经UNKNOWN，即使没有first_output回执，Utterance也进入UNKNOWN并隔离。Stage回报`media.tail_fenced`须包含端点实例、revision、cutoff、最终已开始/已输出范围及撤尾证据。

已SEALED对象保留原last_seq和close_reason；后来软收尾另记termination_reason。dispatch_revision只控制本Utterance尾部：明确保留前缀可凭旧hash/实例/seq授权继续，旧尾部无论在网络还是PCM中都不能越界。到界/栅栏确认超时升级硬停或UNKNOWN，不能无限保持DRAINING。

硬停止先撤本地许可、停止/静音、清PCM/字幕/口型；远端取消与日志并行。STOPPING仍接收最终完整输出证明；若原normal范围事实上已完整结束且没有ABORTED/实际截尾，可以COMPLETED；否则按真实部分输出、期限、取消或未知结案。仅收到stop_ack不能猜测原结果。

下一发言携带predecessor_utterance_id、requires_outcome与output_prefix_ref。前序提前结束/取消/失败/未知只使显式依赖的承接草稿失效；无关工作继续。过渡模板是新Utterance，不能补成原对象成功，也不能释放原“播完后再选择”的依赖。

### 12.11 听感与文字降级

voice profile固定音色、授权、词典、语速、情绪、上下文传递和停顿策略。TTS上下文若可传入，只发送允许外发的必要前文并与待朗读正文区分。语义分段与实际边界一起控制停顿，避免句末静音重复、交叉淡化切掉辅音。

测试同时看发音、韵律、衔接、音色与首声延迟，不以PCM连续证明自然。TTS故障默认文字模式＋许可清楚的同音色预录提示，不暗换声音；备用音色仅在验证/告知并获批准后的新Utterance边界切换。

文字模式新建TextPresentation，使用`text_display.completed`，不能伪造语音EOS或utterance.output_completed；原语音依赖的游戏动作等待重新授权。Stage本身故障时应急提示走独立OBS固定安全场景。
