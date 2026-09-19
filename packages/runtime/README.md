# P0 运行时

本包负责真实本机身份、安装、时钟、有界协议、进程接线、只读观测和 P0 三状态机同步归约，不实现媒体、供应商、自动恢复或通用结算。当前运行入口具备零授权启动与查询；归约器已完成模块覆盖，尚未接入运行协调器，独立监督的完整协调和真实持久化链仍 unsupported。可运行入口见 [apps/host](../../apps/host/README.md)，端点模型见 [fake-device](../../plugins/fake-device/README.md)。

## 模块和 Schema

| 模块 | 职责与契约 |
| --- | --- |
| files.ts | UID/权限、实路径、私有 bootstrap、inode 所有权；P0OperatorCredential、P0PeerIdentity。 |
| config.ts | P0RuntimeConfig、P0HostBootstrap、P0TrustedInstallation、实际 Manifest 与依赖闭包。 |
| identity.ts | Ed25519 公告/peer 挑战、HMAC 与一次挑战；P0ConnectionAnnouncement、P0PeerProof、P0OperatorProof。 |
| clock.ts | 单调时钟、保守区间与目标域期限；P0ClockMapping、Deadline。 |
| transport.ts | socket/stdio 有界 UTF-8 NDJSON、共享批次解析、严格 JSON、封读与有限写入；区分真实读 EOF、全连接关闭及解析/派发/传输失败。 |
| client.ts | 验签、有限 pending/时限、原始回包、端点来源及序号/版本冲突检查；真实收发接点的协议观测。 |
| service.ts | 实际鉴权/scope/时钟/代次检查、管理封读、固定 peer 分类与冻结 ServiceInvocation 委派；鉴权 host.query，未接真实存储前拒绝新效果。 |
| service-capacity.ts | 全服务普通/安全/查询在途与未结算任务预算，固定期限、断连后脱离回包及迟回调回收；不取消业务任务、不持业务账本。 |
| endpoint-loader.ts | O_NOFOLLOW、有限一次 Buffer、文件身份及内容哈希，生成固定 data URL。 |
| endpoint-client.ts | 私有启动、stdio 鉴权/握手、精确 Manifest 与 P0EndpointSnapshot 查询。 |
| processes.ts | Supervisor/Host 生命周期、最小环境、独立安全轮询和各自 P0EndpointProjection。 |
| observation.ts | 轻量共享 writer、精确认证器去敏、Schema 化观察与内部触发关联；P0ProtocolObservation、P0ProcessObservation、P0EndpointObservation、P0ObservationStreamEnd。 |
| process-observation.ts | 父进程真实 spawn/error/exit 接点及实际启动参数摘要；不进入端点加载闭包。 |
| p0-guards.ts | P0 准入、人工续租、提交绑定、执行、实际停止和输出安全守卫；仅消费已认证通道交付的具体事实。 |
| p0-reducer.ts | P0Reducer 同步持有 SupervisionMode、ExecutionGrant、StopOperation 及独立清理/隔离记录；输出归约观察和待执行安全动作，不做 I/O。 |

字段与算法只在 [contracts/src](../../contracts/README.md)、[P0 简报](../../docs/generated/P0.md)和[第22.6节](../../docs/spec/22-tech-storage-deployment.md)维护。SDK bindVerifiedP0Installation 是进程内绑定，生产只在实际文件核验完成后使用。

## 加载信任

清单固定文件 SHA-256、Manifest 摘要、插件/协议/契约身份及能力/目标白名单。实路径无符号链接，当前 UID、无组/其它用户写权限，每文件最多 32 MiB；缺项、重复、替换和身份不符拒绝。verifyInstallation 保留多文件静态 ESM 的只读核查，供 W3 闭包反例；真实配置/Host bootstrap 只允许本包单制品假设备。

生成器使用本次内存契约 Map 打包端点。生产制品仅允许固定 node:crypto、node:events、node:fs、node:fs/promises、node:net、node:path，无外部分块、动态加载或真实效果入口。launcher 唯一 data: import 只执行已验证 Buffer，不再读取原路径。该机制不是恶意代码沙箱，不向端点注入操作员/供应商凭据。

## 身份、状态与时钟

认证主体来自受控凭据，peer 角色来自固定公钥。公告外层发布者与签名 Session owner 分别核验，载荷 owner 固定为监督，外层 epoch 必须相等；客户端保存不可变验签公告。管理 proof 防重放与业务 operation 去重分开，W5/W6 须按稳定主体维护业务操作表。

Supervisor 是监督/grant/StopOperation 的唯一归约 owner；供其使用的 P0Reducer 已实现，当前进程接线仍只维护初始 stopped、健康及独立端点观察，待 W5S 委派给归约器。Host 持执行入口和本地投影。端点独占队列、计数、水位和停止/清理事实。同 source_revision 的完整 fact 固定，读取时间放 Projection.received_at。事件冒充、错误实例/代次、同 source_seq 或 source_revision 异载荷均拒绝；一致旧事件不覆盖新投影。事件历史有界，不能继续证明时关闭连接，不截断事实。

映射由验签公告和客户端前后采样生成，包含 ±1ms 量化保护；期限受目标域、实例、误差和 TTL 检查，失效不猜换算、不自动延期。legacy plugin/controller 封闭输入复用连接认证缓存映射。固定 stdio 不续 TTL，断开/到期先 fence，独立 safety UDS 继续有限查询/清理。

当前生产核心 epoch 仍为 0。端点区分首次 auth 的公告投影、普通请求精确当前代次与监督 lease/revoke 合法推进。W5 要将事件 currentEpoch getter 接到固定监督新验签投影；不能从端点反向提升权威，也不能把零代次接线当 I81 完成。Worker 时钟与事务由 W6 接入。

服务已支持固定 peer 在鉴权后使用当前 owner 的 request epoch，原验签公告、映射与 TTL 不变；首次 connection.authenticate 和 operator 请求仍拒绝旧公告代次。该服务能力不代表生产权威推进已接通。

host.query 经 operator.query 鉴权，核验当前会话及固定端点来源，返回 Host 自己的 P0EndpointProjection；不调用监督或端点查询，不刷新 received_at。无事实为 unknown，实际连接关闭、映射失效或缓存年龄达到 peer_health_timeout_ms 时为 stale。监督独立查询所得的投影与 Host 缓存分别拥有自己的接收时钟，不能互相冒充。

## 服务委派与容量

P0Service 在完整 RpcRequest Schema 校验后记录原 request_received；实际鉴权、scope、摘要、时钟和当前代次检查通过后，才把原请求、公告、该内部 trigger 及公开 actor 身份复制并深度冻结为 ServiceInvocation。actor 不含 authentication_key、私钥或等价秘密；它不由调用方自报 operator_id 获得。ServiceDelegate.beginSafety 在连接分类和任务容量拒绝前同步执行，要求协调器先完成本地 fence，再由 dispatch 返回同一停止记录；服务不等待数据库或 cancel 才调用该接口。生产唯一业务账本与归约接线仍待 W5S-I，当前测试委派只证明接口顺序。无 delegate 时 authorize/execute/register_effect 继续返回 PERSISTENCE_NOT_READY，fault 配置/应用返回 SERVICE_NOT_READY；host.query 固定读取本机缓存，不能被 delegate 替换。

服务按第22.6节实施三类共享任务预算：令 N=max_pending_requests，普通 live 为 N、unfinished 为2N；安全和查询各自 live 为2、unfinished 为4。到期释放 live 并脱离回包，原任务实际 settle 才释放 unfinished；断连不取消任务、不提前返还额度，迟到回调只回收任务，不再回包。关闭服务释放自身计时器和连接关联，保留有限未结算单元直到原 Promise 真实 settle；关闭不等待任意业务 Promise，也不声称已取消。

连接分类预算保留到实际 closed，任务完成不提前释放慢回包连接；操作员普通连接最多 N，安全/查询各2，固定 peer 每类1。候选最多2个，只淘汰最旧未鉴权连接，固定接入期限不按到包或鉴权续期；已鉴权但尚无首业务方法的 peer 仍受原期限限制。Host health/business、Supervisor control 各有独立固定连接分类，由真实角色和首业务方法锁定，Host health 不等待普通异步池。operator 首个 Schema 合法帧立即 sealRead，丢弃同 chunk 后续输入，完成检查后仍可异步回包；peer authenticate 不算唯一业务帧。每连接 N+2 是公告/鉴权响应的有限协议输出余量，不增加业务额度，也不是时延 SLO。持续恶意同 UID 洪泛不在无条件可用性保证内。

## P0 同步归约模块

P0Reducer 默认 stopped、无 grant、持久化 blocked，是三状态机和本地授权栅栏的单一写入者。转换来自登记表，守卫读取具体身份、安装、时钟、授权、回执与端点事实；调用方不能提交 guard=true、任意 timer 或外部触发摘要。表外事件、守卫拒绝和终态拒绝分别产生 P0ReductionObservation，读取记录返回副本。此模块不认证 socket、不调度进程、不执行设备、不提交数据库，也不创建成功存储替身。

command/health 接收实际服务鉴权结果、原请求、公告和真实 request_received 的内部关联；failure 只接实际进程退出/通道失败回调，不读取 stderr。endpointFact 接收固定端点的验签公告、有效映射，以及完整原查询/响应或原事件信封，重新核验身份、代次、时钟和事实一致性。workerReceipt 绑定 P0StoreCommitInput 与 P0PersistenceReceipt，bindActiveCommit 还须核验精确 ACTIVE 记录的独立提交；这些内部入口不是 RPC，也不能被测试布尔值代替。timer/fire 使用本实例签发的内部 token、原期限和事实基准，过早回调只重排原期限。

同步 fence 先阻断执行、推进适用代次、建立 REQUESTED 停止与隔离，再由 takeActions 交出 endpoint_revoke、query_cleanup 和 persist 意图；意图不等于已发消息或已提交。persistenceRecord 只给当前记录副本，实际事务及对应 Outbox 由 W6 接入。停止终态与清理记录独立：UNKNOWN 不被后到事实改写为 CONFIRMED，清理仍可继续记录，隔离只按适用证明处理，不因新 operation 或新实例零计数解除。

模块最多保留7份 grant；初始目标集合和各 grant 在接纳前按目标预留停止、清理及隔离位置，各集合最多16个目标，预留总量按128限额连同已有隔离核验。管理 operation 记录最多128项，效果历史最多1024项，安全动作按记录身份合并待办，不删除历史换取新授权。上述是模块记录数量边界，不保证完整 P0SessionSnapshot 或 RPC 已符合 max_message_bytes；全响应序列化字节预留和真实传输准入由 W5S/W6 完成。

端点投影替换前统一核验 lease 与 Host 连接期限的映射域、正区间及相对真实 observed_at 的签发时点；有效的过期历史保留，执行资格仍按当前时钟和保守映射上界拒绝。停止证明在监督实际接收时已到截止，即使 timer 回调尚未派发，也先按原 timer 绑定归约 UNKNOWN，再独立确认清理；端点历史时点不能倒填停止确认。实际协调、持久化与故障执行仍按下述未完成边界处理。

## 只读运行观测

每个实际固定进程实例使用一个 writer，同一协议流的所有连接及收发方向共用序号；每次记录尝试占用序号，失败和容量丢失累计。进程记录来自真实 spawn/error/exit 回调，启动拒绝记录实际执行阶段；尚未绑定实例的失败只产生一次 null 来源的失败记录。child 的预期实例与实际 PID 分开，EOF、发出信号或清理函数返回都不补造 exit。

协议记录来自 JsonChannel、RpcConnection 和实际服务入口。request_received 在解析及 RpcRequest 校验后、业务守卫前产生，内部关联交给后续归约器，不增加 RPC 字段。原始事件接收与业务采信分开，公告接收独立分类；失败响应在向调用方抛错前保留完整合法回包。完整非法帧只保留字节摘要和长度，截断没有完整帧摘要。解析异常与下游回调异常分别记录，不把业务异常写成非法 JSON。

去敏仅处理契约指定的认证器，保留其摘要及其余合法消息。SDK 的 SchemaValidationError 提供真实 Schema 名和校验 keyword；缺失或无法安全验证时降级为 internal，未知异常不解析 message、stack 或路径。日志不接受外部指定的守卫结果，也不作为生产授权、停止或解除隔离的输入；完整性与证明边界见[第24章](../../docs/spec/24-verification.md)。

观测单条预算为 max_message_bytes 加 4096 字节固定封装余量，队列最多 max_pending_requests；不扩大协议帧准入。默认 AsyncFdSink 使用公开异步 fs.write 写继承 fd 2，单 FIFO 只保留一个 OS 写请求在途，不调用 process.stderr.write/writeSync，也不关闭 fd 2。部分写维护偏移；EAGAIN/EINTR/零进展重试受入队时固定的 1000ms 绝对期限限制，不续期。超时或写失败关闭该 sink，未确认范围保持不完整，晚回调不再续写。受控 Writable sink 的 false 返回只表示背压，error/close 受控处理，不冒充物理 OS 故障。

安全操作不等待日志排空；JSON 校验和编码仍有受消息上限约束的 CPU 开销。finish 默认预算 100ms，返回完整性、未完成记录及实际 OS 在途状态；正常结束只给已使用流写一次 P0ObservationStreamEnd，失败/超时不补尾或补零。有限 finish 返回不代表 OS 请求已结束，运行库不 exit/kill；实际入口的有限退出见 apps/host。参数是资源上界，不是实测 SLO，也不保证物理不可调度的 OS 故障能够按时终止。

## 资源、失败与清理

P0SafetyLimits 限制帧、pending、连接、映射及租约，配置不是实测 SLO。JsonChannel 每批共享8帧/64KiB扫描追加预算，同一轮连续 data 回调不能各自重新取得预算；耗尽后通过 setImmediate 续跑。令 M=max_message_bytes，解析器持有的输入 Buffer 总上限为 M+max(64KiB,M+1)，不含解码字符串/对象，也不含由调用入口单独配置的有限输出帧额度，P0Service 为上述 N+2。接纳 chunk 的复制受后项上限约束；完整 JSON 帧仍一次解码和解析，最大 M，不宣称 CPU 工作被按时间抢占。

sealRead 立即停止输入及同 chunk 后续派发，释放待解析 Buffer 和 continuation，但保留异步回包能力；服务层已用它实施上述管理单命令策略。end 封读后安排100ms有限排空，close 取消 continuation/排空 timer 并关闭通道。实际输入 end 立即发出 readEnded，再处理余留解析；共享 socket 的 full close 则是整条连接失联，不能当作仍可写的半连接 EOF。非法 UTF-8、重复键和超限输入拒绝，非法前缀后不再处理同 chunk；RPC 的批请求、通知、字段和未知方法仍由对应入口校验拒绝。

终止 stream 只保留不捕获 channel/timer 的静态 error 吸收器，处理 Node stdio 在 close 后仍发出的 EPIPE 等迟到错误，不继续 I/O；活动通道的首个传输错误仍输出观察并关闭。真实 Node PIPE 已复现 stdout close→error:EPIPE→close 顺序。端点已有独立 safety UDS；Supervisor 的双安全连接、端点事件/响应容量隔离和完整监督协调仍待 W5S-E/I 接入。

私有 bootstrap 最多 16 MiB、5 秒。监督等待 Host 健康和独立端点握手事实最多 5 秒。terminateChild 先发 SIGTERM，在传入宽限后升级 SIGKILL，再等待最多1000ms确认实际退出，否则报 CHILD_STOP_UNCONFIRMED。Supervisor、Host 和 launchEndpoint 的启动异常清理均显式使用已验证配置的 stop_timeout_ms 作子进程软停止宽限；正常监督收尾仍沿用既有配置宽限、服务清理和有界 dispose。这些是配置与等待界限，不是实测 SLO。退出不是端点清理证明，Host 健康丢失后的完整自身寿命仍待 W5。

端点 stderr 原始 fd 直接继承；生产只采认证 RPC/event/query，日志不是授权/清理输入。只清自身 inode，异常遗留不覆盖、不自动恢复。永久 OS 死锁不是本地 timer 能保证的清理范围；无证明保持 UNKNOWN。

## 实际覆盖与未完成项

reports/p0/w4/ 保存真实身份/CLI、单制品启动、独立查询、Host SIGKILL、零权拒绝、取消挂起、容量隔离、TOCTOU、空生成目录和跨 checkout 全部生成物一致/漂移拒绝结果。SDK 精确能力反例与 W3 合成 stdio/多文件闭包 fixture 保留。

p0-transport.test.ts 的17项覆盖共享帧/字节批次、最大帧与分片 UTF-8、封读后异步响应、原始帧摘要、超限/截断、EOF/全连接关闭、背压不重发、迟到错误和有界排空。其中 child stdout PIPE 回归运行真实 Node 子进程；端点另以真实 PassThrough EOF 验证未解析完余留帧时已同步 fence，该测试的 grant/receipt 为受控模型输入。两者都不证明物理故障或停止 SLO，复跑命令和原始报告集中见 [入口说明](../../apps/host/README.md)。

p0-startup-stop.test.ts 通过真实 Host SIGSTOP 验证启动取消期间按配置升级终止：监督记录实际 Host SIGKILL 退出与 connect 阶段 startup_rejected 后，以 code 0、signal null 退出；该断言定位启动异常路径，不以已就绪后的正常 close 代替。Host 自有路径清理以及未经认证查询的端点清理仍为 UNKNOWN，保留故障 fixture 和 raw 供复核。原始失败分类及证据索引见入口说明。

p0-observation.test.ts 覆盖真实 CLI host-query 的双身份固定、独立缓存/陈旧质量、错会话/来源/凭据、畸形 socket 帧、外来事件拒绝，以及真实启动阶段、spawn/exit/ENOENT；受控模块覆盖跨连接序号、精确去敏、响应抛错前观察、背压/丢失/缺尾、sink 与异步写回调错误。异步写模块另测部分写、EAGAIN/EINTR/零进展、固定期限及晚回调；这些回调故障不是物理文件故障证据。

默认 fd 路径实际验证 FILE 重定向完整序列，以及 PIPE 填满后计时回调仍进展、finish 保留在途状态、当前进程自 SIGKILL 和缺尾原始流。正常捕获逐行核验 Schema、序号、丢失与尾部，背压故障捕获保留真实退出及不完整范围。报告在 reports/p0/w5o/ 与 reports/p0/w5of/；后者含锁定 Node 内置源码的只读核实摘要。FILE 兼容性不证明物理盘阻塞/故障，TTY 未做实际设备验收。复跑命令和完整检查日志入口见 [apps/host](../../apps/host/README.md)。

p0-reducer.test.ts 覆盖默认无权、准入与回执绑定、续租/心跳分离、原请求与 timer 期限、跨连接重复操作、撤权与后到回执、自然完成/停止乱序、终态与独立清理、逐资源隔离和容量预留；同时验证两类端点期限的错域/倒序/未来签发、未来监督代次及错误 grant 绑定拒绝、旧代次与过期历史，以及停止截止前/等于/之后接收证明的竞争。reports/p0/w5rf/module-after.log 记录26/26受控模块测试；module-coverage.json 标明 controlled-module、20个 P0 可达 source/event 组合及 missing=[]，保留实际归约观察。禁用的 unattended_approved 不制造准入条件，其拒绝与 test_only/public 拒绝保持。supervision_outputs_safe 的缺失/错 owner 反例单列纯守卫来源，不冒充可达生产转换。完整检查原始输出、退出码和环境见同目录 check.log、check.exit、environment.log，复跑命令见 apps/host。

p0-service.test.ts 的16项受控模块测试覆盖 N=1 普通任务饱和时独立安全/查询/Host health、冻结输入及原 trigger、先 fence 后容量拒绝、期限与 unfinished 回收、断连与迟回调、候选淘汰/固定期限、固定 peer 分类与当前代次、同 chunk 管理封读、N=1 peer 鉴权流水、慢回包连接额度、默认无权及身份/角色拒绝。受控委派中的稳定 actor 账本用于验证调用边界，不是生产账本。真实 UDS 身份/帧及 Host 缓存查询覆盖沿用 p0-identity/p0-authority/p0-observation 测试；原始输出、失败诊断及复跑命令统一见 [入口说明](../../apps/host/README.md)。

有效 lease/receipt、有限效果及竞争正例目前是同生产模型和归约器的受控模块测试，不是 SQLite 或真实操作员授权。W5S-L 显式 CLI、W5S-E 端点双安全接线、W5S-I 生产协调、W6 Worker/事务/Outbox/完整授权闭环、W7 组合故障仍 unsupported；14 个 sut.* 与 exit.P0 保持 PENDING。
