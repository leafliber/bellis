# Phase 5 及以后路线图：独立游戏平台与产品交付

状态：2026-09-07 修订的实施计划，尚未实现。基线为 Bellis `bf91500`；Phase 4A 冻结结果保持，Phase 4B 未完成项继续留在 [原待办](./phase-4b-backlog.md)。本页是 Phase 5 及以后排期的唯一目录，长期架构中的 Milestone 表达产品能力，不再当作同号 Phase。

依据：[用户提供的 v0.4 设计快照](./design/game-runtime-multigame-v0.4.md)、[ADR 0048](./adr/0048-external-game-runtime-and-session-activity.md)。v0.3 引用项未取得可读正文，不能假定其全部细节已经审查；缺项在 Phase 5 G0 冻结。文档中的仓库名、包名、端点和第二款游戏均为规划，不是已交付接口或创建/发布操作的授权。

## 这次调整了什么

| 原安排 | 修订后 |
| --- | --- |
| Bellis 内部游戏技能执行器与 Rust Sidecar | 独立 Python 游戏 Runtime 拥有执行；平台侧原生 Broker 拥有物理输入；Bellis 仅接通用薄插件 |
| 每个游戏实现一个 Bellis 游戏插件 | 一套通用插件和 Client，按当前会话发现能力；每个游戏独立 Game Pack |
| Bellis→Sidecar 的 loopback gRPC 作为游戏控制链 | Bellis 插件→Host 为 HTTP/OpenAPI + 游标 SSE；Broker 使用本地受认证 IPC |
| Phase 5 同时完成首个游戏、Studio、Launcher、签名更新 | Phase 5 公共边界；Phase 6 原神闭环；Phase 7 多游戏/跨机；Phase 8 产品交付 |
| 游戏仓库/安装包/进程/机器绑定 | 分别按维护、兼容、隔离及桌面资源需要决策 |

## 仓库与发布包的边界

| 仓库 | 计划拥有 | 不应依赖 |
| --- | --- | --- |
| Bellis（已有） | Plugin SDK、GameProvider/Session Activity、连接注册、权限、直播表现、统一记忆写入 | 游戏 Python 包、原神资源、游戏私有数据库/任务图 |
| 游戏平台（待建，暂名 game-agent-runtime） | Runtime Host/Core、Adapter SDK、FakeGame/原神包、TS Client、Bellis 薄插件、Windows 平台和 Input Broker | Bellis 私有源码；Core 不依赖任何具体游戏包 |
| Iris（已有独立项目） | 原有记忆服务与公共接口 | 不因游戏集成复制一份服务或与其他项目共享 SQLite |

三个 SDK 接口面分别是 Bellis Plugin SDK、Game Client SDK、Game Adapter SDK；无需第三个 SDK 仓库。只有薄插件依赖 Bellis SDK。原神识别、战斗、导航、剧情/GUI、模型索引和场景测试一开始就放在 Game Pack 边界。

游戏平台内 Python Core/轻量包与重模型 Worker 分开求解依赖；不要用宽泛 workspace glob 将所有未来游戏和 CUDA 组合绑在一起。多游戏依赖冲突可先独立 Worker/Runner 环境，同仓继续维护。详细目标目录见设计快照 §3，不提前生成所有空目录。

## 阶段与进入条件

| 阶段 | 目标与最小交付 | 结束 Gate |
| --- | --- | --- |
| **Phase 5：公共 SDK 与 FakeGame 联调** | Bellis 公共 Plugin SDK、GameProvider、Session Activity；游戏侧 Adapter SDK、FakeRuntime/FakeGame、HTTP/SSE Client 和薄插件；attach、单 owner、桌面父资源语义 | 无游戏/无输入的服务走正式插件注册路径；干净 consumer 使用打包产物通过活动、操作和事件契约；两仓可独立构建 |
| **Phase 6：Windows 原神纵向闭环** | 一个 Host、一个前台控制会话；真实捕获、Broker/看门狗、原神独立包；先无 LLM 战斗，再剧情/导航/GUI、固定完整任务链及检查点局部计划更新 | Windows 真机完成冻结的能力链；取消/失焦/撤权/崩溃输入清理；有游戏效果证据；集成模式无双重播报/记忆写入 |
| **Phase 7：多游戏与跨机验证** | 第二个真实 Game Pack 的短流程；动态能力发现、切换隔离；一个通用插件连接配对 Host；同机/跨机同协议 | 新包无需修改 Bellis 游戏核心路由或复制 Runtime；桌面输入单 owner、旧会话污染防护和包不兼容隔离；断网后原操作可对账 |
| **Phase 8：产品化与受控部署** | 完整 Studio 连接/权限/Activity/Trace/回放界面；Bellis Launcher 与游戏平台应用发行；attach→managed、签名更新、原子回滚及 Windows 安装包 | 无源码/开发工具的安装、升级失败恢复、密钥保管、独立 CLI 与 Bellis 切换、Windows/OBS/完整直播负载和正式组合矩阵通过 |

Phase 5 可以从已冻结 Phase 4A 基线启动，不要求先完成全部 Phase 4B。阶段开始前只列出自身实际依赖的缺口：例如 Activity 所需资源仲裁、实际播报/阅读确认、统一 Observe；这些依赖要在对应联合 Gate 前解决，不能绕过。MCP、多 Provider 或整个主动表现引擎不自动变成 FakeGame 联调前置。

Windows 真机是 Phase 6 输入与效果验收的条件，不是 Phase 5 公共包和 FakeGame 开发的前置。需要的真实 LLM/TTS、角色资源按对应演出 Gate 接入；先用确定性 Planner/表现夹具验证边界，不能将夹具结果当作真实游戏/声音/模型验收。

## Phase 6 的内部顺序

1. **6A 平台输入基线**：Windows 捕获/坐标/窗口端口与原生 Broker 分离；主机/桌面父独占、用户 Arm、输入租约、独立急停、迟到命令与本地看门狗。不同 Runtime 进程不得各持一把伪独占锁。
2. **6B 无 LLM 战斗**：只交付原神实际可用的少量能力；控制器快循环与轻量识别在游戏机器运行。感知或模型过慢不拖住安全控制。
3. **6C 固定完整任务链**：逐步接入剧情、导航、GUI、领域状态与可证明的操作结果；图中依赖顺序执行，兼容的观察/计算可并行，只有获授权控制器可用输入。
4. **6D 集成与候选更新**：异步规划器提出计划，在检查点重新核验版本、会话、权限和资源后局部应用。Bellis 映射活动事件为表达、阅读回执和带游戏来源的 Iris 记忆；任务图与代码/模型升级保持分离。

“原神支持”必须列出游戏版本、界面语言、分辨率/缩放、输入方式、账号当前能力及场景范围。不得用一个大版本范围或安装成功替代真实验收。无法识别、权限不足、失焦或输入清理失败时停止相应控制并保留事实，不自动切换到未验收控制路径。

## Phase 7 的多游戏与部署 Gate

- 第二个真实游戏只需一个事先冻结的短流程，用于证明通用边界；不是要求复制原神全部能力。能力参数属于各自 schema，没有的能力明确拒绝，不能假成功。
- installed、compatible、enabled、currently_available 分别报告；单包不兼容仅禁用该包。无原神包时 FakeGame 及通用插件仍可运行。
- 同桌面仅一个可控会话；独立 CLI 与 Bellis 争用同会话时拒绝非 owner。跨主机并行不直接证明一个直播人格可同时表现两场游戏。
- 切换游戏先结束/暂停旧活动、确认输入释放、撤销旧绑定，再选新窗口/profile、创建新 Session 并 Arm。旧事件、任务结果、候选、帧和阅读回执不得污染新 Session；清理失败不得交接。
- 跨机先验证配对/加密、epoch 变化、掉线与原操作查询；只传语义目标、有限截图、事件和回执，感知快循环与 Broker 保持靠近游戏。
- 网络失联可以按预先批准策略有限运行，本地输入安全不能等待网络或普通 LLM。准确超时和继续执行边界由 G0 契约确定，并在实机测量。

多 Host 初期采用静态注册和明确目标选择，不建设集群调度器或跨机任务 DAG。多游戏真实并行优先用独立主机；任何其他隔离环境须验证桌面、GPU、捕获和设备资源。

## Phase 8 的发布与安装 Gate

Bellis 与游戏平台发布独立应用；组合安装向用户隐藏 Node/Python/npm/编译步骤。Bellis 包含自己的 Node Runtime；游戏平台包含经过验证的 Python 环境、Core/Host、原生 Broker 与选定 Game Pack。大型模型/录屏通过受管资源与 artifact 分发，仓库保存来源、许可、哈希及小型夹具。

应用组合清单锁定 Runtime、Broker、Adapter SDK、Game Pack、模型、Game Client、Bellis SDK 和薄插件实际验证的版本与哈希。发布验收移除相邻源码、editable/link 和不可解析 workspace 依赖；CI tarball/wheel 已可用于早期 Gate，不要求提前公开发布。

managed 只启动已安装、固定清单、哈希/签名核验的 Runtime 应用；连接后沿用 attach 协议。ProcessManager 受 Activity/宿主生命周期控制，普通 Turn 结束不杀进程；模型不能提供 Shell、任意可执行路径或 SSH 命令。游戏本体登录、选窗、未确认存档/交易的退出，首版可保留人工步骤。

旧 Session 固定其包/模型组合；更新在受控停用后进行，失败回滚不能违反数据库 Migration 兼容性。真实 OBS Browser Source 要验证透明背景、音频、WebGL/AudioWorklet 与游戏同机负载；CI 构建通过不能代替这些 Gate。

单个 Game Pack 迁往独立 Git 仓库是按需治理动作，**不设为必做 Phase 9**。仅在团队、权限、许可或维护节奏确实独立时启动；保持包名、entry point、Adapter API 和运行协议，独立发识别修复包不要求拆仓。

## 外部条件与用户支持

| 最晚到位阶段 | 需要的条件 | 可由工程自动完成的部分 |
| --- | --- | --- |
| Phase 5 G0 | 确认游戏平台最终仓库名、创建/访问权限；取得 v0.3 或明确批准替代的契约规格 | 规划、接口草案、FakeGame、包结构与测试；缺原文时先列语义缺口 |
| Phase 6 真机 | 可访问的 Windows 11 交互桌面、原神安装/测试账号、固定界面配置、允许测试的场景及操作者 Arm | 工具链、捕获/输入端口、测试脚本和日志；不自动处理验证码或账号确认 |
| Phase 6 真实表现 | 模型/TTS 的可用端点与本机凭据配置、测试预算、可使用的角色/识别资源 | 适配器和确定性替身；重模型要求实测后再定，不提前要求 GPU 型号 |
| Phase 7 | 第二款真实游戏的短流程与访问条件；跨机试验的第二台机器和配对网络 | 同协议客户端、静态连接注册、断线/隔离测试 |
| Phase 8 正式发行 | 发布身份、正式签名能力、分发位置/权限及资源许可范围 | 开发签名、打包/回滚/安装自动化；正式发布另按授权执行 |

Iris 沿用现有独立实例或隔离测试安装，不新增一份游戏专用记忆服务。账号密钥不进源码或能力清单。只有使用现有外部服务时才需要其地址与凭据，不以购买新基础设施作为开工条件。

## 执行入口与收尾规则

Phase 5 使用 [构建指南](./phase-5-development-guide.md)。各 Phase 开工先固定范围与命名 Gate，运行对应现有基线；新增命令必须真正实现后才写入可执行命令索引。Phase 5+ 测试结果不混入 Phase 4A 的 480 个用例。

按可验证切片提交，在已授权的分支推送；摘要替换同主题旧结果，完整日志归 artifact。缺外部条件时完成可独立工作并保留未运行项，不将部分 Gate 称作全阶段完成，不自动追加第二款之外的游戏或所有可能恢复组合。
