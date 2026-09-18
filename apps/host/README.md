# P0 本机入口

真实 Supervisor、Host、假设备 launcher 与操作员 CLI 已接通。当前能鉴权、核验安装、握手、独立查询、读取 Host 缓存、输出真实进程/协议观测和拒绝无授权效果；持久化 blocked、无 grant，P0 仍 PENDING。逻辑见 [runtime](../../packages/runtime/README.md) 和 [fake-device](../../plugins/fake-device/README.md)。

## 使用

使用 Node 24.21.0、pnpm 11.11.0。入口检查实际 Node，拒绝 NODE_OPTIONS/NODE_PATH。当前 worktree 可使用 `.cache/toolchains/node-v24.21.0-darwin-arm64/bin`，这不是其它机器的环境保证。

```sh
pnpm generate
pnpm p0:install /absolute/private/new-fake-directory counter-id
pnpm p0:supervisor --config /absolute/private/runtime.json
pnpm p0:operator --config /absolute/private/runtime.json --command authenticate
pnpm p0:operator --config /absolute/private/runtime.json --command query
pnpm p0:operator --config /absolute/private/runtime.json --command host-query
```

p0:install 显式复制当前生成制品到新目录并输出已核验 P0TrustedInstallation；父目录须当前 UID 的 0700 实目录。启动不重写信任清单、不自动接受改动。本包不初始化凭据、运行配置或数据库；测试只在临时目录建立隔离材料。配置、密钥、数据不入库。

Schema、固定路径和身份规则以 [P0 简报](../../docs/generated/P0.md)及[第22章](../../docs/spec/22-tech-storage-deployment.md)为准。真实启动只允许 bellis-p0-fake-device 单 ESM、仅 P0 simulation；通用 SDK 结构校验不授予安装信任。

## 进程、所有权与失败

Supervisor 校验 P0RuntimeConfig 与实际安装，创建管理 socket，用私有 fd 3 启动 Host。Host 仅接收 P0HostBootstrap，再核验后通过另一个私有 fd 3 启动 endpoint-launcher.mjs。P0EndpointConfig 只含端点自身临时密钥、Host/监督公钥和有限配置，不含操作员凭据、数据库或核心私钥。argv/env/log 不承载秘密；子进程环境只有实际 Node 路径和固定 LANG。

launcher 受控读取一次入口 Buffer，核验后执行该 Buffer 的 data: ESM，不重新按原路径加载。Host↔Endpoint 使用固定 stdio；Supervisor 直连独立 safety UDS，查询不经过 Host。CLI query 调用 session.query，返回监督独立采集的投影；host-query 调用 host.query，经固定 `.host` socket 同时核验 Host 公钥与 Supervisor 权威 owner，再通过同一操作员鉴权机制读取 Host 本地缓存。它不代理查询、不刷新 received_at；无事实为 unknown，失联或过期为 stale，具体质量判断见 runtime 说明。

进程和协议观测输出至 stderr，端点原始描述符直接继承到监督/runner，Host 阻塞/退出不切断端点观察。P0ProcessObservation、P0ProtocolObservation、P0EndpointObservation 与流尾的来源、去敏、序号和有限背压见 runtime 说明；这些日志只供运行器交叉核验，不授予权限、不证明停止完成、不解除生产隔离。

Supervisor、Host、端点分别拥有自己的 socket/身份文件并只删除记录的 inode，不覆盖冲突路径。默认 stopped、无 grant、持久化 blocked；握手后可查询真实零计数、水位与 Host 连接期限。失联投影变 stale/unknown，进程退出不是端点停止/清理证明。CLI 每命令建立新连接，用真实凭据和一次挑战认证；stdout 保留实际 RPC id 与完整合法成功/失败回包。没有收到 RPC 回包时不制造回包，stderr 只记录安全分类的本地失败。

session.authorize、session.execute、supervisor.register_effect 在真实存储接入前拒绝。操作员停止/续租/故障配置的完整路径待 W5/W6；端点低层安全调用只接受固定监督。核心 authority_epoch 仍为 0，W5 须从固定监督的新验签公告推进，不能由端点自报提升或刷新固定 stdio TTL。重启不恢复旧权，持久化缺口与 UNKNOWN 隔离待 W6。

入口在首个异步步骤前安装信号处理；AbortSignal 关闭未完成握手的通道及已建资源。正常收尾并行推进独立 dispose、Host 业务断开和管理路径清理，dispose 总等待受 stop_timeout_ms 约束；无回执保持未知。Host 释放子进程存活引用，端点继续有限安全查询窗口。没有泛化 pkill 或自动重建。

观测默认使用异步 fd 输出，完整性和在途状态沿同一 writer 对象传递，包含私有 launcher 传入端点的 writer。CLI 的一个 stdout 结果也异步有限排空，正常成功/失败回包保持完整。入口完成必要安全关闭和有限 finish 后检查活跃 OS 写请求；仍在途时只对当前 process.pid 发 SIGKILL，保留真实 signal 与不完整日志，不能把这种退出称为正常成功。无在途请求时按实际业务退出码结束。该策略不关闭继承 fd、不杀父子进程组；库只暴露状态。端点首次可能观察或异步清理前安装最终退出定时器，同步 fence 在任何 await 之前。

## 覆盖

```sh
node --test tests/p0-identity.test.ts tests/p0-authority.test.ts tests/p0-endpoint.test.ts tests/p0-loader.test.ts tests/p0-generation.test.ts
node --test tests/p0-observation.test.ts tests/p0-loader.test.ts
pnpm check
```

真实 socket 测试需允许本机监听，沙箱 EPERM 不能用内存测试替代。reports/p0/w4/ 与 reports/p0/w4f/ 保存端点和身份覆盖；reports/p0/w5o/raw/ 保存真实启动/CLI stdout 与 stderr 原始捕获，正常捕获核验所有行及各来源流尾。reports/p0/w5of/raw/ 保存默认 fd 的 FILE/PIPE 原始字节、控制输出与实际退出元数据，故障流不补尾。两目录保留全部运行日志（含失败运行）；异步 fd 专项见 reports/p0/w5of/observation-third.log 与对应 .exit，15/15；完整锁定环境检查见该目录 check-final.log、check-final.exit。W5O 独立集成检查另见 reports/p0/w5o/l2-check.log。

已覆盖真实 CLI/启动、独立查询、Host SIGKILL、零授权、身份/时钟/Schema、端点取消回包挂起、容量满后的撤权、加载替换与生成漂移；观测新增真实失败响应/退出、Host 与监督投影区分、不刷新缓存、陈旧质量、去敏及日志缺口处理。受控模型的有效 receipt/lease 只证明模块逻辑，不是实际 Worker 或授权证据。三状态机、核心监督协调与容量隔离、Worker/Outbox/完整授权链仍 unsupported，14 个 sut.* 和 exit.P0 保持 PENDING；当前只有 macOS 运行覆盖。
