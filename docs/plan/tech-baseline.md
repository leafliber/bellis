# 技术基线与路线审核

本文件是 Bellis 技术选型的唯一登记处。规则：

- 只有“已批准”的决策和路线可以写进架构、模块文档与任务卡，作为实现依据。
- 需要新选型时，先在“待审核路线”登记候选、推荐与依据，由维护者审核；审核前不得在代码或文档中把候选写成定论。
- 批准、否决或改选都直接修改本文件对应的行，不另写评审记录。批准后的路线保留原编号，移到“已批准的路线”。

## 已批准的决策

| 编号 | 决策 | 内容 | 批准日期 |
| --- | --- | --- | --- |
| D-01 | 最终目标 | AI 主播内核：在已适配游戏中以 VLA 方式完全自主游玩原神这类游戏（即时战斗、剧情理解、多样小游戏解谜），同时直播互动；长期目标包含无人值守 | 2026-10-14 |
| D-02 | 自主范围 | 已适配游戏内完全自主；零样本通关未适配游戏、直播中在线自动训练并上线均为非目标 | 2026-10-14 |
| D-03 | 原神定位 | AI 作为玩家自行理解剧情、战斗、解谜，原神照常作为公开直播目标；从最基础的能力搭起、逐步完善 | 2026-10-14 |
| D-04 | 游戏控制归属 | 采集、感知、VLA 策略、输入代理和训练放在独立仓库 [bellis-game-runtime](https://github.com/leafliber/bellis-game-runtime)；逐帧控制不经过 Bellis | 2026-10-14 |
| D-05 | VLA 路线定位 | 主线，在 Game Runtime 中与 Bellis 的 P0–P3 并行研究 | 2026-10-14 |
| D-06 | 首个公开里程碑 | 《魔法少女的魔女审判》公开试播（T1）：AI 自主游玩，B 站小流量公开，操作员全程在场 | 2026-10-14 |
| D-07 | 试播中的选项决策 | 无计时选项由 AI 决定是否开观众投票；有计时选项由 AI 自己选 | 2026-10-14 |
| D-08 | 游戏文本获取 | OCR 与 VLM 都做，作为 Game Runtime 中两个独立插件，可分别开关、加载 | 2026-10-14 |
| D-09 | 合规准入 | AI 标识等合规要求在 T1 试播门禁时强制满足 | 2026-10-14 |
| D-10 | Iris 接入 | 只读召回直播间公开事实，P2 实现、T1 试播起用于公开直播；写入经隐私网关，观众内容一律标为不可信；个性化与私密召回待 iris-core 补齐主体隔离与删除后再开 | 2026-10-14 |
| D-11 | 验收平台 | P0 在 macOS 验收；P1 起只认 Windows 11 x64，Windows 10 不作为支持平台；三平台 CI 始终运行完整检查并要求通过，但 CI 通过不构成阶段验收 | 2026-10-16 |
| D-12 | 本机进程间通信 | Windows 命名管道 / POSIX UDS，同一抽象；身份靠应用层双向认证，不依赖文件权限位；威胁模型不防同一用户下的恶意进程 | 2026-10-14 |
| D-13 | 插件框架 | 借鉴 dsh（DeepSeek Harness）及其所用 Cordis 框架的模式，自研最小内核，不引入 Cordis 依赖；安全核不可被 profile 移除；停用先安全收尾再撤销注册；重计算插件在进程外经 JSON-RPC 接入 | 2026-10-14 |
| D-14 | 插件内核范围 | P0 即实现：服务与依赖激活、可撤销注册、五种事件分发、加载器、profile/patch、普通插件热替换，以及新增的“静止中”状态；多角色隔离等有需求再做 | 2026-10-14 |
| D-15 | 安全核位置 | 宿主内模块（不经过插件加载器），加一个直连 OBS 的外部看门狗进程；进入无人值守前再评估是否拆成独立进程 | 2026-10-14 |
| D-16 | 编排模型 | 混合：决策状态用 reducer，设备与连接用 actor，语音用数据流管线；停止与急停走独立控制通道 | 2026-10-14 |
| D-17 | 持久化 | 单个 SQLite（WAL）：只追加的事件表、同事务更新的投影表、待执行意图表；重启只回放事件，永不重做副作用 | 2026-10-14 |
| D-18 | 内容审核 | 审核是一个普通插件，不属于安全核，前期从简、不作为重点。用一个与决策模型分开的独立审核模型逐句判定一次，不可说就跳过该句；判定超时或出错时默认跳过，可在插件配置中改为放行。可在 profile 中关闭；关闭须显式设置，操作台常显“审核已关闭”，开关变化记入事件日志；审核关闭时不允许进入无人值守（M3） | 2026-10-14 |
| D-19 | 热替换范围 | 普通插件可热替换；关键平面只在维护态替换；安全核永不热替换 | 2026-10-14 |
| D-20 | 插件信任 | 宿主进程内只加载本项目插件；第三方代码一律作为 sidecar 进程接入 | 2026-10-14 |
| D-21 | 协议 Schema | TypeScript 为源，生成 JSON Schema 2020-12 与 Python Pydantic 模型；控制面 JSON-RPC 2.0；音频走独立二进制流 | 2026-10-14 |
| D-22 | 部署拓扑 | 先单机；在真机测出 GPU 争用后再决定是否加推理机 | 2026-10-14 |
| D-23 | 运行环境 | 全部 Windows 原生运行，包括 Python sidecar 与 Iris | 2026-10-14 |
| D-24 | OBS 基线 | 锁定 OBS Studio 32.2.x；33 正式版发布并复测浏览器源音频后再迁移；Bellis 只用 obs-websocket 与浏览器源，不写 OBS 插件 | 2026-10-14 |
| D-25 | 路线图 | P0 内核与安全核 → P1 真实媒体 → P2 真实互动 → P3 游戏桥与魔女审判 → T1 公开试播；VLA 研究并行；之后原神分步上线，再到无人值守。详见[路线图](roadmap.md) | 2026-10-14 |
| D-26 | P0 范围 | 含一条全模拟的端到端发声链路（录制弹幕 → 回放模型输出 → 模拟审核插件 → 模拟 TTS → 模拟 Stage），并配固定种子的确定性仿真 | 2026-10-14 |
| D-27 | Bellis 与 Game Runtime 接口 | 语言子目标加结构化字段；输入许可短周期续约，过期即释放全部输入；潜向量只在 Game Runtime 内部使用 | 2026-10-14 |
| D-28 | 凭据存储 | 统一 SecretStore 接口：Windows 小令牌存凭据管理器、大块数据用 DPAPI 加密文件；macOS 开发机用 Keychain | 2026-10-14 |
| D-29 | 技术路线审核方式 | 本文件即审核记录；每个模块的技术路线都须经维护者批准 | 2026-10-14 |
| D-30 | 急停路径 | 急停由安全核经自己独占的 OBS 应急连接执行，不需要执行许可，不经过插件；Stage 不可用、关键平面失效时同样走这条路径 | 2026-10-14 |
| D-31 | 执行许可令牌 | 每个资源一个令牌计数器，保存在状态存储中，只增不减；设备只接受等于当前令牌且未过期的指令 | 2026-10-14 |
| D-32 | 监督模式与降级 | M0–M3 之外设“安全停止”；自动降级时，在场确认有效则降到 M1，否则进入安全停止；重启后回到安全停止 | 2026-10-14 |
| D-33 | 发声优先级 | 由确定性代码按请求来源决定，决策模型不能指定；从高到低：安全播报、投票结果、定时播报、游戏关键反应、弹幕回复、闲聊 | 2026-10-14 |
| D-34 | 执行许可时长初值 | Stage 音频输出约 2 秒；游戏输入约 500 毫秒、每 250 毫秒内续约；均待实测后调整 | 2026-10-14 |

## 已批准的路线

| 编号 | 模块 | 路线 | 批准日期 |
| --- | --- | --- | --- |
| R-01 | 宿主运行时 | Node 26 LTS（2026-10-28 起为 LTS，支持到 2029-04）+ TypeScript；类型剥离直接运行，tsc 只做类型检查 | 2026-10-14 |
| R-02 | 工程工具 | pnpm workspace、node:test、Biome；属性测试用 fast-check | 2026-10-14 |
| R-03 | Schema 库 | TypeBox：定义即 JSON Schema，并由此生成 Pydantic 模型 | 2026-10-14 |
| R-04 | SQLite 驱动 | Node 内置 `node:sqlite`，外面封一层存储接口，便于将来更换驱动；当前稳定度为 1.2（发布候选），升级 Node 时复核 | 2026-10-14 |
| R-05 | 本机通道认证 | 每次启动生成随机管道名与共享会话密钥；双方互发随机数并以 HMAC 证明持有密钥，认证前不传任何数据 | 2026-10-14 |
| R-06 | 子进程寿命 | 停止顺序：RPC shutdown → 关闭 stdin（子进程读到 EOF 后自退）→ 超时 kill。直接子进程由 Node 自带的 Job 保证父进程退出即终止；sidecar 用 Job Object 管住自己派生的孙进程 | 2026-10-14 |
| R-07 | 确定性仿真 | 自研：时钟、随机数、传输与外部服务都作为插件服务，`sim` profile 用种子驱动调度；用 fast-check 生成与收缩失败轨迹，失败以“种子 + 提交”复现 | 2026-10-14 |
| R-08 | Stage 连接与认证 | 宿主用 `node:http` 只在 `127.0.0.1` 上提供页面（每次会话随机端口），WebSocket 服务端用 `ws`（`noServer`，在升级阶段认证）；每个请求与升级都要求 Host 与本端地址严格相等，Origin 也须严格相等，唯一例外是页面文档的顶层导航（浏览器不为它带 Origin，S-01 确认），它只在 Sec-Fetch-Mode 为 navigate 且 Sec-Fetch-Dest 为 document 时放行；每次会话生成 128 位一次性令牌，经 obs-websocket 写进浏览器源 URL 的片段，页面以首条消息出示后换成只存于内存的会话密钥；同时只允许一个已认证会话 | 2026-10-16 |
| R-09 | Stage 音频路由 | OBS 浏览器源开启“Control audio via OBS”，页面用 AudioWorklet 播放；不用虚拟声卡或 sidecar 直接出声。长时间最小化或遮挡下的表现以探针 S-01 为准 | 2026-10-15 |
| R-10 | TTS 引擎 | 云端优先：自写不绑定厂商的 TTS 插件，接 MiniMax 与火山引擎的双向流式接口（中途取消、字/词级时间戳），主备由探针 S-07 定；外发须在 profile 中显式开启，所用厂商须提供算法备案编号。本地 Qwen3-TTS 作降级，以 sidecar 接入 | 2026-10-15 |
| R-11 | 字幕时间对齐 | 两段式：句段一到即按字数（标点处加权）线性铺开，字幕立即可用；随后用 TTS 返回的时间戳细化，本地 TTS 用 Qwen3-ForcedAligner 对齐，对不齐的片段保留插值。结束时刻不晚于播放游标的字算已播出 | 2026-10-15 |
| R-14 | 外部看门狗 | 独立 Node 小进程；宿主心跳丢失时经 obs-websocket 5 用一次 RequestBatch 静音 Stage 源、切安全场景（按策略决定是否停流），然后呼叫操作员；P0 对接模拟 OBS | 2026-10-14 |
| R-15 | 形象 | VTube Studio 插件 API：按播放游标以 30–60Hz 注入嘴型参数（每个参数至少每秒重发一次），表情经表情或热键接口；VTS 画面用 OBS 自带的游戏采集（允许透明）接入，不装 OBS 插件。Bellis 不含 Live2D 代码 | 2026-10-15 |
| R-16 | SecretStore 实现库 | @napi-rs/keyring 覆盖 Windows 凭据管理器与 macOS Keychain；出现超出凭据管理器单条上限的条目时，再为大块数据的 DPAPI 加密加一个原生绑定，绑定库届时登记审核 | 2026-10-16 |
| R-23 | 进程启动与连接信息分发 | “登录时运行”的计划任务启动一个轻量启动器，由它分别拉起宿主与看门狗（看门狗不是宿主的子进程）；本次会话的管道名与密钥写入 SecretStore，供看门狗和单独启动的 Game Runtime 读取；macOS 开发机用同一启动器脚本 | 2026-10-14 |

## 待审核路线

候选按推荐顺序排列；“何时需要”是最晚必须定下的阶段。

| 编号 | 模块 | 候选（首项为推荐） | 依据与取舍 | 何时需要 |
| --- | --- | --- | --- | --- |
| R-12 | 审核模型 | 本地小模型（如 Qwen3Guard-Gen）/ 云端中文审核接口 / 通用 LLM 加审核提示词 | 只在审核插件启用时需要；本地模型与游戏、OBS 争 GPU，云端需外发许可 | P2 |
| R-17 | 决策 LLM | 已备案的云端模型 / 本地开源模型 | 合规要求对公众输出使用已备案模型；本地模型与游戏、OBS 争 GPU | P2 |
| R-18 | 弹幕接入 | B 站直播开放平台（open_id、HMAC 签名、项目心跳） | 官方接口；不提供 uid，以 open_id 作稳定身份 | P2 |
| R-19 | Iris 客户端 | 按 iris-core HTTP 契约自写薄客户端（HTTP + SSE） | iris-connectors 的 TS 客户端为 AGPL-3.0，直接引入会影响 Bellis 的许可 | P2 |
| R-20 | 操作台 | 本机 Web 页（独立 Origin）/ 桌面壳 | Web 页最轻；急停不能只依赖操作台 | P2 |
| R-21 | 遥测 | OpenTelemetry，GenAI 语义约定锁定版本，自定义属性用 `bellis.*` | agent 相关 span 仍处于 Development 状态 | P2 |
| R-22 | 打包与分发 | 暂不定（候选：Node 单可执行文件、安装器、签名） | 个人开发者的代码签名渠道受地区限制；试播前再定 | T1 前 |
| R-24 | Python sidecar 工具链 | Python：3.12 / 3.13；包管理：uv / pip + venv；PyTorch：2.11.0 配 CUDA 13.0 / 2.14.x 配 CUDA 13.0 / 2.11.0 配 CUDA 12.8；注意力：PyTorch SDPA / FlashAttention 2；TTS 与对齐：同一环境、用 uv 的依赖覆盖统一 transformers 版本 / 两个环境、两个 sidecar；Pydantic 模型生成：datamodel-code-generator / 在 `gen.ts` 中自写；Python 侧检查：ruff、pyright、pytest / 以 mypy 代替 pyright | Qwen3-TTS 与 Qwen3-ASR（含 Qwen3-ForcedAligner）的官方 README 都以 Python 3.12 的独立环境为例，没有提到 Windows（[Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS)、[Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR)）；3.12 只收安全修复，支持到 2028-10（[PEP 693](https://peps.python.org/pep-0693/)），解释器由 uv 安装管理，不依赖系统 Python。uv 用平台标记把 torch、torchaudio 指向 PyTorch 的 CUDA 索引，锁文件入库（[uv 指南](https://docs.astral.sh/uv/guides/integration/pytorch/)）；PyTorch 与模型依赖单独成组，只在 Windows 真机安装，三平台 CI 只装协议与检查所需的部分。qwen-tts 0.1.1 钉死 transformers 4.57.3，qwen-asr 0.0.6 钉死 4.57.6，两者装不进同一环境（据 PyPI 元数据，uv 解析确认）。合成与对齐依次处理同一段音频，放在一个进程里只占一份 CUDA 上下文，所以推荐用依赖覆盖统一到 4.57.6，qwen-tts 在该版本下是否正常由 S-07 本地部分验证（PENDING），不正常再拆成两个 sidecar。qwen-tts 导入时即加载 torchaudio；torchaudio 已转入维护，最新版 2.11.0 的轮子不再声明 torch 版本约束，与更新的 torch 是否二进制兼容未验证，所以推荐 torch 同取 2.11.0，代价是 PyTorch 只为最新小版本发补丁，2.11 不会再有补丁（[RELEASE.md](https://github.com/pytorch/pytorch/blob/main/RELEASE.md)）。PyTorch 2.11 的 Windows CUDA 12.8 与 13.0 构建都含 Blackwell（sm_120）（[#172663](https://github.com/pytorch/pytorch/issues/172663)）；CUDA 12.8 的轮子止于 2.11，所以取 13.0；CUDA 13.x 要求 R580 及以上驱动（[CUDA 发行说明](https://docs.nvidia.com/cuda/cuda-toolkit-release-notes/index.html)）。FlashAttention 官方只支持 Linux，发布中没有 Windows 轮子，FA2 的架构列表不含 Blackwell（[flash-attention](https://github.com/Dao-AILab/flash-attention)），社区预编译轮子不采用；Qwen3-TTS 的模型支持 SDPA，两者的速度与显存差别由 S-07 本地部分实测。datamodel-code-generator 是 Pydantic 文档列出的现成工具（[集成页](https://pydantic.dev/docs/validation/latest/integrations/dev-tools/datamodel_code_generator/)），免去自维护生成器，但让 `gen` 与 `gen:check` 依赖 uv（Python 探针脚本也要过完整检查，CI 本就要装 uv），它对现有 Schema 的生成结果 PENDING；自写生成器让 `gen:check` 保持纯 Node，只覆盖实际用到的关键字、遇到未知关键字即报错，代价是自己维护。类型检查选已稳定的 pyright，不选仍为 Beta 的 ty | P1 第 2 步中需要 Python 的探针（S-03、S-05 与 S-07 的相关部分、S-02） |
| R-25 | Stage 页面脚本 | 页面与 AudioWorklet 模块写成带 JSDoc 类型的 JS，由单独的 tsconfig 以 `checkJs` 检查并纳入 `pnpm run typecheck`，宿主按原样提供 / 写 TypeScript，宿主启动时用 `module.stripTypeScriptTypes` 剥离类型后提供 / 写 TypeScript，用打包器或 tsc 生成 JS | 页面没有第三方依赖，用不到打包器；生成 JS 也与 R-01“tsc 只做类型检查”不符。JSDoc 方案下浏览器执行的就是仓库里审阅过的源码，运行时不转换、不依赖实验性接口；用仓库当前的 TypeScript 7.0.2 试过，`checkJs` 能检出 JSDoc 标注的类型错误，`@import` 能引用 `.ts` 文件中的类型，页面因此可以复用协议包的消息类型；代价是写法比 TypeScript 啰嗦，且 TypeScript 7 已不支持 `@enum`、`@constructor` 等标签（[TypeScript 7 进展](https://devblogs.microsoft.com/typescript/progress-on-typescript-7-december-2025/)）。`stripTypeScriptTypes` 在 Node 26 中为 1.2（发布候选），26.0.0 删去了 `transform` 与 `sourceMap` 选项，文档说明其输出不保证跨 Node 版本一致（[Node 文档](https://nodejs.org/docs/latest-v26.x/api/module.html)），在 Node 26.12.0 中调用仍打印 ExperimentalWarning；它还让宿主启动路径多一步转换，浏览器执行的代码与源码不再逐字一致。三者共同：TypeScript 7.0.2 自带的库不含 AudioWorklet 全局作用域的类型（`AudioWorkletProcessor`、`registerProcessor`），需自写声明或引入 `@types/audioworklet`；worklet 模块与页面一样按 R-08 提供 | P1 第 4 步 |
| R-26 | “登录时运行”计划任务的注册 | `schtasks.exe /Create /XML` 注册、`/Delete` 注销，以 `spawn` 调用，不经 shell / PowerShell 的 `Register-ScheduledTask -Xml` 与 `Unregister-ScheduledTask` / Task Scheduler COM 接口的原生绑定 | 三者注册的都是同一份任务 XML，区别只在调用方式。XML 由代码生成，显式写明：登录触发器只针对当前用户（命令行的 `/SC ONLOGON` 是任意用户登录时运行，[schtasks create](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/schtasks-create)）、交互令牌、最低权限；`ExecutionTimeLimit` 设为 `PT0S`，默认运行 72 小时即被停止（[ExecutionTimeLimit](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/nf-taskschd-itasksettings-get_executiontimelimit)）；`Priority` 设在 4–6，默认值 7 对应低于正常的 CPU 优先级与低 I/O、低内存优先级（[Priority](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-priority-settingstype-element)），且低于正常的优先级类会被子进程继承（[CreateProcessW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw)），宿主与看门狗会一并降级。schtasks 系统自带、无依赖；输出随系统语言本地化，只以退出码判断，必要时用 `/Query /XML` 读回核对；XML 文件的编码要求 PENDING（社区经验为 UTF-16）。PowerShell 可直接接收 XML 字符串、错误更结构化，但启动慢，传入的命令文本要防注入。COM 原生绑定要引入或自写原生模块，只为注册与注销两条命令不划算。非提权进程能否为当前用户注册登录触发的任务 PENDING，第 9 步实现前在真机验证 | P1 第 9 步 |

Game Runtime 的采集、OCR、VLM、输入代理与 VLA 路线在其仓库登记和审核，不在本表。

## 工具链现状

工具链按 R-01–R-03 建立，各工具的确切版本以根目录的 `.node-version`、`package.json` 与 `pnpm-lock.yaml` 为准，不在本文重复。三平台 CI 见 `.github/workflows/ci.yml`。
