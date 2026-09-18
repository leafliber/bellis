# P0 假设备

独立进程只改变自身有限队列、计数及模拟状态，不接真实设备、平台或供应商。仅 P0 simulation；Manifest 只声明 darwin，其它系统 SUT PENDING。

## 文件和职责

main.ts 导出固定 startEndpoint(P0EndpointConfig)，由受信 launcher 用同一已验证 Buffer 加载。model.ts 是计数、水位、队列、lease 与端点事实的唯一写入者；protocol.ts 管理 stdio、独立 safety UDS、认证/时钟、封闭故障及有限观察。manifest.source.json 不手填契约摘要。

pnpm generate 将源码及本次内存契约依赖打包为 generated/endpoint.mjs，生成 generated/manifest.json。仅这两个文件排除格式检查，源码继续 TypeScript/Biome。生成检查固定 builtin、无动态/外部分块及跨 checkout 字节一致。

Schema 为 P0EndpointConfig、P0EndpointLease、P0ExecuteInput、P0EndpointRevokeInput、P0EndpointSnapshot、P0EndpointObservation，以及登记的 plugin/controller/clock/fault 命令。字段和精确规则见 [P0 简报](../../docs/generated/P0.md)及[第22.6节](../../docs/spec/22-tech-storage-deployment.md)。端点不签发 grant、不确认人工授权、不写数据库。

## 执行、停止与寿命

stdio 只信固定 Host，safety 只信固定 Supervisor。逐请求校验 Ed25519/Schema、会话、scope、实例、目标时钟及代次；Host auth 与精确 handshake 完成后才设置一次真实连接期限。普通命令精确当前代次，只有监督 lease/revoke 合法推进。

固定监督更新先通过身份、时钟及已有 operation/lease 的完整输入幂等校验，再同步采用新 authority_epoch 并永久封旧 grant；普通历史容量不足或随后的新 lease 准入拒绝不能回滚该栅栏。冲突或无效入口不推进，supervision_epoch 独立核验，不从 authority_epoch 推断。

lease 核验完整 grant/admission 的事务摘要并固定 writer；执行还核验同 writer 的完整 registration、完整动作摘要、目标/能力、预算和队列。原 grant 映射上限首次固定，同 lease/operation 不可变，旧 lease 不覆盖后来租约；新 lease 可传递监督已验证的显式人工续租。实际宿主 W6 前不生成成功 receipt，正向 receipt 只用于受控模块测试。

每单位效果前检查当前 grant、代次、Host 连接、本地/人工/grant/原命令期限和已预留余量。重复 operation 不增加水位/效果，冲突拒绝，完成事实不被后来的 stop 改写。撤权或普通租约失效封旧 grant、清实际队列，但保持仍有效的 Host 连接事实；新 grant 必须由 W5 完整守卫显式批准。

stdio EOF/TTL、监督健康超时或最终实例期限进入不可延长的查询窗口，清 Host 连接期限并禁新效果。绝对寿命为启动点加 max_session_ms 与 cleanup_timeout_ms，首次最终 fence 再收紧到 cleanup_timeout_ms 窗口；心跳/重连/查询不延长。到期只清自身 inode，dispose 可提前结束。永久 OS 挂死不能由本地 timer 证明清理，exit 不等于停止证明。

## 背压、故障和观察

历史最多1024条，接纳前还按实际序列化大小预留最终事实、两份最坏未执行/未知 ID 数组、每条数值增长及消息封装余量；满时拒绝新效果，不截断历史。grant/lease/幂等记录有界，普通与安全 mutation 分开；安全自身记录满时仍先完成合法 fence/清理，禁新权后报告登记失败。

固定监督才能下发封闭 endpoint 故障。queue_full/budget_exhausted 拒绝新效果；cancel_never_returns 只挂起 stop 回包，栅栏与安全通道继续；ack_delay/ack_reverse_order 延迟原事实事件，不改业务结果；event_loop_block 是有限同步故障，结束先查期限；disconnect 封锁并断开；process_exit 实际退出，保留 UNKNOWN 边界。初始 fault 必须 none。

观察是 P0EndpointObservation：每次尝试分配连续序号，失败/容量丢失累计不回退。stderr 写入有界，原始 fd 直达监督/runner；stdout 只协议。观察不参与生产授权或清理归约；缺口/丢失拒绝完整证据结论。

## 覆盖

p0-endpoint.test.ts 覆盖真实生成物启动/握手、安全查询、Host SIGKILL/EOF、零计数、角色/时钟/旧实例/畸形输入、容量满后撤权及挂起 cancel；模块覆盖完整摘要、预算、重复冲突、有限单位、到期、续租上限、最长 ID 最坏事实、完成/停止顺序和事件冲突。权威前进反例区分有效更新后旧 grant 拒绝、相同 lease 重放、三种普通容量耗尽，以及身份/时钟/幂等无效请求不推进。

p0-loader.test.ts 实际验证预检后且私有配置未发送时替换入口拒绝，加载核心已读 Buffer 后换路径仍执行原字节。p0-generation.test.ts 从空生成目录启动、比较跨 checkout 全部生成物、拒绝缺失内存依赖与实际漂移。W3 合成 fixture 独立保留，不冒充本设备。

复跑 `node --test tests/p0-endpoint.test.ts tests/p0-loader.test.ts tests/p0-generation.test.ts` 与 `pnpm check`。完整日志在 reports/p0/w4/ 与 reports/p0/w4f/。这些是中间包覆盖，14个 sut.* 与 exit.P0 仍 PENDING；真实授权、SQLite 故障、状态机归约和组合故障须 W5–W7 验证。
