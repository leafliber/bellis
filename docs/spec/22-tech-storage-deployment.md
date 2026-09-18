## 22. 技术路线、存储与部署

> 第 22.7 节属于后续阶段，冻结在 [docs/future/spec/22-tech-storage-deployment.md](../future/spec/22-tech-storage-deployment.md)。

### 22.1 技术选择与范围

| 层 | 路线与限制 |
|---|---|
| Bellis宿主 | TypeScript＋Node.js；显式状态、事件、Schema、有限调度；不做重计算 |
| 活动执行 | 受限静态Plan先行，复杂状态可用XState；不因建模借鉴而强制引入ROS/行为树引擎 |
| 插件协议 | 本地JSON-RPC或等价有限RPC＋事件；应用层补齐句柄、取消、幂等、时效、效果与结算 |
| Stage | TypeScript＋Web Audio／AudioWorklet、有限PCM缓冲，审核字幕同源就近同步 |
| 重计算／控制后端 | Python/原生Worker按生态和实测选择，摄像/解码/模型加载不堵宿主；本地快策略按control_critical单独准入 |
| 游戏 | 独立Game Runtime＋Game Pack＋Input Broker；保留独立仓库/环境选择 |
| 控制台/Overlay | 角色分权Web端，独立Origin和凭证 |
| 持久化 | 单机SQLite＋必要文件/证据存储，有界缓存；不先引入分布式消息集群 |
| 部署 | 单机多进程优先，远端仅语义API、事件和必要证据；快闭环靠近目标主机 |

Node同步重计算和I/O会影响事件循环；OBS也需要GPU合成资源，独立进程不是资源隔离证明。[S12][S13] 实际依赖版本、系统音频路由、输入后端和OBS兼容性由目标环境锁定，不在文档编造最新版本号。

### 22.2 存储分层

| 存储 | 数据与边界 |
|---|---|
| 事务状态库 | Session/Goal/Activity/PlanRef、Task/Attempt、Effect/Settlement、授权与正式提交 |
| Transactional Outbox | 需要可靠发送的操作登记与结果；重传同operation_id，不重新创造业务效果 |
| 证据目录 | 关键截图/剧情证据/音频校准，访问受控、限额与保留期 |
| 环形缓存 | 高频帧、待播/隔离PCM、短时观察，过载显式处理 |
| 异步遥测 | 采样位置、性能直方图、低频状态变化，不同步逐帧落盘 |
| 隐私治理记录 | 用途许可、删除墓碑、派生关系和必要审计；优先于恢复召回 |
| 可选控制数据集 | 独立用途许可、episode/动作语义/模型版本与分层标签；不是Iris，不默认开启 |
| 控制配置与制品 | 版本化ActionSchema/Profile/Calibration/Policy和已批准模型制品；权威留目标Runtime |

不为每个插件发完整数据库写权限；用命名空间存储或宿主管理接口。SQLite事务协调本地状态，不创造跨进程/游戏世界原子回滚；媒体与输入实际效果靠回执和Reconciliation核验。

恢复先读关键记录、应用删除/撤权、确认新实例，再现场观察。缺少远端操作查询时不能保证可靠重试，保留UNKNOWN并人工处理。可恢复的数据不等于可重播的副作用。

安全封锁的本地归约不在数据库提交失败时回滚。第11.6节的incident/record_status标明记录缺口；需可靠登记的新效果暂停准入。重启不恢复旧grant/lease，默认关闭相应新增效果，完成端点核验后才能重新授权。独立清理/对账协调器不挂在短命插件或终态actor之下；这不要求另建微服务。

### 22.3 部署视图

```text
直播电脑
├─ Bellis Host：事件／Plan／Task／Attempt／Settlement／Scene
│  ├─ 主控与受信轻量插件
│  ├─ 有限Worker与Provider网关
│  └─ 控制台／公开投影服务
├─ 受信Stage：控制与媒体通道、Worker、AudioWorklet、审核字幕、Avatar适配
├─ 低权限Overlay：另一Origin、公开只读
├─ 独立监督组件：有限租约、本地OBS兜底
├─ Game Runtime：模式选择、PolicyBackend、动作解释、组合输入、PolicyUpdate、服务与唯一Broker
├─ VTube Studio
└─ OBS：显式全部输出清单

可选外部：模型Provider、Iris、另一台游戏主机
离线可选：独立示范/训练工具与数据集；默认不与正式控制共载、不自动部署
```

macOS可以开发宿主与协议；实际Windows游戏采集、键鼠、音频和OBS必须真机验收。桌面组件不为了容器一致性脱离交互桌面；Iris等服务可容器化。普通插件可替换不等于每个能力都须独立进程。

### 22.5 插件Manifest与升级

Manifest包含ID/版本、支持平台、Schema版本、输入输出、生命周期、supported contexts、阶段资源、effect类别、最大并发、quiesce/restore/checkpoint能力、成功/清理证据、网络/文件/存储权限、配置生效点与测试覆盖。控制能力另声明control_modes、ActionSchema/Profile、TimingContract、PolicySchema与更新边界、PolicyBackend版本、control_critical预算和完整负载验证引用；这些由Game Runtime实施，Bellis只保留公共契约与必要投影。

机器定义为ControllerManifest及关联类型（字段见[P0契约简报](../generated/P0.md#字段结构)）。宿主加载时校验精确版本、所有契约引用、方法与能力开关一致性、受信安装来源和启用阶段；simulation不能声明已启用的真实效果。空资源或空权限列表只表示没有该项授权，不表示通配。

缺能力用明确unsupported，不写空实现伪装兼容。仅维护本地可信安装清单和兼容测试，无市场。Schema更改、源码替换、活动Plan修订三条发布线分开；停用要排空/取消/隔离并确认资源，不因插件卸载遗失活动owner。

### 22.6 插件ABI与传输绑定

首版本地Worker使用stdio双向UTF-8 NDJSON承载JSON-RPC 2.0：每行一个完整对象，stdout仅协议、stderr仅去敏日志，单条最多16MiB、嵌套最多64层；批请求与无ID命令通知不支持。命令使用commands.json登记的完整方法名，不另造pause/resume别名。WebSocket适配时一条文本消息对应一个对象，复用同一信封；二进制音频走独立有界媒体面。JSON解析先拒重复键、非有限数和孤立代理字符，再做Schema验证。[S7]

启动顺序为受信安装清单核验→建立传输→plugin.handshake→核验协商协议、bundle文件SHA-256与ControllerManifest→按声明执行prepare/activate。初版仅支持双方精确匹配0.8.0与Schema摘要；不匹配拒绝，不静默降级。握手仅绑定本次连接/实例，断线后重做握手且不恢复旧执行授权。远端Iris遵循其自身已批准HTTP/WS契约，由适配器转换，不强迫它实现插件ABI。

每个请求含字符串RPC id、CommandContext和命令专用input。RPC id只关联一次传输响应；operation_id识别业务命令，payload_digest为JCS序列化的{method,input}的SHA-256。相同operation_id不同载荷返回OPERATION_PAYLOAD_CONFLICT；相同载荷重传只查询/返回原结果，不再执行或延长期限。幂等记录按权威实例、调用方和作用域隔离；相同operation重试的权限代次/截止也不可暗改。跨端deadline须先转换为明确目标时钟域，域不匹配直接拒绝。

解析错误、无效请求、未知方法、参数错误和内部错误使用JSON-RPC保留整数码；业务拒绝统一-32000并在error.data放完整ErrorEnvelope。业务错误的类别/reason_code/retry_disposition仍由errors.json唯一决定。只有非法/无法读取请求id时响应id为null。RPC accepted只说明登记成功，真实完成/效果/清理仍走事件与查询；event.publish仅承载已登记EventEnvelope，不是新的事件名或执行命令。

公开方法由目标与角色共同限定。describe/status等查询不能夹带主动观察或输入；prepare不授予activate权限。请求、响应、事件分别经过大小/结构/来源/权限/时效核验；取消、资源停止与归约守卫均需真实实现。仓库内SimulationEndpoint仅测试JSON交换和去重，不构成受信执行或设备停止证明。
