# P0 运行时

本包负责真实本机身份、安装、时钟、有界协议、进程接线与只读观测，不实现媒体、供应商、自动恢复或通用结算。当前具备零授权启动与查询；三状态机、独立监督的完整协调和真实持久化链仍 unsupported。可运行入口见 [apps/host](../../apps/host/README.md)，端点模型见 [fake-device](../../plugins/fake-device/README.md)。

## 模块和 Schema

| 模块 | 职责与契约 |
| --- | --- |
| files.ts | UID/权限、实路径、私有 bootstrap、inode 所有权；P0OperatorCredential、P0PeerIdentity。 |
| config.ts | P0RuntimeConfig、P0HostBootstrap、P0TrustedInstallation、实际 Manifest 与依赖闭包。 |
| identity.ts | Ed25519 公告/peer 挑战、HMAC 与一次挑战；P0ConnectionAnnouncement、P0PeerProof、P0OperatorProof。 |
| clock.ts | 单调时钟、保守区间与目标域期限；P0ClockMapping、Deadline。 |
| transport.ts | socket/stdio 有界 UTF-8 NDJSON、严格 JSON、有限写入和立即停止接收；区分解析、派发与传输失败。 |
| client.ts | 验签、有限 pending/时限、原始回包、端点来源及序号/版本冲突检查；真实收发接点的协议观测。 |
| service.ts | 核心角色/scope/时钟/摘要与初始代次检查，鉴权 host.query；未接真实存储前拒绝新效果。 |
| endpoint-loader.ts | O_NOFOLLOW、有限一次 Buffer、文件身份及内容哈希，生成固定 data URL。 |
| endpoint-client.ts | 私有启动、stdio 鉴权/握手、精确 Manifest 与 P0EndpointSnapshot 查询。 |
| processes.ts | Supervisor/Host 生命周期、最小环境、独立安全轮询和各自 P0EndpointProjection。 |
| observation.ts | 轻量共享 writer、精确认证器去敏、Schema 化观察与内部触发关联；P0ProtocolObservation、P0ProcessObservation、P0EndpointObservation、P0ObservationStreamEnd。 |
| process-observation.ts | 父进程真实 spawn/error/exit 接点及实际启动参数摘要；不进入端点加载闭包。 |

字段与算法只在 [contracts/src](../../contracts/README.md)、[P0 简报](../../docs/generated/P0.md)和[第22.6节](../../docs/spec/22-tech-storage-deployment.md)维护。SDK bindVerifiedP0Installation 是进程内绑定，生产只在实际文件核验完成后使用。

## 加载信任

清单固定文件 SHA-256、Manifest 摘要、插件/协议/契约身份及能力/目标白名单。实路径无符号链接，当前 UID、无组/其它用户写权限，每文件最多 32 MiB；缺项、重复、替换和身份不符拒绝。verifyInstallation 保留多文件静态 ESM 的只读核查，供 W3 闭包反例；真实配置/Host bootstrap 只允许本包单制品假设备。

生成器使用本次内存契约 Map 打包端点。生产制品仅允许固定 node:crypto、node:events、node:fs、node:fs/promises、node:net、node:path，无外部分块、动态加载或真实效果入口。launcher 唯一 data: import 只执行已验证 Buffer，不再读取原路径。该机制不是恶意代码沙箱，不向端点注入操作员/供应商凭据。

## 身份、状态与时钟

认证主体来自受控凭据，peer 角色来自固定公钥。公告外层发布者与签名 Session owner 分别核验，载荷 owner 固定为监督，外层 epoch 必须相等；客户端保存不可变验签公告。管理 proof 防重放与业务 operation 去重分开，W5/W6 须按稳定主体维护业务操作表。

Supervisor 是监督/grant/StopOperation 的预定唯一归约者，当前只维护初始 stopped、健康及独立端点观察；Host 持执行入口和本地投影。端点独占队列、计数、水位和停止/清理事实。同 source_revision 的完整 fact 固定，读取时间放 Projection.received_at。事件冒充、错误实例/代次、同 source_seq 或 source_revision 异载荷均拒绝；一致旧事件不覆盖新投影。事件历史有界，不能继续证明时关闭连接，不截断事实。

映射由验签公告和客户端前后采样生成，包含 ±1ms 量化保护；期限受目标域、实例、误差和 TTL 检查，失效不猜换算、不自动延期。legacy plugin/controller 封闭输入复用连接认证缓存映射。固定 stdio 不续 TTL，断开/到期先 fence，独立 safety UDS 继续有限查询/清理。

当前生产核心 epoch 仍为 0。端点区分首次 auth 的公告投影、普通请求精确当前代次与监督 lease/revoke 合法推进。W5 要将事件 currentEpoch getter 接到固定监督新验签投影；不能从端点反向提升权威，也不能把零代次接线当 I81 完成。Worker 时钟与事务由 W6 接入。

host.query 经 operator.query 鉴权，核验当前会话及固定端点来源，返回 Host 自己的 P0EndpointProjection；不调用监督或端点查询，不刷新 received_at。无事实为 unknown，实际连接关闭、映射失效或缓存年龄达到 peer_health_timeout_ms 时为 stale。监督独立查询所得的投影与 Host 缓存分别拥有自己的接收时钟，不能互相冒充。

## 只读运行观测

每个实际固定进程实例使用一个 writer，同一协议流的所有连接及收发方向共用序号；每次记录尝试占用序号，失败和容量丢失累计。进程记录来自真实 spawn/error/exit 回调，启动拒绝记录实际执行阶段；尚未绑定实例的失败只产生一次 null 来源的失败记录。child 的预期实例与实际 PID 分开，EOF、发出信号或清理函数返回都不补造 exit。

协议记录来自 JsonChannel、RpcConnection 和实际服务入口。request_received 在解析及 RpcRequest 校验后、业务守卫前产生，内部关联交给后续归约器，不增加 RPC 字段。原始事件接收与业务采信分开，公告接收独立分类；失败响应在向调用方抛错前保留完整合法回包。完整非法帧只保留字节摘要和长度，截断没有完整帧摘要。解析异常与下游回调异常分别记录，不把业务异常写成非法 JSON。

去敏仅处理契约指定的认证器，保留其摘要及其余合法消息。SDK 的 SchemaValidationError 提供真实 Schema 名和校验 keyword；缺失或无法安全验证时降级为 internal，未知异常不解析 message、stack 或路径。日志不接受外部指定的守卫结果，也不作为生产授权、停止或解除隔离的输入；完整性与证明边界见[第24章](../../docs/spec/24-verification.md)。

观测单条预算为 max_message_bytes 加 4096 字节固定封装余量，队列最多 max_pending_requests；不扩大协议帧准入。默认 AsyncFdSink 使用公开异步 fs.write 写继承 fd 2，单 FIFO 只保留一个 OS 写请求在途，不调用 process.stderr.write/writeSync，也不关闭 fd 2。部分写维护偏移；EAGAIN/EINTR/零进展重试受入队时固定的 1000ms 绝对期限限制，不续期。超时或写失败关闭该 sink，未确认范围保持不完整，晚回调不再续写。受控 Writable sink 的 false 返回只表示背压，error/close 受控处理，不冒充物理 OS 故障。

安全操作不等待日志排空；JSON 校验和编码仍有受消息上限约束的 CPU 开销。finish 默认预算 100ms，返回完整性、未完成记录及实际 OS 在途状态；正常结束只给已使用流写一次 P0ObservationStreamEnd，失败/超时不补尾或补零。有限 finish 返回不代表 OS 请求已结束，运行库不 exit/kill；实际入口的有限退出见 apps/host。参数是资源上界，不是实测 SLO，也不保证物理不可调度的 OS 故障能够按时终止。

## 资源、失败与清理

P0SafetyLimits 限制帧、pending、连接、映射及租约，配置不是实测 SLO。单连接缓冲最多一帧；非法 UTF-8、重复键、批请求、通知、字段和未知方法拒绝，非法前缀后的同 chunk 不再处理，错误回包最多排空 100ms。超时关闭连接并清 pending。端点已有独立停止通道；核心业务与安全工作的容量隔离仍待 W5S，不以当前零授权入口宣称完成。

私有 bootstrap 最多 16 MiB、5 秒。监督等待 Host 健康和独立端点握手事实最多 5 秒。通常终止子进程先 SIGTERM，1秒后 SIGKILL，总2秒仍无退出报 CHILD_STOP_UNCONFIRMED；监督收尾用 stop_timeout_ms 作 Host 软停止宽限，同时清自己服务和有界 dispose。退出不是端点事实。Host 健康丢失后的完整自身寿命仍待 W5。

端点 stderr 原始 fd 直接继承；生产只采认证 RPC/event/query，日志不是授权/清理输入。只清自身 inode，异常遗留不覆盖、不自动恢复。永久 OS 死锁不是本地 timer 能保证的清理范围；无证明保持 UNKNOWN。

## 实际覆盖与未完成项

reports/p0/w4/ 保存真实身份/CLI、单制品启动、独立查询、Host SIGKILL、零权拒绝、取消挂起、容量隔离、TOCTOU、空生成目录和跨 checkout 全部生成物一致/漂移拒绝结果。SDK 精确能力反例与 W3 合成 stdio/多文件闭包 fixture 保留。

p0-observation.test.ts 覆盖真实 CLI host-query 的双身份固定、独立缓存/陈旧质量、错会话/来源/凭据、畸形 socket 帧、外来事件拒绝，以及真实启动阶段、spawn/exit/ENOENT；受控模块覆盖跨连接序号、精确去敏、响应抛错前观察、背压/丢失/缺尾、sink 与异步写回调错误。异步写模块另测部分写、EAGAIN/EINTR/零进展、固定期限及晚回调；这些回调故障不是物理文件故障证据。

默认 fd 路径实际验证 FILE 重定向完整序列，以及 PIPE 填满后计时回调仍进展、finish 保留在途状态、当前进程自 SIGKILL 和缺尾原始流。正常捕获逐行核验 Schema、序号、丢失与尾部，背压故障捕获保留真实退出及不完整范围。报告在 reports/p0/w5o/ 与 reports/p0/w5of/；后者含锁定 Node 内置源码的只读核实摘要。FILE 兼容性不证明物理盘阻塞/故障，TTY 未做实际设备验收。复跑命令和完整检查日志入口见 [apps/host](../../apps/host/README.md)。

有效 lease/receipt、有限效果及竞争正例目前是同生产模型的受控模块测试，不是 SQLite 或真实操作员授权。W5R 三状态机、W5S 独立监督协调/容量隔离、W6 Worker/事务/Outbox/完整授权闭环、W7 组合故障仍 unsupported；14 个 sut.* 与 exit.P0 保持 PENDING。
