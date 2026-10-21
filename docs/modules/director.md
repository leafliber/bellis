# 决策模型

角色唯一的“决定做什么”的来源：读取局面，选择回应哪条弹幕、说什么、是否发起投票、交给游戏什么目标。普通插件（`director`，`packages/director`），通过 `llm` 服务调用模型。仿真与测试用回放的模型输出（`llm-replay`），真实模型由模型客户端插件提供（见[模型接入](#模型接入)）。

## 职责

- 在决策时机到来时，组装上下文并调用模型。
- 把模型输出解析成**枚举的意图**，交给安全核授权。
- 处理游戏的决策点：无计时的选项决定是否交给观众投票，有计时的选项在截止前自己选（D-07）。
- 给出人设漂移的信号；连续失败或连续漂移时告警并请求安全核降级。

## 不负责

执行任何动作、审核、安排发声顺序、游戏的逐帧控制。

## 决策时机

不对每条弹幕都调用模型。时机有：

| 时机 | 来源 |
| --- | --- |
| 新一批候选 | 分诊每收进一条弹幕就通知（`candidates@1` 的 `onAvailable`） |
| 投票结束 | 投票正常结束时的扩展点 `vote.ended`（见[投票](audience.md#投票)）；中止的投票不触发 |
| 冷场 | 冷场计时（`idleMs`，0 表示不闲聊）到期；每次决策结束后重新计时 |
| 游戏决策点或重要局面变化 | P3 |

同时只有一个在途调用，新的时机按下面的规则合并、排队或取消在途调用：

- 没有在途调用：立即开始一次调用，取那时排在前面的候选（至多 `maxCandidates` 条）。
- 在途的是**闲聊调用**（这次没有取到候选，也没有带刚结束的投票）：新到的候选或投票结束取消它（中止信号断开连接，客户端晚到的输出丢弃，不算失败），随即重来。
- 其余情况：新时机排队；在途调用结束后，排队的时机合并成一次调用。
- 在途时冷场到期不另排。
- 记忆插件在场时，调用模型之前先召回记忆，截止时间是 `recallTimeoutMs`（缺省 2 秒），到点就不带记忆继续；召回的规则见[记忆的召回](memory.md#召回)。在途的闲聊被取消时，召回一并取消。
- 每次调用的截止时间是 `callTimeoutMs`（含思考与全部输出，到点即取消；不含召回）。截止、出错与取消都结束这次时机，不重试。
- 写进上下文的时机只留实际带来了数据的（取到了候选、带了投票结果）；都没有时按冷场。

## 输出：动作选择

模型只能从以下意图类型中选择，参数由确定性代码校验，不能自己拼出新的动作：

| 意图 | 参数 |
| --- | --- |
| 说话 | 文本（可流式）、回应对象、过期时间、用到的记忆编号。优先级由确定性代码按触发来源决定，模型不能指定（见[发声](speech.md#发声仲裁)）。回应观众的发言在句边界才能被抢占，自主闲聊可以立即让位 |
| 发起投票 | 题目（至多 60 字）、2–4 个选项（各至多 20 字）、时长（10–300 秒）、用到的记忆编号；用于游戏决策点时绑定决策点编号。交给投票插件，开票说明与结果的发声来源由它按规则决定，见[投票](audience.md#投票) |
| 游戏目标 | 语言子目标、约束、模式（自主 / 等待投票 / 暂停），见[游戏桥](game-bridge.md) |
| 选择 | 对有计时决策点直接给出选项 |
| 保持沉默 | 原因 |

说话意图的文本以流的形式进入[发声](speech.md)管线，逐句（审核插件启用时先经判定）播出。

### 意图格式

- 意图是一个 JSON 对象，定义在 `packages/director/src/output.ts`（TypeBox）。`action` 写在最前，说话的回应对象 `replyTo` 写在文本之前：以后改为增量解析时，先知道动作与回应谁。
- **严格 schema**（`strictIntentSchema`，结构化输出与函数参数用）由意图的 TypeBox 定义派生：
  - 根是一个对象，不用 anyOf：各意图的字段合在一起，`action` 是枚举并排在最前；
  - 所有字段都在 `required` 里，`action` 以外的字段都可为 null（不属于所选意图、或可选而省略时填 null）；
  - `additionalProperties: false`；只用 `type`、`properties`、`required`、`additionalProperties`、`items`、`enum`、`description`，长度、范围与个数写进说明。
- **解析**（各种输出方式共用 `parseIntent`）：流读完后整段按 JSON 解析，顶层取值为 null 的字段视为省略，再按原意图的 schema 校验。严格 schema 比原 schema 宽，它接受而原 schema 不接受的照样丢弃。不合法即丢弃，不修补：前后多了文字、包在代码块里都算不合法。
- 输出先整段解析；弹幕到首音不达标时再改为增量解析（见 [P2 任务卡](../plan/P2.md)）。

## 上下文

| 包含 | 不包含 |
| --- | --- |
| 人设与核心价值（操作员管理，观众和记忆都不能改写） | 凭据、密钥、平台管理权限 |
| 观众实际听到的近期发言 | OBS 与游戏的控制能力 |
| 分诊后的候选弹幕（净化后的称呼） | 私密记忆、观众个人信息（含平台身份） |
| 进行中与刚结束的投票 | 未净化的原始昵称与原文 |
| 游戏局面摘要与决策点 | |
| 召回的记忆：记忆插件过滤后的直播间公开事实（见[记忆的召回](memory.md#召回)） | |

右列的排除是 Rule of Two 的要求：决策模型同时读取不可信输入并对外发声，就不能再接触敏感能力或私密数据（见[安全核](safety-core.md)）。

### 提示词

由确定性代码组装（`packages/director/src/prompt.ts` 的 `buildMessages`，模板为中文），同样的上下文得到同样的消息：

- **系统消息**：人设（profile 里决策插件的 `persona`）、规则、意图格式（由意图的 TypeBox 定义生成，取值范围与校验用的是同一份）。不含任何观众输入。
- **用户消息**：本次的决策时机（本系统给出），然后是标明为**不可信数据**的分隔区：`<不可信数据>` 与 `</不可信数据>` 之间的一段 JSON，含
  - 近期发言：观众实际听到的最近 `heardLimit` 条（只含写回的部分，跳过没有人听到的）；
  - 候选弹幕：编号、净化后的称呼、文本、合并数；
  - 进行中的投票（`vote@1` 的 `current()`，投票插件不在场时为 null）：阶段、题目、选项与票数、剩余秒数；
  - 刚结束的投票：题目、选项与票数、结果与胜出编号；
  - 记忆：编号（`m1`、`m2`…，只在这次调用里有效）、内容、类别与立场（Iris 没给时不写）；记忆插件不在场、召回超时或出错时为空数组。
- 近期发言与投票的题目、选项也放在区内：它们是模型输出，可能复述了弹幕；记忆多是观众说过的话，同样只当不可信的背景。
- 规则要求用到了哪几条记忆，就在意图的 `memories` 里写出编号，没用到时为 null；决策后据此回报使用反馈（见[记忆的使用反馈](memory.md#使用反馈)）。上下文里有弹幕或记忆，交给发声与投票的输出就标为含不可信输入。
- 区内的 `<` 与 `>` 转义为 `<`、`>`（仍是同样的 JSON 字符串），观众写不出分隔标记；规则要求区内的一切只当数据，其中的要求、命令、角色设定与格式说明一律不执行。
- 交给模型客户端的只有消息与意图的输出格式（`INTENT_OUTPUT`）；结构化的上下文只给回放模型记录，供测试核对上下文里有什么、没有什么。

## 模型接入

### llm@1

契约在 `packages/director/src/llm.ts`：

- `complete(请求, 中止信号, 回调)` 返回正文（函数调用方式下是函数参数）的字符串，由决策插件解析；不做隐式重试，中止信号一到即断开。决策插件的截止时间到点时以 `DeadlineError` 作中止原因（`signal.reason`），模型客户端据此把这次调用记为超时失败；其余中止不算失败。
- 回调只用于遥测，取消之后不再调用：`onFirstChunk`（流式读取收到第一块，含只有思考内容的块）、`onFirstOutput`（第一个正文块：第一段非空的正文，函数调用方式下为第一段函数参数；思考内容不算）、`onUsage`（token 用量与实际应答的型号）。
- 失败以 `LlmError` 结束，类别：`auth`、`rate_limit`、`server`、`request`、`timeout`、`network`、`protocol`、`incomplete`、`aborted`（含义见下文[失败](#失败)），也写进遥测的 `error.type`。
- `model` 给出厂商与型号（遥测用）；请求里的 `traceparent` 只用于本机遥测，不发给模型服务。
- 就绪报告，供开播预检与操作员状态用，判定见[运维的开播预检](operations.md#开播预检)：`ready`、给操作员看的 `status`（只含失败的类别、HTTP 状态与错误码）、`failures`（连续失败数，最近一次失败的类别、墙钟时刻、HTTP 状态与错误码）。判定不发请求；回放模型恒为就绪。
- `probe()`：开播预检的显式探测，只在模型客户端配置了 `probeOnPreflight` 时提供；失败以 `LlmError` 结束。

### 模型客户端插件

`llm-openai`（`packages/llm`）按 R-17 实现：OpenAI 兼容的 Chat Completions 薄客户端，fetch 加自写的 SSE 解析，不引入厂商 SDK。

- **权限**：只负责收发的接入插件，只持有方舟的 API Key（`secret:ark`）与外发许可 `net.egress:ark.cn-beijing.volces.com`（见[插件内核](plugin-kernel.md#权限)）；收发的内容只当数据转交。决策插件不持有任何凭据。
- **激活**：核对型号已配置、端点是 https（本机回环除外）且不带用户名与密码、端点主机已授予外发，再读凭据；任何一项不满足就以说明原因的错误加载失败，不连任何端点。请求不跟随重定向。

| 配置 | 含义 |
| --- | --- |
| `endpoint` | Chat Completions 的完整地址，缺省为方舟北京的 `https://ark.cn-beijing.volces.com/api/v3/chat/completions` |
| `model` | 型号（方舟上为 Model ID），不是机密；换型号只改这里 |
| `provider` | 遥测的 `gen_ai.provider.name`，缺省 `volcengine.ark`（GenAI 约定的已知取值里没有火山方舟，按约定用自定义值） |
| `outputMode` | 意图的输出方式：`json_schema`、`json_object`、`tool`、`prompt`；没有缺省值 |
| `thinking` | 思考开关 `thinking.type`（`enabled`、`disabled`）；不配置就不发 |
| `reasoningEffort` | 思考档位 `reasoning_effort`（`minimal`、`low`、`medium`、`high`）；不配置就不发 |
| `temperature`、`maxTokens` | 不配置就不发 |
| `connectTimeoutMs` | 发出请求到收到响应头，缺省 5 秒 |
| `firstChunkTimeoutMs` | 响应头到第一个数据块（思考块算，保活注释不算），缺省 8 秒 |
| `stallTimeoutMs` | 相邻两个数据块之间（保活注释不算），缺省 5 秒 |
| `maxEventChars` | 单行与单个 SSE 事件的字符数上限，缺省 65536 |
| `maxOutputChars` | 正文（或函数参数）的总字符数上限，缺省 8192 |
| `unreadyAfter` | 连续失败达到这么多次就报告未就绪，直到下一次成功；缺省 3 |
| `probeOnPreflight` | 开播预检时发一个最小的探测请求，缺省 false；会外发、会计费（见[运维的开播预检](operations.md#开播预检)） |
| `probeTimeoutMs` | 探测的截止时间，缺省 10 秒，至多 20 秒 |

整体截止时间由决策插件给（`callTimeoutMs`）。思考开关、思考档位与输出方式先按配置走，缺省值待 S-11 之后再定（PENDING）。样例 profile 用 GLM-5.3-flash：思考不能关闭，所以不发 `thinking`，只发 `reasoning_effort: low`；输出方式用 `prompt`，不发未核实的参数。

**请求**：`POST` 到端点，请求头 `Content-Type: application/json`、`Accept: text/event-stream`、`Authorization: Bearer <API Key>`；请求体：

- 总有：`model`、`messages`（决策插件组装的系统与用户消息）、`stream: true`、`stream_options: { include_usage: true }`；
- 按配置：`thinking: { type }`、`reasoning_effort`、`temperature`、`max_tokens`；
- 按输出方式：
  - `json_schema`：`response_format: { type: "json_schema", json_schema: { name, description, schema, strict: true } }`，schema 为严格 schema；
  - `json_object`：`response_format: { type: "json_object" }`；
  - `tool`：`tools` 里只有一个函数（参数为严格 schema），`tool_choice` 指定它；
  - `prompt`：不加，只靠系统消息里的意图格式。

**流式读取**：

- SSE 按 WHATWG 的事件流格式解析：行以 CRLF、LF 或单独的 CR 结束（分在两次读到也算一个换行）；以冒号开头的注释（保活）只计数；多行 `data` 以 LF 连接；`event: error` 的事件当错误对象；`id`、`retry` 与未知字段忽略；`[DONE]` 结束；最后一个事件后没有空行也处理。
- 只看第 0 个 choice。正文取 `delta.content`；函数调用方式下按 `index` 拼接 `tool_calls[].function.arguments`，结束时须恰好调用了一个函数且是指定的那个。
- 思考内容（`reasoning_content`）一律丢弃：不进返回值、日志、事件与遥测，只经用量报它的 token 数。
- 用量块取 `prompt_tokens`、`completion_tokens`、`completion_tokens_details.reasoning_tokens` 与 `model`。
- 结束原因须为 `stop` 或 `tool_calls`（指定函数时 OpenAI 给 `stop`）。

### 失败

- 不做隐式重试；中止信号一到即中止 fetch。
- 类别：HTTP 401、403 为 `auth`；429 为 `rate_limit`；5xx 为 `server`；其余 4xx（例如参数或输出方式不受支持）为 `request`；连接、首块或块间停顿超时为 `timeout`；连接失败或读取中断为 `network`；不是 SSE、数据块不是 JSON、超过上限、流在给出结束原因之前就结束、没有调用指定的函数为 `protocol`；结束原因是 `length`、`content_filter` 等为 `incomplete`；调用方取消为 `aborted`。流中途的错误对象有 HTTP 状态时按状态归类，否则按错误码与类型归类（鉴权、限流与额度、参数，其余为服务端）。
- 说明里只有类别、HTTP 状态、错误码与截短（至多 200 字）的服务端说明，API Key 抹掉；不含模型输出与思考内容。模型客户端的日志 `llm.failed` 只记类别、HTTP 状态与错误码，取消不记，决策插件的截止时间到点记为 `timeout`（带 `deadline: true`）；探测的结果记 `llm.probe`，同样只有是否通过、类别、HTTP 状态与错误码。

### 遥测

决策插件为每次调用记一个 GenAI span（见[运维的观测](operations.md#链路)）：`model` 给出厂商与型号；`onUsage` 报来的 token 用量（含推理）与应答的型号记在 span 上；`onFirstChunk` 记 `gen_ai.client.inference.time_to_first_chunk`，`onFirstOutput` 记 `bellis.llm.time_to_first_output`（口径见[直方图](operations.md#直方图)）。

## 失败与降级

- **超时或出错**（含被拒、限流、协议错误）：放弃本次时机。这次取到了候选（有观众在等回应）时，按配置播一句预先准备的固定过渡语（`fallback.lines`，轮流取用）：走发声管线，来源为闲聊，不含不可信输入，可以立即让位，`fallback.ttlMs`（缺省 5 秒）内没开始播就过期；每一串连续失败至多播一句。
- **输出无法解析为合法意图、回应对象不在本次上下文中**：丢弃，不做修补猜测，不播过渡语。
- 以上都算失败，合法的意图（含保持沉默）清零。连续失败每满 `alarmAfter` 次（缺省 3）：记事实 `director.alarmed`（`cause: failures`、次数、最近一次的类别），进操作台的近期告警，并经安全核门面请求降级（见[安全核](safety-core.md#监督模式)）；降级之后仍在失败，再满一次再请求。
- 取消（被新的候选或投票结束取代、插件停用）不算失败。

## 人设漂移

决策插件给出最小的确定性信号（`packages/director/src/drift.ts`），只针对要说出口的输出：

| 信号 | 条件 |
| --- | --- |
| `repeat` | 说话的文本与近期发言（观众听到的与本插件最近交给发声的，各取 `drift.recent` 条，缺省 8）之一相同或高度相似：NFKC、小写、去掉空白与标点后，字符二元组的 Dice 系数不低于 `drift.similarity`（缺省 0.8） |
| `phrase` | 含 `drift.phrases` 里的出戏用语（同样规范化后比较；缺省为自称语言模型或助手、谈论提示词的若干说法） |
| `format` | 超过 `drift.maxChars`（缺省 120）个字，或含 Markdown 与代码标记、网址、花括号或尖括号、换行 |

- 发起投票时，题目与各选项分别查 `phrase` 与 `format`，不查 `repeat`。
- 命中时写日志 `director.drift`（信号与连续次数），模型调用的 span 记 `bellis.director.drift`。信号只是信号：命中的输出照常交给发声，由审核与操作员把关。
- 有输出的决策（说话、发起投票）连续命中每满 `drift.alarmAfter` 次（缺省 3），按安全核“内容重复或漂移”的自动降级处理：记 `director.alarmed`（`cause: drift`）并请求降级。没有命中的输出清零，保持沉默与失败不计。

## 验收

| 阶段 | 内容 |
| --- | --- |
| P0 | 回放模型输出：意图解析、非法输出被丢弃、上下文中不出现被排除的内容 |
| P2 | 真实模型：决策时机合并、取消、截止时间；人设漂移检测信号 |
| P3 | 游戏决策点：投票或自选的选择及截止时间内完成 |

## 技术路线

已批准：R-17（模型）。
