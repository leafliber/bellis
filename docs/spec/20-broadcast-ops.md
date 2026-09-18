## 20. 播出运维：停止、监督与运行手册

> 第 20.3–20.4、20.6–20.8 节属于后续阶段，冻结在 [docs/future/spec/20-broadcast-ops.md](../future/spec/20-broadcast-ops.md)。

### 20.1 四层停止

| 层次 | 能做什么 | 不能声称 |
|---|---|---|
| Bellis本地停止 | 撤许可、停Stage、清PCM/字幕/口型、请求游戏撤权 | 已入设备/平台的内容全能撤回 |
| OBS原生/实体键 | 静音指定源、固定安全场景，不经Bellis主进程 | 已入编码/延迟队列的旧内容自动消失 |
| 可选延迟＋强制停流 | 在未发送窗口内丢弃排队输出，具体路径须验收 | 回收已发给平台/观众内容；不影响互动延迟 |
| 独立监督组件 | 租约过期后收权、静音、安全场景或到期下播 | 同机OS整体冻结或OBS崩溃仍绝对可靠 |

OBS官方API区分普通stop与force stop；后者尝试不等待排队数据，前者可能等待发送。[S16] 具体热键、前端操作和全部输出路由必须在目标版本实测，不能把普通StopStream当作丢弃延迟。

当前设计在本地先停止，远端LLM/TTS取消与日志并行。StopOperation只有在声明边界确认时为CONFIRMED；超时UNKNOWN，继续监督和对账，不能把“命令已发”报成静音完成。

上述停止路径和第11.6节共用强制安全入口：业务预算耗尽、数据库满或普通队列过载不能阻塞本地撤权及未知态归约。停止确认缺失时由独立Settlement/Recovery职责继续处理，不因Scene、Attempt或插件已经终态而丢弃责任。本地封锁、OBS应急动作、平台已输出内容分别报告，不把其中一个当成全部停止证明。

### 20.2 监督模式与ExecutionGrant

监督模式为supervised、restricted、unattended_approved、safe_stopping、stopped，状态表见[P0 契约简报](../generated/P0.md#supervisionmode)。stopped是可通过认证人工动作重新启动的安全静止态，不是可自动复活的业务终态。

supervised需要真实人工确认租约与监督组件健康；UI心跳只表示程序在线。失效进入restricted，立即禁止新自由话题和游戏输入，允许有期限的已审核安全收尾/固定提示与只读；宽限到期进入safe_stopping。安全停止确认或已记录隔离后进入stopped；尚不明的端点仍锁住相应能力。

从restricted/stopped恢复必须操作员明确确认、新监督代次和逐能力预检；主控返回、新消息和浏览器重连都不能复权。unattended_approved默认关闭，仅在实际平台/运营批准、profile和有限运行期限都成立时显式启用。

ExecutionGrant独立建模REQUESTED→ACTIVE，终态DENIED/REVOKED/EXPIRED。mode为simulation、test_only或public；所有许可有目标白名单、能力/效果上限、费用、deadline、supervision_epoch和门禁证据。simulation只对假端点有效；test_only允许已通过C0后的有限真机验证但public_broadcast_allowed=false；public需要全部适用领域与P8门禁。模式切换新建grant，不能原地把test_only升级公开。

示例心跳10秒、人工确认5分钟、restricted宽限60秒只作待测初值，不是平台义务。续人工租约不会刷新已采用Task/Action截止；撤grant先关闭效果准入，已发生效果仍按Settlement处理。

### 20.5 音画偏移补偿

在OBS最终录制中测Audio↔Subtitle、Audio↔Avatar、游戏源时间关系，记录版本、帧率、采样率、采集路径和voice profile。不得假设VTube Studio在所有机器固定慢几帧。

稳定偏差可对较早轨道增加经验证的音频偏移或视频/源延迟；OBS提供Render Delay滤镜。[S21] 对齐口型后重测字幕；补偿不能消除随机抖动，也不能提前输出尚未生成的媒体。新增缓存计入停止尾音与观众端延迟。
