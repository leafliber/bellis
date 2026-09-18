## 9. SessionService与控制器生命周期

### 9.1 持续服务与有限Task

平台连接、游戏状态估计、NarrativeCapture、健康观察等使用`SessionServiceSpec`与实例。有限Task可以依赖服务`ready/quality`，不能等待服务终止来完成普通计划。

配置字段登记为附录B.6的SessionServiceSpec，运行实例字段登记为ServiceInstanceRecord（含健康、准备起算与准备截止）。生命周期见第11.4.6节。

服务属于Session或显式Activity；共享服务以所有者和受控引用计数管理，不被某个临时Task取消。引用移除后是否停服由确定性政策决定，不由最后一条网络消息偶然决定。

### 9.2 就绪、健康与数据新鲜度

连接在线不等于READY；READY不等于数据仍新鲜。至少报告`connection_alive / component_ready / last_observation / quality / failure_reason`。

关键服务DEGRADED使依赖它的动作等待/降级/撤权，不把所有无关活动一起杀死。观察器失联时不能继续用旧快照无限操作；仅在服务保持就绪、数据仍在有效窗口且授权允许时执行已覆盖本地行为。

服务崩溃后新建instance_id，旧实例结果不取得新权限。可按有限政策重连观察服务；自动恢复游戏输入或公开播出高权限仍须满足监督与重新识别。

### 9.3 控制器实例与逻辑任务

控制器实例可以为多个串行Task复用准备资源，但一次激活必须绑定具体Attempt。生命周期使用`UNCONFIGURED → PREPARING → PREPARED`，prepare发起有界异步准备并立即返回句柄；受信prepared回执通过`controller_prepared`后才进入PREPARED。服务的`service_prepared`不复用到控制器。

| 阶段 | 核验对象 | 不表示 |
|---|---|---|
| prepare / PREPARING | Manifest、精确接口/能力版本、配置摘要、准备依赖和准备阶段资源；设prepare_deadline | 准备已完成、Task已启动或取得输入/播音权 |
| prepared / PREPARED | 来自当前实例与prepare操作的完整准备证据；声明的资源和依赖满足准备契约 | 当前游戏页面适合操作、持续闭环健康或监督已授权 |
| activate / ACTIVE | 当前Attempt、目标与当前上下文、能力/模式、阶段资源、监督及执行端许可再次核验 | 目标已成功或未来无限期有效 |

游戏控制器声明输入能力时，准备证据还需绑定ActionSchema、ControlProfile及所需后端版本；纯计算或语音控制器不被强制实现游戏输入、导航、检查点或恢复逻辑。即使准备时做过窗口识别，激活和实际输入前仍须复核。

接口分级：

| 基础接口 | 可选扩展（Manifest声明） |
|---|---|
| describe、prepare、activate、observe_status、stop、dispose | request_checkpoint、quiesce、snapshot、restore、propose_policy_patch |

不支持检查点固定返回`FORMAT_UNSUPPORTED / CHECKPOINT_UNSUPPORTED`；不支持暂停/恢复分别返回`FORMAT_UNSUPPORTED / PAUSE_UNSUPPORTED`和`FORMAT_UNSUPPORTED / RESTORE_UNSUPPORTED`。暂时未就绪、尚未到检查点、恢复上下文过期使用各自固定映射，见附录B.2，不混写“或能力不可用”。静态不支持应在候选采用前拒绝相关策略，运行时仍作防御检查；不通过空实现假成功，不把stop伪装成pause。

准备超时进入STOPPING并有界清理；若停止确认仍不明，按第11.6节进入UNKNOWN。迟到prepared只能被记录为拒绝/历史证据，不能使STOPPING、ERROR、FINALIZED或UNKNOWN重回PREPARED。实例失败后建立新instance_id，不复活旧实例；准备资源变更须重新验证，不暗改已固定配置摘要。

### 9.4 非阻塞领域执行

控制器启动耗时动作后立即返回运行状态，由本地tick或事件持续监督；不在快循环长sleep、访问远端LLM或同步读盘。主控不给每帧指令，但可在后续决策请求已声明的策略更新。

正常停用到声明检查点，紧急撤权立即隔离输入/输出。准备、激活、静默、释放资源、实例销毁分别确认。插件停用必须有最大期限；超时保留未知状态和资源隔离，不无限卡死宿主管理。

### 9.5 有限join的排除项

SessionService存活、后台遥测常驻、平台连接保持、独立看门狗巡检均不属于某次投票/聊天/有限游戏操作的完成条件。它们的不可用可以是业务前置失败，但不能造成“任务都完成了，Activity仍等观察器退出”。

continuous_local控制器的就绪、持续健康与有界输入续租见第15.3–15.4节。

### 9.6 统一生命周期接口与准备到期

Controller和Game Bridge传输接口统一使用quiesce/restore；Task/Activity对操作员的业务请求仍叫pause/resume，由宿主明确映射到前者，不作为同一端点的别名。兼容行为参数接口统一为propose_policy_patch；取消更新使用cancel_policy_update。SessionService的READY与Controller的PREPARED属于不同对象状态，不互换。

服务prepare与控制器prepare都记录一次prepare_started_at/prepare_deadline；PREPARING到期进入STOPPING执行有界清理。迟到prepared不能复活终态或STOPPING实例。Controller一次activate绑定activation_id和attempt_id；activation_finished同时证明本次执行终态与清理，实例才回INACTIVE。逻辑Task仍需重试时不必等待task_finished；重试绑定新Attempt和新activation_id。

### 9.7 可选后端的准备与切换

GroundingProfile、编码模型、CandidateRepairPolicy及恢复能力在prepare阶段固定版本、依赖与资源需求。PREPARED只表示准备证据成立；实际激活仍绑定有效Attempt，重新核验当前目标、现场、监督和权限。

更换编码器、模型权重或修正算法不是普通PolicyPatch。改变输出动作语义或关键资源profile时，按第10.1节停用／新实例验证；缓存不可跨不兼容制品复用。可兼容的阈值调整也必须在受信Schema范围内，不能借“调定位置信度”降低输入风险门禁。
