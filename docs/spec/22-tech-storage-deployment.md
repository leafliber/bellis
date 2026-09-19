## 22. 技术路线、存储与部署

> 第 22.7 节属于后续阶段，冻结在 [docs/future/spec/22-tech-storage-deployment.md](../future/spec/22-tech-storage-deployment.md)。

### 22.1 技术选择与范围

| 层 | 路线与限制 |
|---|---|
| Bellis宿主 | TypeScript＋Node.js；显式状态、事件、Schema、有限调度；不做重计算 |
| 活动执行 | 受限静态Plan先行，复杂状态可用XState；不因建模借鉴而强制引入ROS/行为树引擎 |
| 插件协议 | 本地JSON-RPC或等价有限RPC＋事件；应用层补齐句柄、取消、幂等、时效、效果与结算 |
| Stage | TypeScript＋Web Audio／AudioWorklet、有限PCM缓冲，审核字幕同源就近同步 |
| 重计算／控制后端 | P0/P1 开发与验收只依赖 Node 和 pnpm；Node Worker 与独立进程隔离阻塞工作。后续后端选型留到对应阶段，不引入 Python 前置。 |
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

P0 使用已锁定的 better-sqlite3，由监督进程中的独立持久化 Worker 独占数据库写连接；顺序迁移与版本表在启用前核验，不引入 ORM 或第二驱动。只建立授权、首验准入、有限效果登记、停止、清理/隔离与 Outbox 的必要表，不提前建立通用任务/结算表。事务内同时登记状态与相应可靠事件，新增效果取得真实提交回执后才准入；接收异步回执仍须复核当前 grant/实例/代次/期限。Worker 只接受已登记的封闭消息，不接受任意 SQL 或客户端伪造的提交证明。

Outbox 重放保持原 event/operation 和原期限，只重发事实或查询已登记结果，不再次创造效果；禁止把旧 grant 或未决执行意图作为重启恢复队列。停止、撤权和未知归约不等待 Worker；Worker 阻塞、SQLITE_FULL 或失败时关闭可靠新效果准入，记录缺口并保留隔离。启动时不能读取可信清理事实即保持受影响目标封锁，不能以空数据库宣称资源无未知。

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

P0 部署只启用三条进程职责：宿主、监督（含独立 SQLite Worker）和受信假设备；本地 CLI 经受限管理 socket 发起明确动作。宿主到假设备走有界 stdio JSON-RPC，监督到假设备走独立安全 socket，停止不依赖宿主转发。所有入口只使用 Node；当前 macOS 是本阶段 SUT 验收环境，其它系统的结构检查不构成对应宿主/设备验收。

P0RuntimeConfig 是监督的启动配置。监督经私有继承描述符向宿主一次传入 P0HostBootstrap，宿主校验后关闭该描述符，再只把其中 P0EndpointConfig 经另一个私有继承描述符原样交给核验后的假设备。宿主启动材料包含自身临时实例身份、固定监督身份和运行所需有限配置，不含监督私钥或数据库路径；会话、宿主私钥导出的公钥、监督身份、安装、profile 和 limits 必须与已核验材料及端点配置精确匹配。配置不经 argv、环境变量或普通业务消息传递。

本机路径约定固定：监督监听 management_socket_path，宿主监听该路径追加 .host，各服务供 CLI 读取的受信身份文件为自身 socket 路径追加 .identity.json，内容严格为该服务的 P0PeerIdentity。服务端创建前和 CLI 使用前均核验规范化实际路径、受控父目录、所有者及权限：运行目录由当前受信用户所有且为0700，socket、凭据/私钥及身份文件为该用户所有且为0600；不接受运行目录内的符号链接或指向目录外的路径。身份文件中的角色/实例/公钥须匹配该次服务启动材料；目录权限不能替代连接认证。待创建的 socket 或身份文件已存在、身份冲突或 socket 被占用时拒绝启动，不擅自 unlink 已有 socket 或覆盖身份文件；只在确认仍为本实例创建的对象后清理自身路径。

### 22.5 插件Manifest与升级

Manifest包含ID/版本、支持平台、Schema版本、输入输出、生命周期、supported contexts、阶段资源、effect类别、最大并发、quiesce/restore/checkpoint能力、成功/清理证据、网络/文件/存储权限、配置生效点与测试覆盖。控制能力另声明control_modes、ActionSchema/Profile、TimingContract、PolicySchema与更新边界、PolicyBackend版本、control_critical预算和完整负载验证引用；这些由Game Runtime实施，Bellis只保留公共契约与必要投影。

机器定义为ControllerManifest及关联类型（字段见[P0契约简报](../generated/P0.md#字段结构)）。宿主加载时校验精确版本、所有契约引用、方法与能力开关一致性、受信安装来源和启用阶段；simulation不能声明已启用的真实效果。空资源或空权限列表只表示没有该项授权，不表示通配。

缺能力用明确unsupported，不写空实现伪装兼容。仅维护本地可信安装清单和兼容测试，无市场。Schema更改、源码替换、活动Plan修订三条发布线分开；停用要排空/取消/隔离并确认资源，不因插件卸载遗失活动owner。

P0 首验具体限制集中于第20.2节。安装核验必须覆盖入口真实解析路径及其实际加载依赖，不能只检查 Manifest 名称或入口路径字符串。Manifest 固定为已核验 entry 所在真实目录的 manifest.json，必须列入安装清单 artifacts；同时验证实际文件 SHA-256 与严格解析后 JCS 的 manifest_digest，且协议/契约摘要及插件身份均匹配。规范化摘要不替代文件内容摘要，路径相同也不代表内容仍受信。

监督长期服务私钥与操作员凭据按本机受控文件保存，不入库、不写原始日志、不传入插件。宿主与端点的临时实例身份经私有启动材料传送并受各自角色限制，不要求持久化。端点自己的临时实例私钥只用于证明该端点身份，经 P0EndpointConfig 私有传入，不属于禁止给插件的监督/宿主核心服务私钥；端点不能得到其它角色的私钥。用于验收的故障选择仅允许认证 test_operator 在明确启用的 P0 simulation 中使用封闭枚举，不允许任意代码、跳过鉴权或关闭守卫。

### 22.6 插件ABI与传输绑定

首版本地Worker使用stdio双向UTF-8 NDJSON承载JSON-RPC 2.0：每行一个完整对象，stdout仅协议、stderr仅去敏日志，单条最多16MiB、嵌套最多64层；批请求与无ID命令通知不支持。命令使用commands.json登记的完整方法名，不另造pause/resume别名。WebSocket适配时一条文本消息对应一个对象，复用同一信封；二进制音频走独立有界媒体面。JSON解析先拒重复键、非有限数和孤立代理字符，再做Schema验证。[S7]

启动顺序为受信安装清单核验→建立传输→plugin.handshake→核验协商协议、bundle文件SHA-256与ControllerManifest→按声明执行prepare/activate。初版仅支持双方精确匹配0.8.0与Schema摘要；不匹配拒绝，不静默降级。握手仅绑定本次连接/实例，断线后重做握手且不恢复旧执行授权。远端Iris遵循其自身已批准HTTP/WS契约，由适配器转换，不强迫它实现插件ABI。

每个请求含字符串RPC id、CommandContext和命令专用input。RPC id只关联一次传输响应；operation_id识别业务命令，payload_digest为JCS序列化的{method,input}的SHA-256。相同operation_id不同载荷返回OPERATION_PAYLOAD_CONFLICT；相同载荷重传只查询/返回原结果，不再执行或延长期限。幂等记录按权威实例、调用方和作用域隔离；相同operation重试的权限代次/截止也不可暗改。跨端deadline须先转换为明确目标时钟域，域不匹配直接拒绝。

解析错误、无效请求、未知方法、参数错误和内部错误使用JSON-RPC保留整数码；业务拒绝统一-32000并在error.data放完整ErrorEnvelope。业务错误的类别/reason_code/retry_disposition仍由errors.json唯一决定。只有非法/无法读取请求id时响应id为null。RPC accepted只说明登记成功，真实完成/效果/清理仍走事件与查询；event.publish仅承载已登记EventEnvelope，不是新的事件名或执行命令。

公开方法由目标与角色共同限定。describe/status等查询不能夹带主动观察或输入；prepare不授予activate权限。请求、响应、事件分别经过大小/结构/来源/权限/时效核验；取消、资源停止与归约守卫均需真实实现。仓库内SimulationEndpoint仅测试JSON交换和去重，不构成受信执行或设备停止证明。

P0 的本机管理与安全 socket 同样采用上述有界帧和登记命令。受信启动器绑定角色、实例、安装摘要和服务公钥；CLI 从本机受控安装材料取得目标服务公钥和自己的操作员凭据。新连接先收到已登记 connection.announced 公告：服务使用 Node 内置 Ed25519 对去掉 signature 后的规范化载荷加固定域分隔签名。公告限定本连接、服务实例、一次性挑战、协议/契约摘要、目标时钟采样和有限有效期，并签入权威身份、权威实例与当前 authority_epoch；接收者验签后分别核验公告发布者与权威投影：外层 authority_id/source_instance 精确绑定 service_role/service_instance_id；载荷 authority_id/authority_instance_id 表示 Session 的固定监督 owner，不能要求它与宿主或端点发布者相同。外层 authority_epoch 必须与签名载荷相等，owner_scope 固定由已签名 session_id 派生为 Session。公告不得携带授权或执行动作，这不是通用签名平台。

P0 的 max_pending_requests 表示全服务普通异步请求的在途额度 N，不是可由每个连接分别取得的业务额度。候选连接固定最多2个；满时只淘汰最旧的未认证候选，不驱逐已认证连接，无可淘汰项时拒绝新候选。认证从接入时起使用固定绝对期限，预算为 clock_mapping_ttl_ms、peer_health_timeout_ms、stop_timeout_ms 的最小值；分片到达、重试或心跳不续期。完成鉴权后，stop/revoke 请求另有2个在途槽，只读查询另有2个，均不占普通额度。固定 Host peer 另保留业务、健康各1条连接，健康请求独立处理、不占 N；业务连接虽独立保留，supervisor.register_effect 等普通异步请求仍计入全服务 N，连接额度不增加业务额度。peer 在 connection.authenticate 后、首个业务方法尚未到达时仍占上述候选额度，不另设无界已认证中间池；此时不再作为未认证候选被淘汰，但原绝对期限不续，逾期关闭。通道进入固定 peer 槽后，按已验证角色和首个登记业务方法锁定分类，不能把健康连接用于 register_effect 等普通业务，也不增加可由调用方自报的通道标签。端点另保留至少2条固定监督的认证安全连接，把事实、lease/revoke、查询与可能挂起的 cancel 分开；这些连接仍受各自映射有效期约束，普通候选不得挤占或踢掉它们。

每条操作员管理连接只处理一个命令：首个通过 RpcRequest Schema 的请求帧到达后立即停止接收，同一 chunk 中余下帧也不再派发；继续完成该请求的鉴权及有限回包、排空后关闭。此规则不把 peer 的 connection.authenticate 当成其唯一业务命令。解析器按有限帧数和字节批次让出事件循环，保留的分片与待处理字节同样有界。普通槽只在实际任务结束或原请求 deadline 到达时释放，断连本身不代表 Worker 已取消；原期限后返回的持久化结果必须重新核验当前授权，不复活旧权。停止与撤权在完整身份、范围、时钟和幂等检查后先同步归约本地栅栏、代次、停止请求与隔离，再推进异步持久化或 cancel；不等待普通业务完成。

普通、安全与查询的幂等账本分别有界，同一 operation 的冲突检查跨账本进行，不通过换连接或通道清除旧业务身份。安全账本满时仍先执行合法安全请求的栅栏，再显式拒绝无法登记的后续工作并保留缺口/UNKNOWN，不能返回伪造成功、删除旧记录或截断事实。帧、解析、连接和在途隔离提供有限资源边界，不宣称可以抵御同 UID 的无限洪泛。

客户端在建连前、收取公告后分别记本地单调时钟，结合目标接收/发送点建立 target-source 偏移区间：整数毫秒采样的下界为目标发送减源接收再减1毫秒，上界为目标接收减源发送再加1毫秒，覆盖量化误差。只在身份、实例、连接、顺序、误差上限和有限有效期均有效时建立 P0ClockMapping；过宽区间拒绝。源期限映射取偏移下界并受目标有效期上限约束，不增加可执行时间。所有 RPC 的 CommandContext.deadline 仍是明确目标时钟域；clock.sample 只在已有有效映射和认证通道上细化采样。映射失效、目标重启或无法证明先后时拒绝，不猜换算、不因重试或往返延长期限。P0 的 plugin.handshake、plugin.describe、controller.observe_status、controller.stop、controller.dispose 沿用既有封闭输入，复用同连接 connection.authenticate 已验证并缓存的映射；每个请求仍独立验证通道身份、目标域有限 deadline、当前代次和幂等。缓存不能跨连接或实例使用，过期须重新建立受验证连接，不能在兼容方法 payload 内夹带新指令或猜测时钟。Host↔Endpoint 固定 stdio 业务连接的寿命受最初认证映射 TTL 限制；到期或断线时端点先封锁新增效果并关闭业务流，独立 safety UDS 继续允许认证查询和清理而不复活旧权。clock.sample 不刷新签名公告，不增设 refresh RPC；新运行使用新实例并显式重授权，不能声称配置 max_session_ms 内都可连续执行。所有效果、人工租约及 grant 截止均不得超过实际业务连接映射有效期。端点仅在固定 Host 的 Ed25519 认证及精确协议/契约/phase 的 plugin.handshake 完成后一次设置 host_connection_deadline，使用实际完成时刻和不晚于初次映射的端点域截止；初始、失联或到期时为 null，清除后该实例旧 grant 永久封锁。监督通过直连安全查询读取该实际事实，不能靠 Host 心跳猜就绪；以监督→端点映射的 offset_upper_ms 保守逆算自身截止上界 endpoint.expires_at_ms-offset_upper_ms，再与映射、人工、原 grant 和配置取最早。重复查询或采样不更新已发 grant/operation 截止。

管理请求使用 P0OperatorProof。服务端保存的 authentication_key_sha256 是随机操作员秘密的 SHA256 十六进制，解码成字节后作为 HMAC 密钥，属于等价秘密，不是可公开 verifier。先计算 request_digest=SHA256(JCS({method, context 去掉 payload_digest, input 去掉 proof}))；再计算 proof_hmac=HMAC-SHA256(key, JCS(proof 去掉 proof_hmac))，绑定公告摘要、一次性挑战、连接、服务实例、认证调用方实例、客户端 nonce 与请求摘要；最后计算 CommandContext.payload_digest=SHA256(JCS({method,input 含完整 proof}))。此顺序没有自引用。服务端原子消耗挑战；每条管理请求建立新连接取得新挑战，旧连接/旧实例/旧挑战证明不能重放。长期秘密和等价认证密钥均不在网络中发送。operator.authenticate 与其它管理方法调用同一证明验证逻辑；操作员 ID 只表示身份标签。业务去重遵循第4.11节，新的合法连接证明不能刷新原 operation 的权力或期限。管理命令另以 method 和 input 去掉 proof/mapping 的规范摘要识别固定业务输入；同 operation 的授权 scope、grant、代次与原目标期限必须一致。完整传输 payload_digest 仍保护每次实际 input，不把变动的连接证明当成新业务操作。端点执行登记中的 payload_digest 同样表示固定业务输入，排除传输证明/映射/提交回执；不能用包含自身的整个 registration 计算。

操作员 CLI 只把固定动作与显式参数构造成登记命令，不提供任意方法/payload 入口。prepare/send 可以在当前进程内保存第4.11节要求的原业务绑定；再次建连只重建该次 proof/mapping 和传输关联，不能刷新 operation、动作、scope、grant、epoch、目标实例/时钟域或原 deadline。目标实例变化、原期限失效或新映射不能支持原期限时拒绝，不能重新换算出更晚期限。CLI 不维护磁盘重试队列、不自动恢复授权；查询仍返回对应服务实际持有的事实。

host.query 使用第22.5节固定的 Host 管理 socket 与身份文件，通过同一操作员鉴权入口验证 operator.query 权限及当前 session，返回 Host 实际持有的端点投影。来源固定为已核验启动材料中的端点实例，事实还须匹配当前 session；无事实时明确 unknown/null。查询只评估缓存质量，不刷新实际接收时间，不代理监督或端点获取另一份事实。session.query 的监督视图与 host.query 的 Host 视图分别保留，供第24节独立核验。

storage.* 命令只通过监督与其 Worker 的私有通道传递，不能由插件或管理客户端直达；框架仍校验登记的输入、结果与调用方身份。监督在创建 Worker 时经私有启动材料显式分配同一单调时钟域和基准，Worker 必须按该基准解释命令 deadline，不能各自生成不同起点却沿用同一域名。这个同进程绑定不外推到宿主或端点：跨进程继续使用 P0ClockMapping，不猜测共享时钟。P0 的命令、配置、安装、持久化和验收证据类型全部由同一 Schema 定义，不以任意 DataObject 承载执行指令。


P0 子进程启动使用专用 P0EndpointConfig，由私有继承描述符传送端点自身的临时实例私钥、固定 host/supervisor 公钥、实例/安装身份、通道与有限配置，不传监督 P0RuntimeConfig 中的操作员凭据、监督服务私钥或数据库配置，也不传宿主私钥。端点连接先用 connection.authenticate 对一次性公告挑战进行签名证明，服务以启动时固定的对端公钥校验后绑定角色/实例；外来声明不能替换固定公钥。签名只用于本阶段连接身份，规则与管理请求一致地排除自引用字段。

宿主通过 supervisor.register_effect 提交封闭效果登记和完整模拟动作；监督核验当前 grant/实例/范围/余量后交私有 storage.commit，在真实事务回执后再次核验授权仍有效。只有成功返回的登记回执才能交给假设备，Worker 或监督未就绪时拒绝新增效果。Worker 仅从真实提交 batch 产生完整事务 request_digest 与 grant/admission/effect 记录的 JCS SHA256 集合；监督经私有通道核验 writer、transaction、请求及记录绑定，Host 只接受固定认证监督的成功结果。lease 保留 grant.deadline 的监督原时钟域，并用监督→端点映射得到端点域的 grant、人工和本地租约上限；原记录不改写，所有上限还受 Host 业务连接有效期限制。执行登记保留宿主原时钟域 deadline，Host→Endpoint 保守映射一次固定，重试不能延期。端点从认证监督下发的 lease 核验完整 grant/admission 摘要并固定 writer_instance_id，simulation.execute 再核验同 writer 与完整 registration 摘要。回执的 request_digest 保留完整事务绑定，不能要求只持局部记录的端点猜算事务，也不能接受客户端任意 receipt 或自报 durable。撤权与独立停止无需走此准入链。

已认证 test_operator 的 fault.configure 由监督核验后，使用 fault.apply 经目标专用安全通道下发；消息固定 fault_id、目标实例、封闭选择与有限目标时钟期限。各进程只接受当前认证监督，持久化 Worker 使用与监督绑定的私有继承通道；不得用任意 child.send、SQL 或通用 batch 夹带故障。故障可使 cancel 永不回包，但不能关闭端点独立租约、鉴权或守卫。

P0 假设备源 plugins/fake-device/main.ts 由锁定的 esbuild 在 pnpm generate 中生成单一 endpoint.mjs，Manifest 源不手填 schema_digest，由生成流程填入当前契约摘要。生成器检查制品只引用受信实现固定白名单内的 Node 内置模块，禁止相对/外部代码分块及端点制品中的动态代码加载；白名单不能由插件配置扩大。监督把已核验 installation.entry 原样写入 P0EndpointConfig.entry_artifact，宿主精确复核其路径与摘要后启动受信 apps/host/endpoint-launcher.mjs。launcher 经私有描述符取得配置，一次受控读取入口成 Buffer，核验哈希后将同一 Buffer 编码为 data: ESM 加载，不能再通过原路径读取代码。launcher 的这一次 data: 加载是固定加载机制，不为端点开放任意动态 import。预检后、读取前替换为其它内容应拒绝；读取后替换路径不改变已选执行字节。该机制绑定实际加载内容，不宣称为恶意代码沙箱；launcher、生成器与实际制品均纳入受测构建摘要。

authority_epoch 的唯一写入者是监督组件，Host/Endpoint 仅持有验证来源后的投影，具体比较规则见 epochs.json。connection.authenticate 使用目标签名公告中的投影完成身份绑定，不推进权威代次。只有固定认证监督的 endpoint.lease/revoke 可以显式携带监督当前 authority_epoch，而不是被客户端助手覆盖为端点的旧公告值；完整核验身份、owner/Session、监督与端点实例、时钟和幂等之后，在同一归约中封锁旧许可并采用合法前进。lease 随后仍须满足完整有限授权/持久化/隔离守卫，不能靠更大数字获取权限；无效入口不得推进。其它命令精确匹配当前代次，旧值拒绝。Host 只从验证过的监督公告更新权威投影，执行前再次向监督核验；Endpoint 的公告不得反向提升 Host。authority_epoch 与 supervision_epoch 分别核验，不互作别名。
