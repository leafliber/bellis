# ADR 0048：独立游戏平台、Session Activity 与桌面输入归属

状态：规划采纳，待实现与验收。日期：2026-09-07。

依据：用户要求按 [多游戏仓库与部署设计 v0.4](../design/game-runtime-multigame-v0.4.md) 修订 Phase 5 及以后计划。本文替代长期架构和技术选型中“Bellis 内部维护游戏执行器、直接连接 Rust Game Sidecar、Phase 5 一次完成游戏和全部产品化”的未来安排；不改变当前已交付协议，也不撤销 [ADR 0047](./0047-phase4a-recovery-scope-freeze.md) 的 Phase 4A 冻结结果。

## 问题与取舍

不同游戏需要复用调度、恢复和部署能力，游戏快循环又必须靠近交互桌面。把执行引擎放入 Bellis，或按游戏复制 Runtime/插件，会让宿主与游戏知识耦合。仅按 game_session_id 加输入锁，不能防止多个进程争用同一个桌面的物理设备。

采用两个游戏集成仓库：Bellis 与独立游戏平台，游戏平台名称暂定 `game-agent-runtime`。Iris 继续为既有独立项目。自维护游戏先在游戏平台内作为独立 Game Pack 发布；依赖冲突先隔离 Worker/Runner 环境，维护团队、权限或许可确有独立需求时再拆游戏仓库。无需第三个共享 SDK 仓库。

## 归属与协议

| 归属 | 唯一负责的内容 |
| --- | --- |
| Bellis | 人格、Decision Loop、ActionFrame、直播 Scene、公共 Plugin SDK、GameProvider/Session Activity 宿主契约、可信连接与 Activity 生命周期 |
| 游戏平台 | Python Runtime/Core/Host、任务图与尝试、执行合法性、资源与检查点、Adapter SDK、Game Pack、平台捕获和 Worker、原生 Input Broker |
| 游戏平台中的薄插件 | 仅通过 Bellis Plugin SDK 和 Game Client SDK 映射宿主意图、状态、事件及回执；不维护第二套任务图 |
| Iris | 原有长期记忆服务；集成模式由 Bellis 统一写入 |

Game Client SDK 属于游戏平台的 TS 发布包，不依赖 Bellis 私有类型；Game Adapter SDK 属于游戏平台的 Python 公共包。游戏公共契约以 Adapter SDK 的 contracts 为源，生成服务 OpenAPI/JSON Schema/TS 类型；Bellis 契约独立维护，由薄插件映射。禁止跨仓源码导入和共享数据库文件。

首版采用 Windows 同机、独立进程、attach。薄插件经 HTTP JSON/OpenAPI 发命令和查询，经带游标 SSE 收事件；Runtime 与 Broker 采用本地受认证、有截止时间的 IPC，具体编码在协议 Gate 冻结。原 Bellis→Sidecar gRPC 方案不再作为游戏服务边界。跨机以后沿用同一语义协议，增加配对和加密；帧与实时按键不经过远程 Bellis 往返。

## 生命周期与输入权威

Session Activity 属于 Bellis Session，生命周期独立于单次 Turn/Scene；普通聊天取消不能误杀长期游戏活动。Bellis 选择活动及权限，Game Runtime 拥有任务执行、尝试和检查点提交。Scene 负责直播表现及约定的高层时间锚点，不逐帧派发按键。未来活动契约必须明确停止、撤权、恢复与关闭责任；当前代码尚不因此获得新能力。

这限定了 ADR 0007 的适用范围：Bellis Tool Runtime 继续执行其已有调用列表，游戏 Runtime 可以拥有领域任务图；同一图不能由 Bellis 与游戏 Host 重复调度。Agent 可异步提出候选计划，执行合法性由 Runtime 在版本、授权及检查点上重新核验，战斗不等待普通 LLM 回复。

一个 Game Session 至多一个控制 owner，其他客户端只能观察。命令绑定受信连接、Host/epoch、Session/binding、authority epoch 与稳定 operation_id，区分 accepted/applied/completed。超时查询原操作，不通过新 ID 重复副作用；输入 API 接受也不代表游戏任务完成。

Broker 在 `host/desktop/foreground-input` 上提供父级独占，下面才是 Game Session 和根控制器资源。多个 Runtime 进程必须共享这一个权威或经验证的平台独占机制。首版同桌面仅一个可控会话；本地 Arm、撤权、迟到命令拒绝、看门狗和急停不能由上层会话锁代替。网络连接失联策略与本地 Broker 心跳分开冻结，有限继续执行只能发生在事先授权的边界内。

切换游戏须结束/暂停旧活动、确认输入释放、撤销旧绑定，再创建新会话并重新授权；清理失败不交接。候选任务图的检查点更新不等于热加载 Python 代码或模型；Session 固定使用启动时校验的包和模型。

集成模式由 Bellis 统一语音与 Iris 写入，阅读回执须来自已确认的呈现事实；游戏平台不自行重复播报或写同一段记忆。独立 CLI 可作为单独控制 owner 使用同一服务，其可选语音/记忆适配不得与集成模式双写。

## 兼容与交付

Phase 5 先交付公共包、FakeGame 服务和真实插件注册路径；Phase 6 完成 Windows 单 Host 原神闭环；Phase 7 以第二款真实游戏和跨机连接验证抽象；Phase 8 再完成 managed 启动及正式产品化。详见 [路线图](../phase-5-and-beyond-roadmap.md)。这些 Phase 是本次工程排期，不与原长期 Milestone 编号强行一一对应。

当前 GameIntent、Scene Wire 和工具调用列表继续按既有协议解释。新增 Activity、状态机、operation/事件和兼容版本须先过 Phase 5 契约 Gate；不直接把设计示例复制到稳定协议。v0.4 引用的 v0.3 正文未在本次读取中取得，继承但未展开的精确状态机、阅读回执、双层心跳和候选提交规则列为明确待冻结项。

本次仅修改计划，不代表外部仓库、包、进程或 API 已创建。首轮可用 CI tarball/wheel 完成干净 consumer 安装，不以公开 npm/PyPI 发布作为前置。长期模型与录屏存 artifact/资产服务；应用组合清单固定所有实际验证的版本与哈希。
