# G5.5 构建指南：公共游戏边界与 FakeGame 联调

状态：待实施。范围依据 [ADR 0048](../../adr/0048-external-game-runtime-and-session-activity.md)、[游戏线](./README.md) 和 [双线路线图](../README.md)。本页仅覆盖 Phase 5 游戏线；直播 L5 与联合 J5 见 [总入口](../phase-5.md)。本线建立可安装、可取消、可对账的跨仓接缝；真实原神、键鼠和产品发行分别在后续阶段验收。

## 1. 开工基线与明确范围

从 Bellis `bf91500` 之后包含本规划修订的提交开始，记录两仓实际 commit、工作区状态、锁文件与安装物哈希。Bellis 已有 Decision Loop、Scene、Iris 与 GameIntent 的局部类型，不存在已经完成的公共 Plugin SDK、Session Activity 或游戏服务；不得从现有 `game` Cue lane 推导已经能执行外部长期游戏任务。

开工先运行现有 `pnpm check`、`pnpm test:acceptance`，Iris Provider 按 [构建与验收](../../guides/build-and-validation.md) 独立检查；CI 要覆盖实际目标分支/PR，并记录 Windows/macOS 结果。以上命令都从 Bellis 根目录运行。它们提供回归基线，不证明新游戏 Gate 通过。

G5.5 必做：

- Bellis 公共 Plugin SDK 的最小可发布面，GameProvider、Session Activity、可信连接与权限生命周期。
- 游戏仓库的公共 Adapter SDK、无具体游戏依赖的最小 Runtime Host/Core、FakeGame 与状态可控的测试服务。
- 从游戏公共契约生成的 OpenAPI/JSON Schema/TS 类型、Game Client SDK 及一个 Bellis 薄插件。
- attach、同会话单控制 owner、桌面父资源的协议模型、带身份的操作/事件/阅读回执与恢复对账。
- 使用实际包产物的干净 consumer 验收，拒绝私有源码跨仓依赖。

本阶段不交付真实 Windows 输入或原神战斗，不实现完整任务编排算法、managed 进程启动、多 Host 调度、第二款真实游戏和安装器。FakeGame 应能证明协议和生命周期，不复制未来游戏算法。游戏 Runtime 的真实执行与 Broker 由 Phase 6 接续。

## 2. 先冻结的语义（G5.0）

v0.4 在源码中作为 [不可修改的输入快照](../../design/game-runtime-multigame-v0.4.md) 保存；SHA-256 为 `ed4c32e6ee78a905e911739c336a6913884565c0c0d7335999c9fa019ea026ae`。其引用的 v0.3 未取得可读正文，下表所需精确规范必须通过补充原文或显式兼容决策形成，不能声称已按未知接口实现。可先开发不依赖缺项的测试与包边界。

| 冻结项 | 必须回答的问题 |
| --- | --- |
| Session Activity | 与 Bellis Session、Turn、Scene 的绑定；谁创建、停止、取消、撤权、恢复；普通 Turn 取消与操作员停止 Activity 如何区别 |
| 游戏任务与候选 | 任务、attempt、候选和 operation 的身份及持久关系；哪些状态转换属于 accepted/applied/completed；候选怎样绑定版本并在检查点重验 |
| 连接与授权 | registered connection、Host/runtime epoch、game session/binding、authority epoch 的核对；owner 争用、撤销及迟到命令如何拒绝 |
| 心跳与失联 | Bellis↔Runtime 网络失联与 Runtime↔Broker 本地失联分别如何计时；有限继续执行范围、停止边界、租约到期与本地安全释放指标 |
| 事件与快照 | cursor 所属流与 epoch、快照水位、排序/去重、cursor_expired、补取与缺口期间的控制策略 |
| 阅读和记忆 | 游戏剧情/事件的呈现标识与真实阅读回执；Bellis 统一 TTS/Iris 写入；重试、部分呈现、取消及独立模式 owner 切换怎样去重 |
| 公共版本 | Bellis SDK、线协议 major/features、Adapter API、Broker 协议、Game Pack/模型支持矩阵及不兼容行为 |

本地输入安全沿用原项目取消/失联释放 ≤100ms 的验收目标；G5.0 必须区分检测阈值、释放动作耗时和端到端统计口径，不能只把心跳设为 100ms 就宣称达标。Phase 5 用虚拟时钟/模拟 Broker 验证协议，真实物理释放在 Phase 6 测量。

## 3. 分层所有权与不变量

```text
Bellis Session Activity：活动绑定、授权、直播表达
  → Game Runtime Host：会话生命周期、桌面资源分配
    → Session Task Engine：任务图、尝试、检查点和恢复
      → Controller：实时感知与技能
        → Broker：host/desktop 独占、租约、真实输入与看门狗
```

Host 不复制 Session 的 DAG，Bellis Tool Runtime 不新增通用游戏 DAG。普通聊天继续使用已有 Turn/Cycle 语义；长期 Activity 不因一句话结束而销毁。候选图更新是 Runtime 核验后的业务变更，代码/模型只能在受控停用后更新。

所有命令使用稳定 operation_id，超时走原操作查询与状态恢复。业务成功只由相应层的可验证结果支持，服务接收、操作应用、设备输入提交与游戏效果完成不得混称。完整写入绑定需在持久化/请求发出边界复核，旧 runtime/authority epoch 的迟到响应不能恢复权限。

游戏物理输入只有主机/桌面的 Broker 权威；即使未来多个 Runtime 进程也不能各自绕开父资源。FakeGame 先验证跨会话争用与撤权，真实 Broker 不在 Bellis 仓库实现。

集成模式只有 Bellis 进行直播语音与 Iris 写入；Game Pack 提供事件与证据，不能在插件内另开 TTS/Memory 通道。记忆与证据记录按 game、profile、session、entity 来源隔离，不仅凭同名角色合并实体。独立 CLI 使用同一服务，控制 owner 切换不能产生双写。

## 4. 工作包与包产物

| 工作包 | Bellis 仓库 | 游戏平台仓库 | 交付验证 |
| --- | --- | --- | --- |
| **P0 契约与夹具** | 冻结 Activity/GameProvider 的公共面与既有协议兼容策略 | 冻结 runtime-sdk 公共模型、能力清单与线协议；实现无真实输入的 FakeGame | G5.0 问题有明确答案，公共 fixture、版本负例与状态转换测试可执行 |
| **P1 宿主 SDK** | 可打包的 Plugin SDK；受信注册、权限、Activity 所有权、禁用/关闭清理、事件到 Signal/Context 的有界映射 | 无需引入 Bellis 私有 types；准备 SDK consumer | 插件只能依赖正式 exports；Turn 结束不误取消 Activity，显式停止/撤权正确结算 |
| **P2 服务与 Client** | 保留既有平台无关构建 | runtime-host/core → runtime-sdk；FakeGame → Adapter SDK；生成 OpenAPI 与 TS 类型，提供 HTTP/SSE Client | 能力状态、操作查询、事件/快照、取消与缺口对账通过；Core 无具体游戏 import |
| **P3 通用薄插件** | 加载已安装插件，可信连接注册和明确目标选择 | bellis-plugin-game 只依赖两个 TS SDK；独立 CLI 使用同一服务 | attach 后协商→绑定→授权→Activity→结果；不由模型提供 URL/路径/token；多个写客户端只准一个 owner |
| **P4 干净安装与回归** | 输出 SDK/contracts tarball，独立 CI；更新真实可执行命令索引 | 输出 Host/Core/Adapter wheel、Client/插件 tarball、最小组合清单与 consumer 测试 | 移除相邻源码和 link 后全过程通过；各仓独立可构建；阶段摘要与 artifact 可追溯 |

P0–P4 按依赖推进，每包结束就联调对应公开边界。暂不需要公开 npm/PyPI 发布；CI 构建产物足以验收。新仓库在实际实施范围明确后创建，本次计划修改不建立空仓或占位包。Bellis SDK 的注册/权限/生命周期同时服务 L5 平台插件，不另建一套直播插件宿主。

v0.4 的 handshake、games、sessions、capabilities 路由是拟议入口。P0 将完整协议落到游戏公共 Python 模型，服务与 Client 从同源生成；不要在 Bellis contracts 中再复制一套游戏服务 Schema。静态包发现先验证来源/哈希/允许列表，再加载选定包；entry point 自身不作为沙箱或授权证明。

## 5. G5.5 验收矩阵

以下为需实现的新检查，不是当前已有命令或已通过证据。

| Gate | 最少场景 | 通过依据 |
| --- | --- | --- |
| **G5.1 包与依赖** | 无原神包可运行 FakeGame；Core 不 import 游戏包；Client 不依赖 Bellis 私有类型；薄插件只走公开 SDK | 架构检查、真实 exports consumer、两仓独立构建与协议生成无漂移 |
| **G5.2 所有权/资源** | 两个客户端抢同一 Session；两个 Session 抢同一桌面；Turn 结束、活动停止、禁用插件、宿主关闭、owner 撤权 | 至多一个合法控制 owner；无重复 DAG；清理失败拒绝交接；无遗留任务和授权 |
| **G5.3 操作/恢复** | 发送前后超时、服务重启、ACK 丢失、重复 operation、epoch/能力/目标版本变化、迟到取消/结果 | 原 ID 对账、状态不回退、不重复副作用；accepted/applied/completed 分别可观测 |
| **G5.4 事件/表现** | SSE 重连/去重、cursor_expired、快照与流的水位关系、旧 Session 事件、部分播报及重复阅读 ACK | 缺口显式报告；旧状态隔离；不把模型生成或服务发送当作已阅读；集成模式仅一个语音/记忆 owner |
| **G5.5 安装组合** | 只有包产物的干净 consumer；不兼容 SDK/包、缺资源、只读用户、未 Arm、允许列表外的包 | 拒绝非法能力而不损坏其他会话；无相邻源码依赖；可运行的 attach/取消/恢复演示 |

错误注入使用公开可替换端口或测试私有 IPC，不增加生产 HTTP/模型可用的故障入口。FakeGame 可模拟两种不同能力目录证明通用路由，但第二款真实游戏和真实桌面独占仍分别属于 Phase 7/6 的 Gate。

交付摘要记录：两仓提交及安装物、实际命令与退出码、G5.0–G5.5 结果、剩余外部条件。原始逐次记录保存 CI artifact；不能沿用 Phase 4A 的历史测试计数宣称新 SDK/游戏接口通过。

## 6. 精简 goal prompt

```text
按 docs/plans/game/phase-5.md 和 ADR 0048 完成游戏线 G5 公共接入（完整 Phase 5 另需 L5/J5）。
先冻结缺失的 v0.3 继承语义与 G5.0–G5.5 验收范围，再交付 Bellis Plugin SDK、GameProvider/Session Activity，以及独立游戏平台的最小 Runtime/Adapter SDK、FakeGame、HTTP/SSE Client 和单一薄插件。走 attach 与真实插件注册路径，验证单 owner、桌面父资源、稳定 operation 对账、事件缺口和单一语音/记忆写入。
两仓独立构建，使用 tarball/wheel 在无相邻源码的 consumer 验收。保留 Phase 4A 冻结边界；真实原神/Broker、多游戏跨机、managed/安装器分别留到 Phase 6/7/8。按可验证切片提交并推送已授权分支，原始报告归 artifact；仅全部 G5.0–G5.5 有证据后宣布 G5 完成；完整 Phase 5 仍需 L5 与 J5。
```

外部条件按 [路线图支持清单](../README.md) 准备；G5 公共包/FakeGame 不要求游戏账号或机器；L5 的真实声音、角色、平台和 Windows/OBS 条件另行到位。未具备的条件保持未运行，不能把条件缺失改写为测试通过。
