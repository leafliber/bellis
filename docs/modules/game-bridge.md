# 游戏桥

Bellis 经普通插件 `game@1` 与独立的 Game Runtime 交换语言目标、选择、输入许可和局面事实。Game Runtime 负责逐帧控制（D-04、D-27）。这份契约供各适配游戏共用。

## 职责

- 维护与 Game Runtime 的连接、认证与心跳。
- 把决策模型的游戏目标转为命令，并持有和续约游戏输入许可。
- 把 Game Runtime 的事件转为 Bellis 的事实，供决策与解说使用。

## 不负责

画面采集、OCR 与 VLM 感知、VLA 策略、按键时序。这些在 [bellis-game-runtime](https://github.com/leafliber/bellis-game-runtime) 中实现，各自是可独立开关的插件（D-08）。

## 连接

Bellis 宿主在本机通道上接受以下两个角色，每种同时只有一个连接。双方先完成 R-05 的双向认证。Game Runtime 从 Windows 凭据管理器的 `bellis` 服务、`session` 条目读取启动器写入的 `SessionInfo`（R-23）。

| 角色 | 对端 | 承载 |
| --- | --- | --- |
| `game-runtime.main` | Game Runtime 主进程 | 语义握手、目标、决定、暂缓推进、局面、决策点、已发生的动作与语义健康 |
| `game-runtime.core` | Game Runtime 实时核 | 控制握手、许可续约、停止、输入释放与实时核健康 |

每条连接的首个应用请求是 Bellis 发出的 `game.describe`，带契约主版本 `major`。两边应答各自的 `major`、运行会话号 `runtimeId` 和当前单调时刻 `nowMs`。主进程还返回适配包 `adapter`（`id`、`version`、`screenTypes`）和操作员前置条件 `prerequisites`（`id`、`text`、`confirmed`）。`runtimeId` 由 Runtime 每次启动新建，实时核重启仍属于同一次 Runtime 会话。两条连接的 `runtimeId` 必须相同。

收到和请求编号匹配的 `game.describe` 应答后，先用开放的 `GameDescribeVersion` 读取公共的 `major`。Bellis 使用 `readGameBridgeMajor`，Python 使用生成模块的 `read_game_bridge_major`。主版本与 `GAME_BRIDGE_MAJOR` 相同才对所用角色的正文做闭合校验。后续主版本可以更换正文结构，仍用同一 JSON-RPC 信封和公共 `major` 字段表示版本。

游戏桥的 WAITING 状态包含原因。主版本不兼容时报告本端支持与对端上报的版本。握手不合法、两条连接不齐、会话号不一致或适配包不匹配 profile 时停在 WAITING。进入真实输出模式前还须确认两条连接的健康未过期、适配包声明的前置条件全部已确认且游戏目标未被隔离。健康上报的条件编号与文本须和握手一致，确认状态以当前会话为准。连接断开、健康失效或确认撤回时停止下发目标、决定和许可。控制连接失去后实时核自行释放输入。实时核重连后重新握手，满足运行条件后从更大的令牌开始。

## 宿主服务与配置

在 profile 启用普通插件 `game-bridge` 时，指定 `adapterId`、`adapterVersion` 并授予 `game.goal` 与 `game.input`。示例条目默认禁用。`healthTimeoutMs` 是两条连接的健康时限，缺省 2000 ms。宿主把已认证的连接交给插件实例。实例在卸载时归还输入许可，等待仍在线的实时核核验释放，然后关闭两条连接并撤销注册。核验超时按插件静止中规则强制清理。

- `game@1` 的 `status()` 提供连接、握手后匹配的会话、最近健康、决策点及输入许可状态。`wireNowMs()` 返回契约所用的单调毫秒。`subscribe()` 和观察扩展点 `game.fact-observed` 都只分发写入状态存储成功的事实。事实带角色和 Runtime 会话，旧连接的回调作废。
- `submitGoal()` 与 `resolveDecision()` 在有效且已确认的输入许可下，经 `game.goal` 闸门执行。已经尝试发送的请求遇到断线、超时或无效回执时，按[状态存储的未知结果规则](state-store.md#副作用流程)隔离游戏目标。用现有 `pnpm operator resolve` 结案。
- 接管和交还控制走宿主内部的操作员入口。失焦、接管、注入被阻止或本地急停进入人工锁存。当前令牌的释放报告有残留或未经核验时同样撤销许可并进入人工锁存。健康恢复或重连后仍等待操作员交还。模拟端口可在 M0 验证许可，同机真实端口要求真实输出模式。

## 契约

主版本为 **1**。源是 [TypeBox 定义](../../packages/protocol/src/game-bridge.ts)，由 `pnpm run gen` 生成 [JSON Schema](../../packages/protocol/schemas/game-bridge.schema.json) 和独立的 [Pydantic 模型](../../packages/protocol/models/game_bridge.py)。Game Runtime 锁定同一提交的生成物和[控制连接夹具](../../packages/protocol/test/fixtures/game-control.json)，核对 Rust 解码与编码（GD-03）。Schema 的 `x-methods` 按角色列出 `sender` 和载荷在 `$defs` 下的名字。`result: null` 表示通知。追加可选字段后，双方更新所锁定的定义再发送新字段。删除、重命名和变更既有字段含义须升主版本。

应用消息走 JSON-RPC 2.0，参数都是对象。严格核对角色、方向、请求或通知类型及载荷，未知字段一律拒绝。当前版本的可空字段显式写 `null`。请求成功以 `{}` 应答，握手应答为描述对象。语义动作及相关事件用 R-21 的 `traceparent` 串起链路，无追踪上下文时值为 `null`。

### 时间与标识

- v1 的整数在线上用十进制 JSON 整数字面量。零写成 `0`，非零整数可带负号，数值须在 JS 安全整数和各字段的范围内。拒绝小数点、指数、`-0`、布尔和数字字符串。风险分是普通 JSON 数值，保留小数和指数写法。Node 在认证后的游戏连接解码原始帧时核对数字写法，随后按 Schema 核对字段类型和范围。Python 对原始游戏帧统一调用生成模块的 `parse_game_bridge_json(raw)`，再用相应 Pydantic 模型的 `model_validate` 校验信封与载荷。解码器核对公共信封的整数字段，错误详情仍为任意 JSON，未知版本的正文交给版本握手处理。Rust 保留原解析结果的数字类型再做严格校验。
- `atMs`、`nowMs`、`expiresAtMs`、`resolveByMs` 和 `deadlineMs` 是同机系统单调时钟的整毫秒。在 Windows 用 QPC，在 Linux 用 `CLOCK_MONOTONIC`。Bellis 以 `process.hrtime.bigint()` 读该时钟，将进程内截止时间换到这个时钟域并向下取整。Runtime 按帧环同一时钟核对。到期时间从发送方设置的绝对截止计算，传输延迟会消耗预算。时刻范围为 `0..18446744073709`，换算为纳秒时仍在 Rust `u64` 范围内。帧龄和首动作耗时用非负整数毫秒表示。
- Bellis 的 `goalId`、`holdId` 以及 Runtime 的 `decisionPointId`、`actionId` 在各自的命名空间和同一 `runtimeId` 下唯一。重新进入同一画面产生新的决策点实例。一次决策点的 `optionId` 在打开到结束期间稳定。标识连同 `runtimeId` 用于去重和关联。旧会话或旧连接的回执丢弃。同一会话中的动作按编号记一次事实，迟到回执不得重新打开决策点。
- 许可令牌在同一安全核的资源计数器内递增，范围为 `1..9007199254740991`。停止指令的 `throughToken` 可为 0，表示尚未发过许可。

### 语义消息

| 方向 | 消息 | 含义 |
| --- | --- | --- |
| Bellis → Runtime | `goal.submit` | 语言子目标、约束、模式、到期时刻。模式为 `waiting_vote` 时绑定当前 `decisionPointId`。进入人工模式按操作员控制路径处理 |
| Bellis → Runtime | `decision.resolve` | 递交指定决策实例的选项。来源为模型自选 `director` 或唯一胜出的 `vote` |
| Bellis → Runtime | `pacing.hold`、`pacing.release` | 以 `holdId` 暂缓或解除一段推进 |
| Runtime → Bellis | `situation.observed` | 有界局面摘要、通用画面类型、可交互项、看点、配音忙闲、重读与失败信息。可附当前一句。约 1–2Hz，在变化时报告 |
| Runtime → Bellis | `decision_point.opened` | 实例号、选项、按排名递增的候选、可空的计时字段 |
| Runtime → Bellis | `action.committed` | 已确认发生的动作及其唯一编号，带相关目标编号。选择类动作须附决策点、选项与实际决定来源，含 `default` |
| Runtime → Bellis | `health.reported` | 就绪、模式、当前目标与打开的决策点、前置条件、帧龄、队列、首动作耗时、风险分及最近拒绝摘要 |

通用画面类型直接使用 Runtime [画面状态](https://github.com/leafliber/bellis-game-runtime/blob/main/docs/modules/perception.md#画面状态) 的标识。扩展画面类型依适配包声明的 `name`、`base` 映射。观测中的 `screenType` 仍为通用类型，`screenTypeExtension` 为扩展名或 `null`，使用扩展时须与握手中的声明一致。卡住与未知由运行时报告。局面、候选、看点和拒绝原因中的文本按不可信游戏输入处理。剧情日志、图像、潜向量和输入坐标留在 Runtime。写入 Iris 的游戏事实只用摘要。

### 控制消息

| 方向 | 消息 | 含义 |
| --- | --- | --- |
| Bellis → 实时核 | `lease.renew` | 授予新令牌或续约当前有效令牌，含到期时间。拒绝失效许可时返回 `-32004` |
| Bellis → 实时核 | `input.stop` | 撤销 `throughToken` 及更早令牌，完成相关输入的释放尝试后应答。对同一令牌重复请求安全 |
| 实时核 → Bellis | `input.released` | 释放时刻、相关令牌、触发原因、核验状态。仅 `verified` 计为确认无残留。回应 `input.stop` 的核验用其 `throughToken` 关联，即使此前已经释放也报告 |
| 实时核 → Bellis | `health.reported` | 许可状态、帧龄与队列深度 |

夹具是 JSON 数组。每项包含 `name`、`sender`、`valid`，以及 `message` 或 `rawJson`。`message` 是完整 JSON-RPC 对象，`rawJson` 是须原样送入解码器的 JSON 文本。`responseTo` 只用于成功应答样本，指出应答所关联的请求方法。有效样本须按控制角色从 JSON 解码并编码回等价 JSON，无效样本须拒绝。时效、授权和游戏状态另由两端核对。

## 决策点与恢复

- 无计时选项的 `timing` 为 `null`。决策模型选择直接自选或交给观众投票。投票和选项映射冻结于当前决策实例，平票或无有效票时由模型自选（D-07）。
- 有计时的选项须提供至少一个候选，且打开时刻早于 `resolveByMs`，余量线早于 `deadlineMs`。模型自选，有计时的调用优先，可取消尚未开口的在途调用。提示只带候选、局面摘要和截止时间，跳过记忆召回。调用截止取余量线与 `callTimeoutMs` 中较早者。到余量线时还未收到有效决定，Runtime 执行排名第一的候选并上报实际动作（D-07）。
- 目标和决定经[执行闸门](safety-core.md#执行闸门)授权后发送。Runtime 每次核对当前实例、选项和截止时间，一个决策点至多执行一次。成功应答表示命令已接纳。解说与执行事实以 `action.committed` 为准。已提交动作按动作编号去重，点已撤回时以当前决策点状态收尾。
- 坏结局与卡住时 Runtime 停止推进，报告失败来源和已试过的候选。Bellis 可解说并给出新的继续目标，重读时跟踪已试结果。重复结果、迟到决定与接收方执行状态未知的 RPC 都不得触发自动重发。宿主重启后按[状态存储的重启规则](state-store.md#重启)隔离未知游戏意图，恢复由操作员结案并授权。

## 看点与暂缓推进

普通局面只更新上下文。看点用 `id` 去重，以 `atMs` 判新鲜程度，决策插件按配置限频。发声仲裁在游戏解说实际播出前发出带绝对到期时间的 `pacing.hold`，在播完、取消或放弃时解除，也可按配置等游戏配音结束。两个信号只记事实（R-29）。Runtime 在有效 hold 期间暂停推进和导航，计时与选择照常，最晚到期或触达 Runtime 的最长暂缓时限时自动恢复。恢复推进仍须具备有效输入许可。

## 安全

- 游戏输入许可与 Stage 音频输出许可是两份独立的执行许可，急停时一起吊销。
- 游戏桥在真实输出就绪且控制连接有效时向安全核申请许可，按 D-34 的初值约 500 ms 有效、每 250 ms 内续约。令牌只发给实时核。宿主急停先吊销许可，再通过控制连接以已发送的最高令牌发 `input.stop`。等待核验的范围由该令牌和当前控制连接确定。安全停止、维护、人工接管和重启后的恢复前都禁止授予游戏输入许可。
- Game Runtime 的输入代理是受信组件：键位白名单、速率与长按上限、前台窗口校验；急停时主动发出全部按键抬起并核验，而不只是停止发送（SendInput 不会自动重置键盘状态）。
- Game Runtime 在游戏需要时以管理员权限运行，由其自身方式启动，从 SecretStore 读取本次会话的连接信息（R-23）；Bellis 宿主始终不提权，并作为本机通道的服务端（见 [Windows 平台](../platform/windows.md)）。
- 真人接管、本地急停热键或风险分超阈值时，Game Runtime 释放输入并上报。Bellis 撤销许可并通知操作员，只有操作员可以交还控制。

## 验收

| 阶段 | 内容 |
| --- | --- |
| P3 | 与 Game Runtime 联调《魔女审判》：决策点、投票或自选、计时截止、许可过期即释放、急停后全部输入释放的时延 |
| 原神阶段 | 按探索与剧情 → 解谜 → 战斗分步扩展契约与验收 |

## 技术路线

已批准 D-04、D-07、D-08、D-27、D-31、D-34、R-23、R-28、R-29。Game Runtime 侧的路线在其仓库审核。
