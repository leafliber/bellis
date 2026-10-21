# 运维：操作台、观测与评测

操作员如何监督直播，系统如何被观测、测试和评估。操作台由宿主内置，与命令行同为操作员入口；遥测是普通插件；确定性仿真贯穿各阶段。

## 操作台

操作员有两个入口：命令行 `pnpm operator` 与本机网页操作台（R-20）。两者都由宿主装配，不是插件：不经插件加载器、不能热替换，插件出问题时照样可用。两者调用宿主里同一套操作员动作，参数用同一份 Schema 校验，行为与记录一致。急停不只依赖操作台：另有 OBS 热键（R-27，见[安全核](safety-core.md#执行许可与急停)）与外部看门狗。

命令行以 `operator` 角色经本机通道连接宿主：

| 命令 | 作用 |
| --- | --- |
| `status` | 当前模式、在场确认是否有效与剩余时间、维护态、审核开关、呈现延迟、M1 的放行方式与等待中的句子（等待方式、已等多久）、进行中的投票（题目、开票说明播报中或倒计时剩余、各项票数、是否在缺口中）、弹幕接入的状态（`danmaku`：就绪与否、状态说明、当前缺口的原因、开始时刻与已持续多久）、决策模型的状态（`llm`：就绪与否、状态说明、连续失败数、最近一次失败的类别与时间），两者判定见[开播预检](#开播预检)，profile 中没有启用时为 null；记忆的状态（`memory`：就绪与否、状态说明、待发队列、累计写入与丢弃的条数、墓碑数，见[记忆的就绪](memory.md#就绪与开播预检)），profile 中没有启用记忆时为 null；决策插件此刻用的人设的来源与版本（`persona`：`iris` 与版本号，或 `profile`，不含正文，见[决策模型的人设](director.md#人设)），profile 中没有启用决策插件时为 null；最近一次开播预检的结果、插件状态与 WAITING 原因 |
| `mode 目标` | 切换监督模式。升级只能由操作员显式执行；降级也可由安全核自动触发 |
| `presence` | 确认在场（M2 的前提） |
| `estop [原因]` | 急停。参数不合法时照样急停，用缺省原因“操作员急停” |
| `veto [句键]`、`release [句键]` | M1 中否决或放行等待中的句子，不给句键时针对全部（见[发声仲裁](speech.md#发声仲裁)） |
| `preflight [M1\|M2\|M3]` | 只跑开播预检，不切换模式（见下文[开播预检](#开播预检)） |
| `forget 平台ID` | 登记观众删除请求的本地墓碑（B 站为 `open_id`，见[记忆的删除](memory.md#删除)）；操作台暂不提供 |
| `console` | 用浏览器打开操作台 |

其余参数不合法时拒绝（命令行回 `参数不合法`，操作台回 400）。

操作台是宿主在 `127.0.0.1` 上另开的随机端口（`node:http`），与 Stage 不同源；宿主启动时开启（在加载插件之前），停止时关闭。页面写法与 Stage 相同（带 JSDoc 的 JS，单独的 tsconfig 以 `checkJs` 检查，不用前端框架），宿主按原样提供，不从外部加载任何东西，页面本身不含数据。

- **登录**：`pnpm operator console` 经本机通道向宿主要一次性登录令牌（256 位随机，只存在宿主内存里，60 秒内有效，只能用一次），用系统自带的方式打开 `地址#令牌`，不经 shell：Windows 用 `rundll32 url.dll,FileProtocolHandler`（成功时退出码为 0；`explorer.exe` 成功时也返回 1，判断不了成败），macOS 用 `open`，其余用 `xdg-open`。令牌放在 URL 片段里，不随请求发出、不进 Referer。打不开浏览器时把带令牌的地址打印出来，并提示它只能用一次、很快过期。页面读出令牌后立即用 `history.replaceState` 抹掉，以 `POST /api/login` 换取会话。
- **会话**：会话 ID 256 位随机，cookie 为 `HttpOnly; SameSite=Strict; Path=/`。登录的返回体带会话绑定的 CSRF 令牌，页面只放在内存里；刷新页面后用 `GET /api/session` 凭 cookie 取回。会话的绝对有效期 12 小时，同时至多 4 个（超出时作废最早的），`POST /api/logout` 注销；宿主重启后全部作废。登录令牌、会话 ID 与 CSRF 令牌都用定长时间比较。
- **请求核对**：
  - 每个请求的 `Host` 都要严格等于 `127.0.0.1:端口`（防 DNS 重绑定），不接受 `localhost` 等别名；带了 `Origin` 的必须同源（`http://127.0.0.1:端口`），带了 `Sec-Fetch-Site` 的必须是 `same-origin`。
  - 页面文档只在顶层导航时可以不带 `Origin`：`Sec-Fetch-Mode` 为 `navigate`、`Sec-Fetch-Dest` 为 `document`，`Sec-Fetch-Site` 为 `none`（命令行打开）或 `same-origin`（刷新）。脚本与样式表要带同源的 `Origin`（样式表的 `<link>` 因此加 `crossorigin`）。这些都不需要会话。
  - `/api/*` 都要会话 cookie。写请求（POST）还要同源的 `Origin`、`Content-Type: application/json` 与请求头 `X-Bellis-CSRF`：cookie 不按端口隔离，同一台机器上其它端口的页面算同站。登录只要同源的 `Origin` 与 JSON。
  - 任何一项不符一律拒绝，响应体为空，原因只写宿主日志（`console.refused`）。
- **响应头**：CSP 为 `default-src 'none'`，脚本、样式、连接只许 `'self'`，`frame-ancestors 'none'`、`base-uri 'none'`、`form-action 'none'`；另有 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`。
- **接口**：`GET /api/status` 与 `pnpm operator status` 的内容相同，另加近期告警；`POST /api/mode`、`/api/presence`、`/api/emergency-stop`、`/api/veto`、`/api/release`、`/api/preflight` 与命令行的同名命令调同一个动作；`POST /api/login`、`GET /api/session`、`POST /api/logout` 管理会话。
- **近期告警**：宿主订阅状态存储，环形保存最近 50 条重要事实：模式变化与拒绝、急停请求与完成、OBS 外部变化、看门狗动作、否决与等待放行超时、审核开关变化、TTS 换引擎与降级、弹幕缺口、投票中止、决策模型的告警（连续失败或连续漂移，已请求降级）、登记了墓碑（不写平台身份）。宿主重启后从空开始。
- **页面**：每秒轮询状态，显示人设的来源与版本；连不上宿主或会话失效时醒目提示，并把状态清成未知，不把过期的数据当作当前状态。顶部常显审核状态：审核插件关闭时为“审核已关闭”，未显式设置时为“审核状态未设置”。来自宿主的文本（句子可能受弹幕影响）只用 `textContent` 渲染。
- **操作**：急停（一键，不二次确认）；确认在场（页面在线不算在场，必须操作员主动点）；切换监督模式（升级到 M1–M3 要再点一次确认）；只跑开播预检；M1 中逐句放行、否决与全部否决；注销。

尚未提供（unsupported）：开播与下播、进入或退出维护态、查看结果未知的意图。

## 开播预检

开播前逐项确认，任一失败则不允许进入真实输出。操作员切到 M1–M3 时，先由安全核核对模式本身的前置条件（见[安全核](safety-core.md#监督模式)），满足后宿主再跑以下各项，未通过的项随拒绝一起返回并记入事件。`pnpm operator preflight` 与操作台的“只跑开播预检”只跑预检、不切换：先由安全核核对目标模式的前置条件（已处于该模式不算未满足），未满足就把原因列为第一项，再跑以下各项。最近一次预检（含切换前跑的）的结果显示在 `status` 与操作台上。预检可能含决策模型的探测，命令行与操作台等切换模式与只跑预检的应答至多 30 秒，其余请求照旧（命令行 5 秒，操作台 3 秒）。

- 监督模式有效，M2 下在场确认未过期；
- 安全场景、Stage 静音目标存在，看门狗连接正常；Stage 浏览器源的设置符合 [Stage](stage.md#obs-配置要求) 的要求，安全场景里不含 Stage 源；Stage 源没有被静音，节目场景不是安全场景（以上经 OBS 应急连接只读核对）。急停之后由操作员先取消静音、切回直播场景，再进入输出模式，Bellis 不自动切回；
- Stage 已认证，AI 标识可见；
- 审核插件的状态已确认（启用且审核模型可用，或已显式关闭）；
- TTS、形象、弹幕接入、决策模型、Iris、Game Runtime 按 profile 就绪（profile 中启用的插件全部激活）；Iris 能以宿主令牌访问且外发配置已核对；TTS 路由配置中第一个音频引擎（只出字幕不算）就绪，例如本地模型已加载完成；本地 TTS 作主引擎时，它的 sidecar 读回为 HighQoS（见 [Windows 平台](../platform/windows.md#定时与调度)）；形象还要求已连上 VTube Studio 并认证、嘴型参数没有被其他插件占用；M1 还要求逐句放行环节在场；
- 弹幕接入、决策模型与 Iris 按下文就绪；
- 合规清单中试播门禁项已满足（见[合规](../compliance.md)）。

**弹幕接入**：profile 中启用了提供 `danmaku@1` 的插件（B 站接入或回放）时核对，没有启用就不核对。接入插件报告此刻是否就绪与状态说明（`danmaku@1` 的 `ready`、`status`）：

- B 站接入（`danmaku-bilibili`）在场次已开启、长连接已认证、正在接收时就绪；否则状态说明给出开启中、连接中，或在等什么、原因（例如 7002 的等待、IP 白名单等鉴权或配置问题、长连接断开）与约多久后重试。
- 回放（`danmaku-replay`）恒为就绪。
- 不在场（例如激活失败）、未就绪、或不报告就绪的来源都算未通过：`弹幕接入未就绪：<状态说明>`，在缺口中时加上 `；缺口已持续 <时长>`（缺口的开始时刻随 `gap()` 给出，见[观众接入](audience.md#b-站直播开放平台)）。

**决策模型**：profile 中启用了决策插件时核对，`llm@1` 必须在场且就绪；没有启用决策插件就不核对。缺省不为它向厂商发请求（不外发、不计费），只看模型客户端报告的就绪（`llm@1` 的 `ready`、`status`、`failures`）：

- 模型客户端（`llm-openai`）：配置齐全、凭据已读到（激活时已核对，否则插件加载失败、`llm@1` 不在场），且最近的调用没有处在连续失败中：还没调用过、或连续失败少于 `unreadyAfter` 次（缺省 3，与决策插件的 `alarmAfter` 缺省相同）就绪。鉴权失败（`auth`）一出现就未就绪，直到下一次成功。调用方取消不算失败，决策插件的截止时间（`callTimeoutMs`）到点算超时。
- 回放模型（`llm-replay`）恒为就绪。
- 不在场、未就绪或不报告就绪的都算未通过：`决策模型未就绪：<状态说明>`。说明只含最近一次失败的类别、HTTP 状态与错误码，不含服务端的说明。

**Iris**：profile 中启用了提供 `memory@1` 的插件（记忆插件）时核对，没有启用就不核对。

- Iris 外发配置已核对：维护者核对后在 profile 里把 Iris 客户端的 `egressReviewed` 设为 true（确认的是什么见[记忆的 Iris 客户端](memory.md#iris-客户端)）。不是 true 时 Iris 客户端不激活、不发任何请求，`memory@1` 随之不在场。
- `memory@1` 须在场：不在场时为 `记忆未就绪：memory@1 不在场（Iris 客户端或记忆插件没有激活，原因见插件状态）`，激活失败的原因在插件状态一项里。
- 能以宿主令牌访问 Iris：每次预检发一个 `GET /status`（本机回环，截止 5 秒），服务为 `ready` 才通过；未通过时为 `Iris 不能以宿主令牌访问（<类别>，HTTP <状态>，<错误码>）`，或服务状态不是 ready 时的说明。
- Iris 有当前人设：能访问时再取一次人设（只取人设、不取记忆的召回准备，见[记忆的人设](memory.md#人设)），正文非空才通过；没有时为 `Iris 没有当前人设`，请求出错时括号里带类别、HTTP 状态与错误码。新部署的直播间入口还不存在时，记忆插件先建立入口再取（见[记忆的入口的建立](memory.md#入口的建立)）。启用记忆时人设来自 Iris（见[决策模型的人设](director.md#人设)），没有就不能开播。
- 不发写入，也不取记忆。

**显式探测**：模型客户端配置 `probeOnPreflight: true`（缺省 false）时，这一项改为每次预检发一个最小的请求：固定的极短提示词（只要求输出 `{"ok":true}`，不含人设、上下文与观众输入），按配置的型号、思考档位与输出方式，截止时间 `probeTimeoutMs`（缺省 10 秒，至多 20 秒）。应答正常结束、正文是一个 JSON 对象才通过；结果计入上面的就绪判定（成功清掉之前的失败）。未通过时为 `决策模型的探测请求失败（<类别>，HTTP <状态>，<错误码>）`。**探测会外发到模型服务、按调用计费**，切到 M1–M3 前与每次只跑预检各发一次；不打开就不发。

## 真实配置的样例

`config/live.example.json` 与 `config/profiles/live.example.json` 只含脱敏占位值；维护者复制成 `config/live.json` 与 `config/profiles/live.json`（不入库），填值、录凭据后用 `pnpm start config/live.json` 运行。profile 样例的插件包：

| 包 | 条目 | 缺省 |
| --- | --- | --- |
| `telemetry` | `telemetry` | 启用（见[遥测服务](#遥测服务)） |
| `obs`、`stage`、`avatar` | `obs`、`stage-page`、`stage`、`stage-sync`、`avatar` | 启用 |
| `moderation` | `moderation` | 显式关闭（R-12 暂缓，见[审核插件](moderation.md)） |
| `speech` | `speech`（发声仲裁）、`review`、`tts`、`tts-local`、`tts-cloud` | 启用；`tts-cloud` 禁用，两家都不外发 |
| `interaction` | `danmaku`、`triage`、`vote`、`llm`、`director` | 整体禁用 |
| `memory` | `iris`（Iris 客户端）、`memory`（记忆插件） | 整体禁用 |

- **互动包缺省禁用**：复制样例后还没填项目 ID、录凭据时，弹幕接入与模型客户端会加载失败，开播预检一直不通过；它们还要外发到 B 站与方舟（方舟按调用计费），须维护者先同意。禁用时媒体部分照常可用，预检也不核对这两项。
- **整体启用**：在 `config/live.json` 的 `patches` 里写 `"patches/interaction.json"`（仓库自带，按配置文件所在目录解析，只把互动包的五个条目设为启用）；去掉就整体关闭。`pnpm run profile config/profiles/live.json config/patches/interaction.json` 打印实际生效的条目。维护者自己写的 patch 也放在 `config/patches/` 下，不入库。
- **记忆包缺省禁用**：要维护者先部署 Iris、创建宿主令牌、核对 Iris 的外发配置。整体启用写 `"patches/memory.json"`（仓库自带，只把 `iris`、`memory` 设为启用），可与互动包一起用；只启用记忆包时照样写入角色的发言，没有弹幕接入就不写弹幕，没有决策插件就没有召回。

**从 P1 时复制的 `live.json` 升级**：

1. profile 的 `speech` 包加上发声仲裁：`{"id": "speech", "plugin": "speech-arbiter", "grant": ["speech.output"]}`。投票与决策都依赖它提供的 `speech@1`。
2. 没有 `telemetry` 包的，从样例复制。
3. 从样例整段复制 `interaction` 包（已有旧的弹幕、决策条目的，换成样例的写法），填：
   - `danmaku` 的 `config.appId`：直播开放平台的项目 ID。样例的 0 表示未配置，插件以“未配置项目 ID（appId）”加载失败、不连任何端点；
   - `director` 的 `config.persona`：样例是测试人设；启用记忆后人设来自 Iris，这一份只在没有启用记忆、或还没拿到过 Iris 的人设时用（见[决策模型的人设](director.md#人设)）；`fallback.lines` 按需改；
   - `llm` 的 `config`：型号不是机密，换型号只改 `model`（见[决策模型](director.md#模型客户端插件)）；`probeOnPreflight` 见上文。
4. 录凭据（`pnpm secret set 名字`，值不回显，见 [Windows 平台](../platform/windows.md#凭据)）：`bilibili`（JSON `{"accessKeyId": "…", "accessKeySecret": "…"}`）、`bilibili-code`（主播身份码）、`ark`（方舟的 API Key）。
5. 在 `config/live.json` 的 `patches` 加上 `"patches/interaction.json"`，跑 `pnpm operator preflight` 看弹幕接入与决策模型两项。
6. 记忆（Iris 部署好之后）：
   - 从样例整段复制 `memory` 包，填 `memory` 的 `config.entryId`（Iris 的入口 ID，例如 `bellis:bilibili:<房间号>`；样例的空串表示未配置，插件以“未配置入口 ID（entryId）”加载失败）与 `selfName`（角色名）；
   - `iris` 的 `config.baseUrl` 是 Iris 的地址，缺省 `http://127.0.0.1:8080`，端口按容器的映射改；地址的主机须在 `grant` 里有对应的 `net.egress:<主机>`（样例授予 `127.0.0.1`）；
   - 核对 Iris 的外发配置后，把 `iris` 的 `config.egressReviewed` 改为 true（确认的是什么见[记忆的 Iris 客户端](memory.md#iris-客户端)）；
   - 在 Iris 管理端设好角色名与背景作为人设初版，人设的候选保持“全部人工确认”；直播间入口不用事先建立，记忆插件激活时自己建立（见[记忆的入口的建立](memory.md#入口的建立)）；
   - 录凭据 `iris`（Iris 管理端创建的宿主令牌，范围包含上面的入口 ID）；
   - 在 `patches` 加上 `"patches/memory.json"`，跑 `pnpm operator preflight` 看 Iris 一项。

互动包里的先后关系由各插件的清单决定，依赖不全的条目停在 WAITING，开播预检随之不通过：

- 分诊（`audience-triage`）依赖弹幕接入（`danmaku@1`）；
- 投票（`audience-vote`）依赖弹幕接入与发声仲裁（`speech@1`），授予 `vote.start`；
- 决策（`director`）依赖分诊（`candidates@1`）、模型客户端（`llm@1`）与发声仲裁；投票是它的可选依赖；
- 弹幕接入（`danmaku-bilibili`）与模型客户端（`llm-openai`）只依赖宿主的核心服务，各自只持自己的凭据与外发许可；分诊、投票、决策不持凭据（见[插件内核](plugin-kernel.md#权限)）。
- 记忆插件（`memory`）依赖 Iris 客户端（`iris@1`），授予 `memory.write`，不持凭据；弹幕接入是它的可选依赖，它是决策插件的可选依赖。Iris 客户端（`iris-client`）只持 `secret:iris` 与 `net.egress:127.0.0.1`。

## 观测

**事件日志是事实来源**，遥测是可以丢失的派生数据：span 与直方图写进单独的 JSONL 文件，不进事件库，写不进就丢，不阻塞直播。按 R-21 自写最小实现，不引入 OpenTelemetry SDK；需要可视化时由进程外的 OTel Collector 导入。

### 遥测服务

- 遥测是普通插件，提供 `telemetry@1`（`packages/telemetry`）：
  - `telemetry`：写 JSONL 文件，并按 `eventLoopIntervalMs` 采样宿主的事件循环延迟；
  - `telemetry-memory`：写内存，另提供 `telemetry.memory@1` 读出写出的行，供确定性仿真与测试用；缺省在本轮同步代码结束后就写，不设定时器，不改变仿真里定时器的交错。
- 其它插件以可选依赖使用：inject 写 `telemetry@1?`，代码里用 `useTracer(ctx, 插件 id)`。每次调用时现查，遥测晚于使用方激活、热替换或停用都不影响使用方；不在时是空实现，不分配、不计时。
- 接口：
  - `tracer(scope)`：按插件 id 取记录器，作为 OTLP 的 instrumentation scope；
  - `startSpan(名字, { parent, kind, attributes, links })`：`parent` 可以是本进程的 span、W3C `traceparent`，或随数据传下来的 `TraceRef`；不给或不合格时开一条新的 trace。span 有 `traceparent`（交给下游作父）、`setAttributes`、`addEvent`、`addLink`、`fail(错误类别)`（状态记为 ERROR，类别写进 `error.type`）与 `end`，只有结束的 span 才写出；
  - `record(名字, 值, 单位, 属性, 关联的 span)`：直方图的一个样本；
  - `sidecarEnv()`：拉起 sidecar 时加进它环境的变量（见下文[跨进程](#跨进程)）。
- trace ID 与 span ID 取自 `random@1`，时间取自 `clock@1`：时间戳是 Unix 纳秒，即时钟零点对应的 Unix 毫秒加单调时钟。确定性仿真里同一种子两次运行的遥测完全相同。
- `traceparent` 按 W3C Trace Context Level 1 解析：接受更高的版本（只读前四段），拒绝版本 ff、全零的 ID 与不合格的写法；生成的总是版本 00、flags 01。
- 随数据传递的链路上下文 `TraceRef`（上游 span 的 `traceparent`、链路起点的时刻 `originAt`、要关联的上游 span）是可选字段，放在 `Danmaku`、分诊候选、投票请求与发声请求上；模型调用的 `traceparent` 放在 `LlmRequest` 上，不放进交给模型的消息，也不发给模型服务；发声前检查的输入、合成选项与 Stage 的句子信息带 `traceparent`。没有遥测时这些字段都不出现。

### 文件与格式

- **位置**：状态存储所在目录（宿主提供 `data-dir@1`）下、`telemetry` 插件配置 `dir` 给出的子目录；`dir` 是相对路径，跳不出这个目录。仓库的 sim profile 用 `telemetry/sim`，live 样例用 `telemetry/live`。
- **文件名**：`<进程>-<UTC 时刻>-<序号>.jsonl`。宿主的进程名是 `host`，sidecar 用它的通道角色（例如 `sidecar.tts-local`）。
- **轮转与保留**：当前文件写到 `maxFileBytes`（缺省 8 MiB），或写满 `maxFileAgeMs`（缺省 1 小时），下一批就换新文件；每个进程只留最新的 `maxFiles` 个（缺省 24），更早的删除，别的进程的文件不动。磁盘占用因此有上限。
- **写出**：
  - 等待写出的记录放在有界队列里（`maxQueue`，缺省 4096），满了丢弃最旧的并计数；
  - 每 `flushIntervalMs`（缺省 2 秒）或攒够 `batchSize`（缺省 512）写一批，同时只有一批在写；
  - 写失败丢弃这一批并计数，下一批重新打开新文件；
  - 队列满与写失败各只记一次日志（`telemetry.queue-full`、`telemetry.write-failed`），停用时写完剩下的再关闭，并在 `telemetry.stopped` 里记下各项计数。
- **格式**：每行一个 OTLP/JSON 导出请求，一批至多两行：`{"resourceSpans":[…]}`（`ExportTraceServiceRequest`）与 `{"resourceMetrics":[…]}`（`ExportMetricsServiceRequest`）。trace ID 与 span ID 是小写十六进制，纳秒时刻与 64 位整数写成十进制字符串，枚举写整数值（span 种类 1–5，状态 0 或 2，不写状态说明）。
  - resource：`service.name`（宿主为 `bellis.host`，sidecar 为 `bellis.<通道角色>`）、`service.instance.id`、`process.pid`（仿真里不写）、`telemetry.sdk.*`，宿主另有 `bellis.semconv.gen_ai`（锁定的 GenAI 约定提交）；scope 为插件 id，sidecar 为它的模块名。
  - 直方图：每批里同一指标、同一组属性的样本合成一个增量（DELTA）数据点，区间从上一批写出到这一批；桶边界按单位取（秒按 OpenTelemetry 语义约定建议的 0.005–10，其余用 SDK 的缺省）。每个样本另作一个 exemplar（原值、时刻与关联的 span），查看工具据此算精确的分位数。
- 仓库的 live 样例缺省启用遥测：不外发、不持凭据、不含内容，磁盘占用有上限，写不进也不影响直播。

### 内容不采集

只记结构、编号、计数、耗时与枚举的结果。模型与观众的内容不采集：弹幕正文、昵称、观众身份（open_id）、模型的输入与输出、字幕与朗读文本、投票的题目与选项、审核与否决的理由。准入规则在宿主与 Python sidecar 里各实现一份，两边的测试对照：

- 属性名只收 `bellis.*`、`gen_ai.*` 与 `error.type`；
- GenAI 约定里承载内容的属性一律拒绝：`gen_ai.input.messages`、`gen_ai.output.messages`、`gen_ai.system_instructions`、`gen_ai.prompt`、`gen_ai.completion`、`gen_ai.tool.definitions`、`gen_ai.tool.call.arguments`、`gen_ai.tool.call.result`；
- 名字的任何一段是表示内容或观众身份的词也拒绝，例如 text、content、message、body、prompt、subtitle、spoken、nickname、viewer、user、open_id、question、option、reason；
- 值只收有限的数值、布尔，以及只含可打印 ASCII、不超过 128 个字符的字符串，中文内容因此进不来；超长的整条拒绝，不截断；
- span、事件与指标的名字只收可打印 ASCII；
- 被拒绝的属性不写出，计入 OTLP 的 `droppedAttributesCount`。

自定义属性一律用 `bellis.*`。GenAI 属性按 open-telemetry/semantic-conventions-genai 锁定的提交 `547934afa90a34298441caf80c43b27255c3a292`（2026-10-18），只用不含内容的部分：属性 `gen_ai.operation.name`、`gen_ai.provider.name`、`gen_ai.request.model`、`gen_ai.response.model`、`gen_ai.usage.input_tokens`、`gen_ai.usage.output_tokens`、`gen_ai.usage.reasoning.output_tokens`，指标 `gen_ai.client.inference.duration`、`gen_ai.client.inference.time_to_first_chunk`（口径见下文[直方图](#直方图)）。推理调用按该约定不记 `gen_ai.client.operation.duration`。该约定里 token 用量的指标是计数器（`gen_ai.client.inference.usage.input_tokens` 与 `.output_tokens`，必填 `gen_ai.token.modality`），本实现只写直方图，所以 P2 不写用量指标，用量只记在模型调用的 span 上。升级约定时改这个提交并核对名字（`packages/telemetry` 的 semconv.ts）。

### 链路

一条弹幕从接入到播出在同一个 trace 里：

| 环节 | span | 父与关联 | 记什么 |
| --- | --- | --- | --- |
| 接入 | `danmaku.receive`（根，consumer） | — | 平台与平台的消息编号；写成事实、交给分诊后结束，开始时刻即链路起点 |
| 分诊 | `triage.candidate` | 第一条弹幕；合并进来的其余弹幕以 links 关联 | 候选编号；取走、过期、挤出或停用时结束，记去向、合并数、是否命中注入检测 |
| | `triage.drop` | 被丢弃的弹幕 | 丢弃的原因（净化后为空、注入） |
| 决策 | `chat <型号>`（GenAI，client） | 排第一的候选；其余候选以 links 关联 | GenAI 属性（回放模型填 `bellis.replay` 与 `replay`，方舟缺省填 `volcengine.ark` 与型号）、决策时机（`bellis.director.trigger`）、候选数、意图类型、命中的漂移信号（`bellis.director.drift`）；模型客户端报来时另记 token 用量（输入、输出，能拿到时含推理）与应答的型号；超时、调用失败、非法输出、回应对象不在上下文、被取消时出错，`error.type` 分别为 `timeout`、模型客户端的失败类别（见[决策模型](director.md#失败)）、`invalid_output`、`unknown_target`、`cancelled` |
| | `memory.recall`（client） | 这次模型调用 | 是否打开召回判断、结局、Iris 给出与留下的条数、各类过滤丢掉的条数（见[记忆的遥测](memory.md#遥测)） |
| 发声 | `speech.utterance` | 回应弹幕：被回应的候选，以 link 关联这次模型调用；闲聊与开票说明：模型调用；其余来源：根 | 发言编号、来源、可抢占点、是否含不可信输入；出队为事件；结束方式、听到的字数、跳过的句数 |
| 每句 | `speech.sentence` | 发言 | 句键、句序号、去向（播出、截断、跳过、拒绝、过期等） |
| | `speech.pre_check`，其下 `moderation.check` | 这一句 | 是否拦下；审核的结论（allow、block、error）与 `error.type`（例如 timeout） |
| | `speech.review` | 这一句（M1） | 放行方式、是否放行 |
| | `speech.authorize` | 这一句 | 是否授权、是否重复 |
| | `tts.synthesize`，其下 sidecar 的 `tts_local.synthesize`（server）与 `tts_local.align` | 这一句 | 第一帧为事件；结束方式；sidecar 记后端、流编号、字数、采样数，出队与第一块音频为事件 |
| 播出 | `stage.play` | 这一句 | 句编号、采样率、开始时的呈现延迟；页面回报的开始与欠载为事件；播出的采样数、是否完整、是否截断 |

### 跨进程

- 宿主调用 sidecar 的 JSON-RPC 在参数里带 W3C `traceparent`（版本 00），sidecar 以它为父写自己的 span，与宿主在同一个 trace 里；本地 TTS 的 `tts.synthesize` 带的是这一句合成的 span（协议见 `packages/protocol` 的 tts.ts）。代理插件只转发解析合格的值，并统一成版本 00。
- 目录与轮转规则经环境变量 `BELLIS_TELEMETRY`（`SidecarTelemetry` 的 JSON）在拉起时交给 sidecar（见[插件内核](plugin-kernel.md#sidecar-代理)），sidecar 写进同一目录里自己的文件，格式与准入规则相同。没有这个变量、不合格或没有通道角色时，sidecar 不写遥测，其余照常；遥测插件晚于代理插件激活时，这个 sidecar 进程不写遥测，下次重启补上。
- Python 运行时（`bellis_sidecar.telemetry`）在守护线程里写：有界队列满了丢弃最旧的，按间隔分批写，写失败丢弃并计数、只记一次日志；进程退出前在截止时间内尽量写完。

### 直方图

时长一律以秒为单位（UCUM 写作 `s`），查看工具换成毫秒显示。

| 指标 | 口径 |
| --- | --- |
| `bellis.danmaku.time_to_first_audio` | 弹幕到首音：从宿主收到这条弹幕（接入的根 span 开始），到回应它的发言第一句在 Stage 开始播出（宿主收到页面回报 started 的时刻）；只记回应弹幕的发言，每段发言一次，样本关联到那一句 |
| `bellis.danmaku.time_to_first_audio.presented` | 同上，再加上那一刻的呈现延迟 D：声音出现在 OBS 输出里的估计；仍不含推流与观众端的延迟 |
| `bellis.moderation.check.duration` | 逐句审核耗时（审核启用时）：审核插件从开始判定到得出结论，含超时与出错，按 `bellis.moderation.outcome` 分 |
| `bellis.tts.time_to_first_audio` | TTS 首包：发声仲裁发出合成（调用 `tts@1`）到拿到第一个 PCM 帧；含路由选择、引擎内的排队与限流等待。sidecar 内部第一块音频的时刻见 `tts_local.synthesize` 的事件 |
| `bellis.stage.stop_to_silence.duration` | 停止到静音：Stage 服务要求页面截断一句（或转告许可令牌变化）到页面回报这一句已截断，按 `bellis.stage.stop_by`（truncate、token）分。页面停止输出后才回报；不含浏览器的输出缓冲、OBS 的缓冲与呈现延迟，不同于[时延目标](../architecture.md#时延目标)里按录音测的停止到静音 |
| `bellis.lease.renew.lag` | 许可续约滞后：发声仲裁续约 Stage 音频输出许可的实际时刻相对计划时刻（上次续约后许可时长的三分之一）的滞后 |
| `bellis.host.event_loop.delay` | 宿主事件循环延迟：`perf_hooks.monitorEventLoopDelay`（分辨率 20ms）在每个采样周期（缺省 10 秒）里的最大值减去分辨率；Windows 的定时器粒度也算在里面 |
| `gen_ai.client.inference.duration` | 一次推理调用（决策的 chat）的耗时：决策插件发出调用到拿到完整输出，含超时、出错与取消。属性只有 `gen_ai.provider.name`、知道时的 `gen_ai.response.model` 与出错时的 `error.type` |
| `gen_ai.client.inference.time_to_first_chunk` | 流式推理调用从发出到收到第一块：模型客户端收到第一块时经调用选项 `onFirstChunk` 报给决策插件，属性同上。只对流式调用记；回放模型不流式，没有样本 |
| `bellis.llm.time_to_first_output` | 流式推理调用从发出到第一个正文块：模型客户端收到第一段非空的正文（函数调用方式下为第一段函数参数）时经调用选项 `onFirstOutput` 报给决策插件；思考内容不算，所以与首块之差约等于思考的耗时。属性同上 |
| `bellis.memory.recall.duration` | 记忆召回：记忆插件发出召回准备到拿到结果（含超时、出错与取消），按 `bellis.memory.outcome` 分；不含过滤。决策插件到截止时间就不等它（见[记忆的召回](memory.md#召回)） |

游戏首动作时间在 P3 加入。

### 查看

- `pnpm telemetry summary`：各直方图的样本数与 p50/p95/p99（最近秩法，失败样本不剔除），以及最近的弹幕链路；
- `pnpm telemetry trace <trace 编号或至少 8 位前缀>`：按 trace 打印 span 树，含 sidecar 的 span：进程、相对开始、耗时、属性、事件与关联；
- 两者都可以加 `--config 配置文件`（缺省 `config/sim.json`，按状态存储所在目录与 profile 里的 `dir` 找目录）或 `--dir 目录`。只读文件，不连接宿主；文件里本来就没有内容。

### 用 OTel Collector 导入

需要可视化时，在进程外运行 OpenTelemetry Collector（contrib 发行版）读这些文件，再转发到 Jaeger、Tempo、Prometheus 等后端；Bellis 自己不连接任何遥测后端。示例配置如下（未实测，PENDING），用 `otlpjsonfile` 接收器读 JSONL，端点按所用后端改：

```yaml
receivers:
  otlpjsonfile:
    include: ['<状态存储所在目录>/telemetry/live/*.jsonl']
    start_at: beginning
exporters:
  otlp:
    endpoint: 127.0.0.1:4317
    tls:
      insecure: true
service:
  pipelines:
    traces:
      receivers: [otlpjsonfile]
      exporters: [otlp]
    metrics:
      receivers: [otlpjsonfile]
      exporters: [otlp]
```

直方图是增量的；导出到只收累计值的后端（例如 Prometheus）之前，在 metrics 管线里加 `deltatocumulative` 处理器。

## 确定性仿真

- 自研（R-07）：时钟、随机数、传输、模型、TTS、弹幕源都是插件服务；`sim` profile 把它们整体换成由种子驱动的模拟实现；用 fast-check 生成与收缩失败轨迹。
- 整个世界（状态存储、安全核、插件内核与全部插件）在一个进程里由同一个手动时钟驱动；同时到期的定时器按种子决定先后，以覆盖不同的交错。
- 场景由 fast-check 生成：录制弹幕（含提示注入、控制字符、禁词，以及投票用的编号、选项文本与不匹配的写法）与接收缺口（缺口期间的弹幕收不到）、模型输出（含非法输出与发起投票，选项可能含禁词；超时，即比决策插件的截止时间晚到，有的不理会中止、到点照样给出输出；以模型客户端的各类失败结束）、定时播报、审核开关与出错、审核耗时、慢 TTS、TTS 中途出错与 TTS 的每分钟请求数上限（到上限安静等待）、0–300ms 的呈现延迟（仿真里没有 OBS 音量表，stage-sync 一直用初值），模拟 Iris 的召回耗时（含超过决策插件截止时间的）、写入的应答耗时与故障（503、应答丢失），以及操作员的急停、升级、崩溃重启、登记墓碑，与在 OBS 里不经 Bellis 切到安全场景或静音 Stage 源（热键或手动操作）。升级前操作员先把 OBS 切回直播场景、取消静音。模拟 Iris 代表进程外的服务，数据跨重启保留；与契约一样，入口在首次收到消息时创建，之前的召回准备得 404。
- 场景的模式：M0，或真实输出模式 M2（安全核按非仿真配置，设备仍是模拟的；在场确认有效，降级可降到 M1，M1 有固定延迟的逐句放行）。启动、崩溃重启与升级都切到场景的模式。
- 回放模型与发声仲裁在仿真里把每次模型调用（上下文里的候选、给出的输出或失败、先到的中止）与每个发声请求写进追踪，不变量据此独立推算决策插件该做什么。
- 不变量：
  - 每一步：每个资源的执行许可至多一个持有者；许可令牌不回退。
  - 追踪上：审核插件启用时被判不可说的句子从未在 Stage 上开始；安全停止期间 Stage 没有播出任何采样；写回恰好是 Stage 回报已播出的部分（由页面回报的采样数独立推出，急停且应急动作成功时扣掉呈现延迟，见[发声](speech.md#播放游标与写回)）；页面显示的字幕不早于游标，页面回报一句截断时它的字幕已清除，播完时至迟在呈现延迟之后清除；同一句与同一意图从未执行两次（含跨重启）。
  - 投票（见[投票](audience.md#投票)）：同时最多一个，安全停止期间不开票，同一投票只开一次、恰好以结束或中止收尾；开票说明完整播出之后才开始倒计时，截止之前不出结果；结果等于按冻结的规则对开票之后、截止之前送达的弹幕独立重算的结果（截止后的弹幕不计票，每人只计第一票），与投票时段重叠的缺口次数与时长一致；开票说明与结果播报各至多播一次（含跨重启），只有正常结束的投票播报结果。
  - 遥测（见[观测](#观测)）：仿真启用写内存的遥测，它不设定时器，也不挪动其它插件的实例编号；启用与不启用遥测，追踪与事件完全相同。每一行都是合格的 OTLP/JSON，span ID 不重复；属性名都过准入规则，属性值不含送出的弹幕正文、昵称与 Stage 上的字幕。回应了弹幕、已经写回、且有句子在 Stage 上开始播出的发言（含开票说明），它开始播出的每一句都能沿父 span 在同一 trace 里追到那条弹幕（意图来源里的第一条输入）的根 span，途中的 span 都已写出，这一句的播出 span 带“开始播出”事件；回应弹幕的发言第一句开始播出时恰好记一个“弹幕到首音”样本，值等于这一刻与根 span 开始之差，“加呈现延迟”的样本再多出当时的呈现延迟。崩溃时还没写出的遥测随进程丢失，不计入检查。
  - 记忆（见[记忆](memory.md)）：Iris 存下的每条角色发言恰好是同一发言写回的部分，每段有人听到的发言恰好排队一次或被隐私网关拦下一次；Iris 存下的每条消息都对得上 `memory.queued`，同一个去重键、同一条弹幕在 Iris 里都至多一条消息（含跨重启与平台重发），入口建立的事件是固定文本、至多一条，记为已写入的都真的在 Iris 里；登记墓碑之后，这名观众的消息不再排队、不再发出，召回进入上下文的记忆不含他写入的消息。
  - 决策模型的失败（见[决策模型](director.md#失败与降级)）：每次调用的结局按先到的中止（截止时间到点算超时，否则是取消）、失败或输出（非法、回应对象不在本次上下文算失败）推出；仿真里同一时刻到期的定时器之间不跑微任务，出错给出之后、决策插件处理之前可能先到一个取消，这次调用算作取消（给出输出之后再到的取消不改变结局）。失败与取消的调用不产生任何发言，超时晚到的输出从不交给发声，成功的说话意图恰好交给发声一次、文本不变；过渡语只在超时或出错、且这次取到了候选时请求，每一串连续失败至多一句；连续失败每满告警阈值记一次 `director.alarmed`，告警（含漂移告警）之后安全核随即收到降级请求，模式随之下降（已在安全停止时不变）。各次启动分别计。
  - 监督模式与 OBS 外部变化（见[安全核](safety-core.md#执行许可与急停)）：安全核自动的模式变化只降不升，离开安全停止只能由操作员；真实输出模式下 OBS 外部切到安全场景或静音 Stage 源，同一时刻记 `safety.obs-external`、以对应的原因急停并进入安全停止，与“安全停止期间 Stage 没有播出任何采样”合起来，直到操作员重新升级 Stage 不再播出；M0 与安全停止中的外部变化只写日志，不记事实、不急停；OBS 本来就在那个状态时什么也不发生。
  - 结束时：排空后没有卡住的意图与插件，没有进行中的投票。
  - 同一场景与种子两次运行得到完全相同的追踪、事件与遥测。
- 每次提交在固定种子集上运行；收缩出的失败场景加入回归用例。
- `pnpm sim [--seed N] [--runs N]` 做更大规模的探索；失败时打印收缩后的场景，并给出“种子 + 路径”的复现命令，配合提交即可复现。

## 评测

- 把真实直播中的弹幕会话导出为回放样本，在 `sim` profile 下做回归。
- 中文红队语料（谐音、拼音、emoji、分步诱导、昵称注入）用来评估审核插件；进入无人值守前须达标。
- 对话质量用模型评审辅助，并用人工抽样校准，注意评审标准会漂移。
- 实测指标报告样本数与 p50/p95/p99，失败样本不剔除。

## 技术路线

已批准：R-07、R-20、R-21、R-27。
