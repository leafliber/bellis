## 附录C 术语表

> 第3.1–3.3节已定义的角色与机制不在此重复；只涉及后续阶段的术语冻结在 [docs/future/spec/c-glossary.md](../future/spec/c-glossary.md)。

| 术语 | 说明 | 见 |
|---|---|---|
| CancelFence | 指定取消作用域及代次的栅栏，用于拒绝旧后缀；不等同端点已经停止 | 第7.9、11.6节 |
| incident | 安全封锁、记录失败或未知范围的异常事实；记录是否落盘与实际安全状态分开 | 第11.6节 |
| Bellis／贝莉 | 一个角色、多项工作、单一高层采用权的软实时直播运行时；宿主进程称Bellis Host | 第1.1、22.3节 |
| ContentGuard | 双文本、读音、跨片段前缀、证据、隐私与输出风险审核；输出APPROVED／REJECTED／NEEDS_MORE_CONTEXT／UNAVAILABLE | 第3.3、17.2节 |
| Stage | 受信媒体端：增量播放、审核字幕、Avatar适配，声明播放位置、尾部栅栏和停止事实；没有键鼠能力 | 第3.3、12.7、13.1节 |
| Overlay | 另一Origin的低权限公开只读展示 | 第19.2节 |
| Game Pack | 装在Game Runtime侧的游戏适配包；新增游戏只增Game Pack与场景测试 | 第3.9节 |
| game.bridge | 会话配对、能力、候选、外部Task投影、效果／检查点与剧情事件的通用桥接插件 | 第3.9、13.2节 |
| Session／Goal／Activity | 直播会话／语义目标及版本／提供生命周期、预算与授权范围的一段直播业务 | 第4.1、4.2、6.1节 |
| Task | 一项稳定的逻辑业务工作；重试不改变业务身份 | 第4.2、7.1节 |
| Attempt | Task的一次执行；重试或暂停后恢复创建新ID | 第4.2、7.1节 |
| JobHandle | Task查询与受控操作句柄，不另建Job状态机或新的owner | 第4.2节 |
| Operation（operation_id） | 一次有限协议命令的幂等ID；同ID不同载荷拒绝 | 第4.2、7.3节 |
| UNKNOWN | 结果无法确认的终态或结局；保留隔离与对账责任，不盲目重试 | 第7.7、11.5节 |
| Scene | 有限演出容器，只join有限子对象 | 第4.1、12.5节 |
| Utterance／UtteranceAdmission | 一次连续表达／其是否仍能追加片段的准入维度 | 第12.5节 |
| Segment | 冻结并采用的连续编号片段，绑定审核、双文本、依赖与资源 | 第12.5节 |
| seal | 冻结最后已提交seq与close_reason并停止追加；不代表播完 | 第12.5节 |
| EOS | 音频流末采样声明；还需连续性、边界和解码尾部验证 | 第12.5–12.6节 |
| TextPresentation | 文字降级表达对象，单独完成语义，不伪造语音EOS | 第12.11节 |
| 软收尾／硬停 | 固化cutoff、保留当前安全片段到有限边界并撤销尾部／本地立即撤销许可、停止或静音 | 第12.10节 |
| display_text／spoken_text | 审核后字幕文字／真正送入TTS的规范化朗读文字 | 第12.3节 |
| ExternalWorkRef | Bellis保存的远端工作引用，与带源revision的只读投影配合使用 | 第4.4节 |
| 监督模式 | supervised／restricted／unattended_approved／safe_stopping／stopped准入政策 | 第20.2节 |
| Shadow | 不注入输入、不抢夺真实玩家控制的旁路验证方式 | 第24.6、25.5节 |
| PASS／FAIL／PENDING／NOT_IMPLEMENTED | 预检与验收状态；PENDING与未实现均不能视为通过 | 第20.6、24.5节 |
| controller_prepared | 控制器专用准备证据守卫；不是service_prepared，也不授予执行权 | 第9.3、11.3节 |
| fence_and_handoff | 未知入口的强制本地封锁、状态归约与独立清理/对账移交动作 | 第11.6节 |
| SettlementCoordinator／RecoveryCoordinator | 各自权威Runtime的独立清理／对账职责；不随短命业务actor终止 | 第11.6、22.2节 |
| TerminationRecord | 停止/期限触发与生效栅栏/真实结果的独立记录 | 第6.9、7.9节 |
| CLOSED_UNRESOLVED / ABANDONED | 旧效果行政未知结案／放弃自动清理但保持资源隔离 | 第7.8、11章 |
| Scene.EMPTY | 子集合为空的无输出关闭；不满足语音完成条件 | 第11.5节 |
| ExecutionGrant.test_only | 仅有限受监督测试，不能公开播出或扩大目标 | 第20.2、25.3节 |
| StagePairing / connection_instance | 持久设备身份／一次连接实例，身份重连不恢复旧媒体许可 | 第19.3节 |
| epoch / revision / seq | 权限或范围世代／不可变内容版本／同源顺序，writer与scope见登记表 | 第4.11节 |
