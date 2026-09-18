## 3. 总体架构

> 第 3.4、3.11 节及 3.8（组件关系图）、3.9（控制相关能力的归属）属于后续阶段，冻结在 [docs/future/spec/03-architecture.md](../future/spec/03-architecture.md)。

### 3.1 职责主体

| 主体 | 职责 | 不负责 |
|---|---|---|
| `LiveDirector` 主控规划器 | 选择关注点、采用目标／候选计划、提交表达、请求范围内调整 | 直接播音、计票、驱动键鼠或签发审核许可 |
| `DomainPlanner` 辅助规划器 | 游戏推理、互动方案、对话草稿；返回版本化候选 | 独立获得正式播出权或修改活跃高层计划 |
| `ActivityRunner` 活动解释器 | 解释已采用PlanSpec、派生有限Task与事件分支 | 自创目标、绕过内核调度；不是第二个通用调度器 |
| `DomainController` 领域控制器 | 在授权下根据反馈完成任务、申请检查点、报告结果和清理 | 自行扩大权限或把提交成功当业务完成 |
| `Executor` 执行端 | 音频输出、字幕渲染、软件操作和实际回执 | 决定节目目标或凭消息正文推断权限 |
| `Provider` 能力提供器 | LLM/VLM、TTS、ASR、Embedding/Rerank等计算和数据转换 | 决定结果何时公开或改变所有权 |

**规划器决定做什么；运行时决定何时允许执行、怎样协调；控制器决定如何完成；执行端报告实际发生了什么。** TTS生成音频不等于播放完成。模型输出、接口接受、业务结果、清理结算是不同边界。

### 3.2 确定性运行机制

`DecisionLoop`负责主控调用与有限输出接入；`EventReactor`持续归约事件；`WorkRegistry`保存活动／Task／Attempt／服务句柄和外部投影；`SceneDirector`管理表达；`SyncCoordinator`协调同步；`SpeechArbiter`在空闲点选择发声。

这些是确定性机制，不是额外“大脑”。同一实现可以封装多个轻量模块，不按名称数量建立进程。角色设定和核心价值边界是受操作员管理的配置，不额外建立一个“人格LLM”来改写权限。

### 3.3 安全与领域权威

| 权威 | 负责什么 |
|---|---|
| 操作员／监督组件 | 授权范围、公开模式准入、人工接管与恢复 |
| CapabilityGateway／SafetyGate | 检查身份、预算、依赖、审核凭据和执行许可，不判断语义内容 |
| ContentGuard | 双文本、读音、跨片段前缀、证据、隐私与输出风险判断 |
| PrivacyGateway | 在检索和外发前执行用途、主体、来源、删除和地域约束 |
| Game Runtime | 游戏内部任务、尝试、页面状态、效果证据、检查点及本地输入授权 |
| Stage | 声明输出边界上的播放位置、尾部栅栏和停止事实 |
| Poll Engine | 本系统收到的有效票和冻结结果 |

一个字段只指定一个权威写入者。Bellis保存游戏任务的**带来源投影**，不复制游戏Runtime的第二套可写状态机。源服务失联时投影可以变为stale/unknown，不能用宿主期望值覆盖。

### 3.5 微内核边界

#### 通用内核职责

内核提供通用对象、解释与守卫，不硬编码平台消息字段、游戏人物、按钮坐标、投票文案或Provider私有参数。运行时必须知道“这个结果仍未结算”，不需要知道“这个角色技能是什么意思”。

| 模块组 | 具体职责 |
|---|---|
| PluginHost／CapabilityGateway | 受信插件生命周期、兼容性、静态能力、动态就绪、权限和外发预算 |
| EventReactor／StateProjection | 分类接入、幂等、游标、业务关联、防重入、状态归约与新鲜度 |
| WorkRegistry | Goal引用、Activity、Task/Attempt、SessionService、依赖和恢复句柄 |
| PlanValidator／ActivityRunner | 受限DSL、输入／结果绑定、分支语义、完成join、静态资源冲突 |
| Scheduler／ResourceManager | 先就绪筛选再优先级排序、阶段容量、互斥、委托、清理结算 |
| EffectLedger／SettlementCoordinator | 宿主权威效果或外部效果投影、稳定效果意图、清理证据与后继放行 |
| PlanCommitter／RecoveryCoordinator | 局部检查点、候选版本、恢复票据、累计重试预算与对账 |
| SceneDirector／SyncCoordinator | 流式片段许可、发言封口、媒体时间关系、软收尾和本地停止 |
| Audit／Metrics／PublicProjection | 必要持久记录、全链路指标、脱敏只读投影 |

模块组是代码边界，不要求独立服务。首次实现可将静态计划解释、资源管理和WorkRegistry放在同一宿主进程，重计算交给受控Worker。

#### 游戏控制在内核中的上限

Bellis核心只承担以下控制相关的通用部分：控制能力的模式与时间预算声明、受限策略请求与外部应用投影、control_critical资源类别、控制语义事件和验证索引。动作算法、输入映射、逐帧调度、局部预测模型、PolicyPatch实际应用权威与示范原始记录均留在Game Runtime或独立工具。

不创建“ControlFrame→Bellis Task→Scene→Broker”的逐帧路径。普通对白评论、投票说明和游戏控制可以并行；只有明确的语义依赖（例如指定结果播报完成后选择）才跨媒体与游戏等待。

### 3.6 速度路径与通信平面

| 路径 | 内容 | 禁止依赖 |
|---|---|---|
| 本地快闭环 | Stage媒体消费；游戏Capture→本地PolicyBackend→Interpreter→Broker | 普通云端LLM、Iris、后台日志、跨机逐帧往返；可包含已验收本地控制关键模型 |
| 编排路径 | 事件快照→主控→候选／Task→检查与提交 | 不能等待整场活动结束才接纳其他工作 |
| 语义与运营路径 | 剧情、计票、内容审核、记忆、控制台与质量评审 | 不挤占本地输出与停止通路 |

控制面传小型许可、命令、停止与确认；媒体面传有界分片／资源；业务事件面传可追踪事实；公共展示面只传脱敏投影。Provider面统一执行计算额度和外发许可，不等于把所有模型上下文混成一个历史。

### 3.7 宿主循环

```text
处理有效撤权／本地监督状态
→ 消费有界事件批，校验来源、Task/Attempt/Goal与实例
→ 更新StateProjection、服务质量、效果和清理记录
→ 推进Task等待、重试、恢复和有限事件处理器
→ 检查局部候选是否可提交
→ 计算依赖／上下文／资源均满足的就绪集合
→ 派发有限工作并立即返回句柄
→ 安排主控决策机会，导出有界遥测，让出执行权
```

主控请求尚未返回时，上述循环仍运行；没有新计划时，已授权控制器仍按本地闭环执行。大图校验、压缩、模型加载、解码和I/O不得占用这个循环。安全停止还有独立本地路径，不把此循环当成唯一最后保障。

### 3.8 逻辑拓扑

#### 文本视图

```text
弹幕／付费／投票 → 各自安全和队列 → Bellis上下文与活动
游戏语义事件／外部状态 → EventReactor → LiveDirector
                                             ↓
                          目标／计划／受限策略提议／正常表达
                          ├─ 审核 → Scene → Stage音字口型 → OBS
                          └─ game.bridge → Game Runtime
                                             ├─ 可等待逐步控制
                                             ├─ 已验证持续本地控制
                                             └─ 能力不足：降级／接管
                                                  ↓
                                带版本与坐标语义的有限动作
                                                  ↓
                                单根控制者组合ControlFrame
                                                  ↓
                                主机/桌面Broker → 输入后端 → 游戏
                                                  ↑            ↓
                                       本地健康许可 ← 新观察／反馈

策略参数兼容更新：当前有效本地策略继续 → 校验新参数 → 本地边界应用
计划/目标结构更新：影响分析 → 检查点／清理 → 有限交接
模型/代码更新：离线验收 → 人工批准 → 安全边界新实例
可选示范：明确许可 → 有界记录 → 离线验证；不直写Iris，不自动训练上线
```

### 3.9 插件清单与能力归属

#### 业务插件清单

| 类别 | 插件ID／职责 | 输出与权力边界 |
|---|---|---|
| 平台 | `platform.adapter` | 统一消息、付费／连接事件；不得从正文生成管理权限 |
| 人工 | `operator.console` | 身份核验后的控制、审批、证据查看；UI不是唯一急停依赖 |
| 麦克风 | `microphone.input`＋ASR/VAD | 可选语音输入；自然插话默认不启用，单独验收 |
| 上下文 | `context.live` | 安全候选、状态贡献、相关版本、事件游标和工作摘要 |
| 主控 | `controller.live` | 目标／候选采用、Task请求、NDJSON表达；只有一个正式高层owner |
| 专项规划 | `planner.dialogue / planner.game / planner.interaction` | 候选、证据和有效条件；不直接播报／点击 |
| 活动 | `activity.live` | 受限PlanTemplate、业务条件与事件分支；解释执行复用内核 |
| 安全 | `guard.content` | 结构化审核与内容绑定凭据；模型自报safe无效 |
| 隐私 | `privacy.gateway` | 检索前ACL、用途、外发、删除和来源约束 |
| 记忆 | `memory.iris` / `memory.session` | 经隐私网关检索／提交；不负责直播调度 |
| 总结 | `worker.summary` | 低优先级摘要与候选记忆，不直接公开 |
| 语音准备 | `speech.prepare` | 稳定片段、双文本、发音、审核编排、合成请求和背压 |
| 时序 | `speech.alignment` | 词／片段时间映射；不可靠时降级，不伪造精确高亮 |
| 模型 | LLM/VLM、TTS、ASR、Embedding/Rerank Provider适配 | 按实际使用启用；统一额度／计费／外发／取消契约 |
| 音频 | `stage.audio` | 有效许可内的增量播放、内容位置、EOS核验与停止 |
| 字幕 | `stage.subtitle` | 审核文本、绑定时间线；不执行HTML |
| 公开展示 | `display.overlay` | 另一Origin的安全问题卡、投票、致谢与提示 |
| 皮套 | `avatar.vts` | 集中合成口型、表情、待机参数，避免多写者 |
| OBS | `obs.control` | 受限场景／音量／输出操作；应急入口有独立白名单路径 |
| 投票 | `poll.engine` | 规则、收到的有效票、截止、结果；不让LLM计票 |
| 游戏桥 | `game.bridge` | 会话配对、能力、候选、外部Task投影、效果／检查点与剧情事件 |
| 观察服务 | 各适配器提供的SessionService实例 | 状态、NarrativeCapture、平台连接健康；与有限Task分开 |
| 测试 | `dev.simulator` | 假输入、FakeStage/FakeRuntime、故障注入、Shadow与回放 |
| 运维 | `telemetry.export` | 脱敏指标导出；基础审计留内核 |

致谢账本、回复选择器与冷场策略可先放在activity/context插件内部，不必拆出独立安装包。SessionService是一种运行契约，不要求新增“服务市场”。Game Pack装在游戏Runtime侧，不按每个游戏复制Bellis插件。

### 3.10 隔离模型

逻辑隔离决定职责；进程隔离决定故障／依赖边界；安全隔离决定一个主体能访问什么。独立进程不自动成为恶意代码沙箱。首版只加载受信插件；重计算离开宿主；音频与审核字幕同Stage；原始观众投影与Stage分离Origin和凭证。
