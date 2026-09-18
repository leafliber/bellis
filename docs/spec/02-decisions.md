## 2. 关键设计决策

> 第 2.5–2.7 节属于后续阶段，冻结在 [docs/future/spec/02-decisions.md](../future/spec/02-decisions.md)。

### 2.1 执行模型

Task保持业务身份，Attempt表示一次执行，JobHandle只是查询句柄。重试和恢复创建新Attempt；终态不复活。EffectIntent在同一业务范围内跨Attempt保持身份，Settlement单独决定资源是否可以复用。SessionService不加入有限目标完成join。

普通聊天在常驻chat Activity中直接创建Scene；多步骤活动采用静态受限Plan。目标/结构变更通过检查点和受控交接，兼容行为参数由PolicyUpdate在本地边界应用。外部Runtime保留自己的权威状态，Bellis只保存带来源投影。

### 2.2 控制、媒体和数据边界

Goal、ClosedLoopSkill、SemanticAction、PhysicalInput分层。控制模式分waitable_step、continuous_local；不满足覆盖或时限时投影为unavailable。ControlFrame属于当前Attempt内本地协议，不逐帧派生Bellis Task。目标主机/交互桌面只有一个Input Broker。

媒体采用已稳定且已审核的语义片段增量提交，播放事实来自Stage，不来自TTS生成回调。镜头/输入映射、校准、策略和模型版本独立。示范用途与Iris、运行审计分离，默认关闭，制品经离线和真机批准后才能启用。

### 2.3 跨系统整合边界

游戏Planner不获得第二个正式高层采用权；游戏记忆不绕过PrivacyGateway；输入锁不缩小到单游戏会话；普通弹幕不通过游戏事件分支获得抢占权；原神专用频率、算法和语言选型不替代Bellis的TypeScript宿主与剧情优先路线。
