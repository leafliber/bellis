# P0 运行时

本包负责真实本机身份、安装、时钟、有界协议与进程接线，不实现媒体、供应商、自动恢复或通用结算。可运行入口见 [apps/host](../../apps/host/README.md)，端点模型见 [fake-device](../../plugins/fake-device/README.md)。

## 模块和 Schema

| 模块 | 职责与契约 |
| --- | --- |
| files.ts | UID/权限、实路径、私有 bootstrap、inode 所有权；P0OperatorCredential、P0PeerIdentity。 |
| config.ts | P0RuntimeConfig、P0HostBootstrap、P0TrustedInstallation、实际 Manifest 与依赖闭包。 |
| identity.ts | Ed25519 公告/peer 挑战、HMAC 与一次挑战；P0ConnectionAnnouncement、P0PeerProof、P0OperatorProof。 |
| clock.ts | 单调时钟、保守区间与目标域期限；P0ClockMapping、Deadline。 |
| transport.ts | socket/stdio 有界 UTF-8 NDJSON、严格 JSON、有限写入和立即停止接收。 |
| client.ts | 验签、有限 pending/时限、原始回包、端点来源及序号/版本冲突检查。 |
| service.ts | 核心角色/scope/时钟/摘要与初始代次检查；未接真实存储前拒绝新效果。 |
| endpoint-loader.ts | O_NOFOLLOW、有限一次 Buffer、文件身份及内容哈希，生成固定 data URL。 |
| endpoint-client.ts | 私有启动、stdio 鉴权/握手、精确 Manifest 与 P0EndpointSnapshot 查询。 |
| processes.ts | Supervisor/Host 生命周期、最小环境、独立安全轮询和各自 P0EndpointProjection。 |

字段与算法只在 [contracts/src](../../contracts/README.md)、[P0 简报](../../docs/generated/P0.md)和[第22.6节](../../docs/spec/22-tech-storage-deployment.md)维护。SDK bindVerifiedP0Installation 是进程内绑定，生产只在实际文件核验完成后使用。

## 加载信任

清单固定文件 SHA-256、Manifest 摘要、插件/协议/契约身份及能力/目标白名单。实路径无符号链接，当前 UID、无组/其它用户写权限，每文件最多 32 MiB；缺项、重复、替换和身份不符拒绝。verifyInstallation 保留多文件静态 ESM 的只读核查，供 W3 闭包反例；真实配置/Host bootstrap 只允许本包单制品假设备。

生成器使用本次内存契约 Map 打包端点。生产制品仅允许固定 node:crypto、node:events、node:fs、node:fs/promises、node:net、node:path，无外部分块、动态加载或真实效果入口。launcher 唯一 data: import 只执行已验证 Buffer，不再读取原路径。该机制不是恶意代码沙箱，不向端点注入操作员/供应商凭据。

## 身份、状态与时钟

认证主体来自受控凭据，peer 角色来自固定公钥。公告外层发布者与签名 Session owner 分别核验，载荷 owner 固定为监督，外层 epoch 必须相等；客户端保存不可变验签公告。管理 proof 防重放与业务 operation 去重分开，W5/W6 须按稳定主体维护业务操作表。

Supervisor 是监督/grant/StopOperation 的预定唯一归约者，当前只维护初始 stopped、健康及独立端点观察；Host 持执行入口和本地投影。端点独占队列、计数、水位和停止/清理事实。同 source_revision 的完整 fact 固定，读取时间放 Projection.received_at。事件冒充、错误实例/代次、同 source_seq 或 source_revision 异载荷均拒绝；一致旧事件不覆盖新投影。事件历史有界，不能继续证明时关闭连接，不截断事实。

映射由验签公告和客户端前后采样生成，包含 ±1ms 量化保护；期限受目标域、实例、误差和 TTL 检查，失效不猜换算、不自动延期。legacy plugin/controller 封闭输入复用连接认证缓存映射。固定 stdio 不续 TTL，断开/到期先 fence，独立 safety UDS 继续有限查询/清理。

当前生产核心 epoch 仍为 0。端点区分首次 auth 的公告投影、普通请求精确当前代次与监督 lease/revoke 合法推进。W5 要将事件 currentEpoch getter 接到固定监督新验签投影；不能从端点反向提升权威，也不能把零代次接线当 I81 完成。Worker 时钟与事务由 W6 接入。

## 资源、失败与清理

P0SafetyLimits 限制帧、pending、连接、映射及租约，配置不是实测 SLO。单连接缓冲最多一帧；非法 UTF-8、重复键、批请求、通知、字段和未知方法拒绝，非法前缀后的同 chunk 不再处理，错误回包最多排空 100ms。超时关闭连接并清 pending；安全停止不等待普通业务队列。

私有 bootstrap 最多 16 MiB、5 秒。监督等待 Host 健康和独立端点握手事实最多 5 秒。通常终止子进程先 SIGTERM，1秒后 SIGKILL，总2秒仍无退出报 CHILD_STOP_UNCONFIRMED；监督收尾用 stop_timeout_ms 作 Host 软停止宽限，同时清自己服务和有界 dispose。退出不是端点事实。Host 健康丢失后的完整自身寿命仍待 W5。

端点 stderr 原始 fd 直接继承；生产只采认证 RPC/event/query，日志不是授权/清理输入。只清自身 inode，异常遗留不覆盖、不自动恢复。永久 OS 死锁不是本地 timer 能保证的清理范围；无证明保持 UNKNOWN。

## 实际覆盖与未完成项

reports/p0/w4/ 保存真实身份/CLI、单制品启动、独立查询、Host SIGKILL、零权拒绝、取消挂起、容量隔离、TOCTOU、空生成目录和跨 checkout 全部生成物一致/漂移拒绝结果。SDK 精确能力反例与 W3 合成 stdio/多文件闭包 fixture 保留。

有效 lease/receipt、有限效果及竞争正例目前是同生产模型的受控模块测试，不是 SQLite 或真实操作员授权。W5 三状态机、W6 Worker/事务/Outbox/完整授权闭环、W7 组合故障待实现，sut.* 与 exit.P0 不提升。复跑命令见入口说明。
