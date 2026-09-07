# 通用游戏 Runtime：多游戏仓库、发布与部署方案

版本：设计补充 v0.4  
日期：2026-09-07  
适用基线：`GAME_AGENT_RUNTIME_BELLIS_SDK_DESIGN_v0.3.md`  
状态：待实现的工程设计；本文不表示新仓库、SDK、服务接口或适配包已经建立、发布或通过运行验收。

## 0. 结论与修订范围

推荐采用：**Bellis 独立仓库 + 通用游戏平台独立仓库；游戏平台内部按包组织 Runtime、游戏适配、客户端 SDK 与 Bellis 薄插件；成熟适配包以后按需迁出仓库。**

本次游戏集成主要涉及两个代码仓库。Iris Memory Core 继续保持原来的独立项目地位，不合并、不复制，也不因新增游戏而新增一份记忆服务。

代码仓库、发布包、运行进程和机器不是一一对应关系。一个仓库可以发布多个包；同一个 Runtime 版本可部署到多台机器；每款游戏独立发适配包，不意味着必须各自运行一套长期服务或创建一个新仓库。

本补充细化或替换 v0.3 的第 19、21、24、34 节相关部署、扩展、目录与发布安排。以下原有边界继续有效：

- Agent 异步规划，Runtime 掌握执行合法性、任务调度与检查点提交；战斗不等待普通 LLM 回复。
- 有依赖的任务顺序执行，资源兼容的观察、计算任务可以并行；领域控制器不直接争抢键鼠。
- Bellis 的长期 Session Activity 与单次 Turn/Scene 分开；游戏任务及其尝试由游戏 Runtime 管理。
- 集成模式下 Bellis 统一语音与 Iris 写入；独立运行模式可以使用可选适配，但不得同一会话双写或双重播报。
- 代码/模型升级与运行中的任务图更新分开，不任意热加载代码。

本次新增的重要修正：**同一交互桌面的物理输入争用，必须在主机／桌面层仲裁，不能仅按 game_session_id 分别加锁。**

本文所有目录名、包名、命令、端点和配置均为建议设计。展示的第二个游戏用 `second-game` 占位，不代表已实现某款游戏支持。

---

## 1. 四类边界必须分别决策

| 边界 | 决策问题 | 本项目的建议 |
|---|---|---|
| Git 仓库 | 谁一起改代码、审查和管理权限？ | Bellis 与游戏平台分开；自有游戏适配先同仓 |
| 发布包 | 用户安装什么，哪些组件能独立升级？ | Runtime、游戏包、TS Client、Bellis 插件独立产物 |
| 运行进程／环境 | 哪些部分需要性能、依赖或故障隔离？ | Bellis、Runtime、原生 Broker、重计算 Worker 分离 |
| 机器／交互桌面 | 延迟与物理输入归属在哪里？ | 控制闭环靠近游戏；慢规划可远程 |

“增加一个游戏”的正常成本应该是新增适配包、资源与测试，不是复制 Runtime 和 Bellis 插件。

“依赖冲突”的优先解决办法是独立环境／Worker，不是立即新建代码仓库。

“同一仓库”的含义是协作与版本管理方便，不是要求一个超大的安装包、一个 Python 环境或一个进程加载所有游戏。

## 2. 推荐的仓库布局

```text
leafliber/
├── bellis/                         已有宿主仓库
├── game-agent-runtime/             建议新增：通用游戏平台
└── iris-memory-core/               既有记忆项目，名称按实际仓库为准
```

`game-agent-runtime` 只是暂定仓库名。应使用通用名字，不以 `genshin` 命名整个项目，也不把平台根目录命名为某款游戏的 Bellis 插件。

### 2.1 Bellis 仓库拥有的内容

- 人格、Decision Loop、ActionFrame、Scene Director、直播表现。
- 通用 Plugin SDK 和 GameProvider/Session Activity 等宿主侧契约。
- 插件生命周期、可信连接注册、会话活动所有权、宿主权限。
- Signal、Context、Observe/Memory 等宿主接入面。
- 一个通用游戏连接管理入口，而不是每款游戏新增一套核心业务代码。

Bellis 不拥有原神的技能循环、识别模板、地图、任务攻略、键鼠 Broker 或游戏任务 DAG。

公开仓库目前采用 `apps/`、`packages/` 和 pnpm workspace 结构；通用 SDK 与本文新接口仍需按 v0.3 完成并验收，不能由目录存在推定功能已经交付。[S1][S2][S3]

### 2.2 游戏平台仓库拥有的内容

- Runtime：任务图、资源管理、领域控制器生命周期、恢复、候选计划和热更新。
- Game Adapter SDK：游戏适配需要遵守的公共接口。
- 游戏包：原神、未来第二个游戏及各自资源、模型索引、能力和场景测试。
- Runtime Host：服务 API、配置、注册、会话管理、进程监督。
- Game Client SDK：面向远程宿主的类型化语义客户端。
- Bellis 薄适配插件：唯一依赖 Bellis SDK 的游戏侧发布包。
- 平台采集、原生 Input Broker、输入看门狗、局部 IPC。
- 独立 CLI／面板、发布清单、回放与一致性测试。

### 2.3 什么时候新增独立游戏仓库

有下列明确需求时，再把某个适配包迁出：独立维护团队、显著不同的发布节奏、仓库级访问权限隔离、独立许可或资产管理要求、第三方贡献边界。

没有这些需求时，新增游戏包目录即可。两三个自维护游戏不是自动拆库的理由。

大型模型或录制数据应移到合适的资产存储，不能只为它们建立一个复制 Runtime 的“游戏仓库”。

## 3. 游戏平台内部目录

以下是目标职责布局；可以分阶段创建，不要求第一天生成所有目录。

```text
game-agent-runtime/
├── apps/
│   ├── runtime-host/                    Python 服务与组装入口
│   │   ├── pyproject.toml
│   │   └── src/game_runtime_host/
│   └── operator-console/                可选本地面板；先用 CLI 也可以
│
├── packages/
│   ├── python/
│   │   ├── runtime-sdk/                 公共数据契约 + Adapter Ports
│   │   │   ├── pyproject.toml
│   │   │   └── src/game_runtime_sdk/
│   │   │       ├── contracts/
│   │   │       ├── controllers/
│   │   │       ├── observations/
│   │   │       └── adapters/
│   │   └── runtime-core/                不依赖任何具体游戏的执行引擎
│   │       ├── pyproject.toml
│   │       └── src/game_runtime_core/
│   │           ├── scheduling/
│   │           ├── resources/
│   │           ├── lifecycle/
│   │           ├── plans/
│   │           ├── state/
│   │           └── recovery/
│   └── typescript/
│       ├── game-client/                 游戏服务 Client SDK
│       └── bellis-plugin-game/          依赖 Bellis SDK 的唯一薄插件
│
├── games/
│   ├── genshin/
│   │   ├── pyproject.toml
│   │   ├── src/game_pack_genshin/
│   │   │   ├── plugin.py
│   │   │   ├── perception/
│   │   │   ├── capabilities/
│   │   │   ├── controllers/
│   │   │   │   ├── combat/
│   │   │   │   ├── navigation/
│   │   │   │   ├── dialogue/
│   │   │   │   └── gui/
│   │   │   ├── state_extensions/
│   │   │   └── policies/
│   │   ├── manifests/
│   │   ├── assets/                      小型、可再分发资源
│   │   ├── model-manifests/             模型哈希／许可证／来源索引
│   │   └── tests/
│   ├── fake/                            必做：无真实输入的契约适配
│   └── second-game/                     未来按实际需要新增
│
├── platforms/
│   └── windows/                        Windows 采集和平台端口实现
├── crates/
│   └── input-broker/                   主机级输入与看门狗
├── worker-profiles/                    可选：独立重模型环境及锁定清单
├── protocol/
│   ├── openapi.json                    从公共模型生成，不手工双写
│   ├── schemas/
│   └── fixtures/
├── profiles/                           可分享配置示例，不含令牌
├── release/
│   ├── manifests/
│   └── compatibility/
├── tests/
│   ├── architecture/
│   ├── contracts/
│   ├── fake-runtime/
│   ├── pack-install/
│   └── integration/
└── docs/
```

`runtime-core` 不允许 import `game_pack_genshin`。游戏包不允许读取 Core 私有队列或直接修改 Broker 令牌。

可复用 UI 检测、行为树节点等先作为边界明确的内部模块；至少在不同游戏中验证相同语义后，再抽成公共能力包。不要把原神的队伍元素、冷却或任务系统直接重命名为“通用”。

## 4. 依赖方向与三个 SDK 接口面

v0.3 的两个 SDK 继续存在；多游戏扩展明确增加 Adapter SDK 接口面，**不新增第三个 SDK 仓库**。

| 接口面 | 归属 | 消费者 | 作用 |
|---|---|---|---|
| Bellis Plugin SDK | Bellis | bellis-plugin-game | 宿主生命周期、Provider、Signal、Activity 等 |
| Game Client SDK | 游戏平台 | Bellis 插件、CLI、其他宿主 | HTTP 语义命令、查询、事件流、对账 |
| Game Adapter SDK | 游戏平台 | genshin 等游戏包 | 控制器、感知、状态扩展、资源和上下文接口 |

```text
bellis-plugin-game
   ├── 依赖 Bellis Plugin SDK
   └── 依赖 Game Client SDK
               └── 调用 Runtime 的网络服务

runtime-host
   ├── 依赖 runtime-core
   ├── 依赖 runtime-sdk
   └── 发现／装配经过授权的游戏包

runtime-core ────────→ runtime-sdk
游戏包 ─────────────→ runtime-sdk
平台实现 ───────────→ 相应公共端口／Broker 协议
```

网络调用关系不是 Python/TS 源码导入关系。Bellis 不安装 Python 游戏包；游戏包不安装 Bellis；TS Client 不依赖 Bellis 私有类型。

公共 Python 契约以 `runtime-sdk/contracts` 为源；服务 OpenAPI、JSON Schema 与 TS 类型从这套定义生成。Bellis 宿主契约继续留在 Bellis，由薄插件显式映射，不形成第三份手写共享 Schema。

## 5. 一个游戏包应该包含什么

游戏包不是“再做一个 Agent Runtime”，而是对通用端口的实现与经过验证的游戏知识。

| 内容 | 原神示意 |
|---|---|
| 识别与上下文 | 世界、角色菜单、地图、正式对话、过场、未知弹窗 |
| 状态扩展 | 元素、队伍槽、能量、任务标记等游戏特有状态 |
| 观测实现 | UI 局部识别、目标跟踪、剧情采集和时序事件 |
| 控制器 | 战斗、路径规划、路线跟踪、角色配置、对话交互 |
| 能力清单 | 当前已经实现且账号实际可用的能力 |
| 策略模板 | 固定任务链、角色策略、保守恢复模板 |
| 模型与资源索引 | 版本、资源哈希、许可、所需推理环境 |
| 验收场景 | 功能、取消、恢复、资源、输入交接和真实效果测试 |

需要分别表达四种状态：`installed`（安装）、`compatible`（兼容）、`enabled`（启用）、`currently_available`（当前具备）。装了游戏包，不代表当前窗口可以操作，也不代表账号具备包内全部功能。

### 5.1 能力发现，而不是对所有游戏强推同一套功能

外层统一任务、结果、授权、事件和生命周期。内层能力按游戏声明：

```text
genshin.combat.engage
genshin.navigation.follow
genshin.party.configure

second_game.navigation.follow
second_game.crafting.perform
```

点分名称是 Runtime 的控制器／能力 ID，不是直接注册为 Bellis 模型工具名。Bellis 可以只注册少量通用查询和计划准备工具，再从当前绑定会话获取能力目录。

参数由各能力的 schema 约束。没有 `party.configure` 的游戏不应返回假成功或提供空实现；在规划阶段拒绝不支持的能力。

### 5.2 静态清单示意

下例是待实现的清单结构；占位符应在构建时替换，不能直接拿去发布。

```yaml
manifest_schema: game-pack/1
adapter_id: org.leafliber.genshin
game_id: genshin
package_version: "${PACKAGE_VERSION}"
requires:
  adapter_api_major: 1
  platform_backends: [windows-desktop]
  action_backends: [keyboard-mouse]
  observation_backends: [window-capture]
entry_point: game_pack_genshin.plugin:create_plugin
capability_catalog: manifests/capabilities.json
support_profiles: manifests/support-matrix.json
asset_manifest: model-manifests/assets.json
```

`support-matrix` 记录实际验收的游戏版本、界面语言、分辨率／缩放、输入方式和功能范围。不能只写一个宽泛版本范围就等同于全部场景已验证。

### 5.3 发现机制

Python 侧建议采用包元数据 entry points。PyPA 官方支持通过包元数据声明插件并由 `importlib.metadata.entry_points()` 发现。[S4]

```toml
[project.entry-points."game_runtime.games"]
genshin = "game_pack_genshin.plugin:create_plugin"
```

发现后先读取静态信息并验证来源、版本、哈希与允许列表，再加载当前选定包。不要扫描所有安装包后自动执行其代码。

entry points 是发现机制，不是安全沙箱。受信插件也要接受资源／生命周期约束；不受信代码需要额外进程和权限隔离，不能靠 manifest 自称“只读”。

## 6. 平台、动作后端与游戏适配分离

```text
运行时通用逻辑
    ↓
游戏包：画面语义、能力、策略
    ↓
平台端口：窗口、捕获、坐标、权限
    ↓
Input Broker：唯一受控设备输入
```

Windows 捕获不能写进 `GenshinCombatController` 的通用算法。未来某游戏使用手柄、其他操作系统或明确授权的 API，应替换平台／动作端口，而不是 fork Runtime。

首版只实现经过验证的 Windows 画面与键鼠路径。未来确实接入官方授权 API 时，可将最终操作审计扩展为 Action Gateway，设备输入仍由原 Broker 管理。API 副作用也必须有授权、任务归属、超时和结果确认；不能作为绕过权限的第二通路。

本补充不假定任何具体游戏已提供适用 API，也不以修改客户端或规避保护作为兼容方案。

## 7. 独立发布，不等于立即拆仓库

### 7.1 最小发布产物

| 产物 | 形式 | 安装位置 |
|---|---|---|
| Bellis Plugin SDK | npm 公共包 | Bellis 插件构建／宿主环境 |
| Runtime Host + Core + Broker | 平台应用安装包 | 游戏机器 |
| Game Adapter SDK | Python wheel／公共开发包 | 游戏包开发与运行环境 |
| Genshin Game Pack | Python wheel + 受管资源 | 游戏机器 |
| Game Client SDK | npm 包 | Bellis 插件或其他客户端 |
| bellis-plugin-game | npm 插件包 | Bellis 机器 |
| 重模型 | 校验后的独立资源或 Worker bundle | 需要它的游戏机器 |

面向开发者发包，面向普通用户发经过验证的应用组合。普通用户不应为了运行一个游戏，被迫理解三种包管理器或手动编译 Broker。

### 7.2 初期版本策略

可以采用协调发布：Runtime/Core/Adapter SDK 为一组，Genshin 包有自己的版本；TS Client 与 Bellis 插件分别记录兼容范围。发布包版本可以独立，不必所有数字永远同步。

应用发行附带一份组合清单，锁定本次测试实际使用的 Runtime、Broker、游戏包、模型、Client、Bellis SDK 和插件版本与哈希。

仅游戏识别资源变动且协议未变时，只更新对应 Game Pack 与应用组合记录，不要求重新发布 Bellis。新增了线协议能力时，则更新服务、Client／插件相应支持范围。

### 7.3 大文件和运行数据

仓库保存小型可合法分发资源、清单、生成脚本和小型测试样本。大模型、长录屏、地图数据库等通过受管资产包分发，保存哈希、许可、来源与兼容性。

账号凭据、令牌、用户存档、运行中的 SQLite、帧缓存和完整直播记录不进源码仓库。

## 8. 多语言工作区与依赖冲突

TypeScript 包可采用 pnpm workspace，游戏仓库与 Bellis 仓库分别维护自己的工作区与锁文件。pnpm 支持同仓多包，并在正确的打包／发布流程中把 `workspace:` 依赖转换为普通版本依赖。[S5]

开发时允许同仓 `workspace:` 和临时跨仓 link。正式安装包不得包含相邻源码目录、不可解析的 workspace 路径或对未发布私有包的依赖。

Python 核心与轻量适配可以用 uv workspace。uv workspace 通常共享一份锁文件，并不意味着每个游戏自动拥有隔离的依赖环境。[S6]

因此按下列顺序处理依赖：

1. 第一款游戏：一套经过验证的轻量开发环境，重模型放 Worker。
2. 多款游戏且依赖兼容：继续同一 workspace，运行时只激活所需模块。
3. 依赖冲突：将冲突模型放到独立 Worker 环境，或给该游戏 Runner 建立单独部署环境和锁定清单；可以仍在同一 Git 仓库。
4. 仅在维护和权限边界也独立时迁出代码仓库。

不要把所有未来游戏、CUDA/PyTorch 组合和平台包无条件纳入同一个 `**` workspace 成员集合。独立 Worker 环境应明确排除于不适用的共同依赖求解中，并通过公开 IPC 传结果。

无论多少 Worker，都不能各自拥有无管理的真实输入出口。

## 9. 运行单元：一个 Host、多种 Game Pack、按需 Session

推荐的游戏机器结构：

```text
Runtime Host
  ├── API / 配对 / 能力发现
  ├── Session Manager
  ├── Task Execution Engine
  ├── 当前选定 Game Pack
  ├── Capture / Vision / Path Workers
  └── Input Broker + Watchdog
```

初期一个 Host、一个活跃控制会话就足够。多个游戏包可以安装，但不要求同时加载所有模型和控制器。

Session 是一次明确绑定的游戏运行上下文，不是源码仓库，不是包版本，也不是账号。它应包含：

- host 与 runtime instance 的身份；
- game_id、adapter_id/version、game_session_id；
- 操作员确认的窗口／目标与平台配置；
- profile/save scope 等本地不敏感标识；
- 已校验能力与模型版本；
- 任务、事件、剧情、证据和操作日志命名空间。

未来需要隔离依赖或提升故障隔离时，可增加 Session Worker/Runner 进程。每个会话内部仍只有一个权威任务执行引擎；Host 只做会话生命周期和跨会话资源分配，不复制会话 DAG。

## 10. 四种部署组合与选择

### 10.1 同机、独立进程：首个正式联调目标

```text
Windows 游戏机器
  Bellis + bellis-plugin-game
               │ 回环 HTTP / SSE
               ▼
  Game Runtime Host → 控制器 → Broker → 游戏
```

优点是链路容易定位；限制是游戏、推理、直播和 Bellis 共享计算资源。仍需完整直播负载测试。

“同机”也通过服务协议连接，不把 Python Runtime 嵌进 Bellis Node 事件循环。

### 10.2 Bellis 与游戏分机：适合开发机和游戏机分离

```text
机器 A：Bellis / 直播决策 / 薄插件
               │ 已配对的加密语义接口
               ▼
机器 B：Runtime + 快速感知 + Broker + 游戏
```

只有目标、计划、有限截图、事件和回执跨机。快控制不走 A→B 的逐帧往返。B 本地具备受授权的有限断连策略。

Iris 可以部署在 A、B 或独立服务，但集成模式下的写入权仍由 Bellis 管理。

### 10.3 多台游戏机器：以后扩展

```text
Bellis 的一个通用游戏插件
  ├── 已注册 Host A → 某游戏 Session
  └── 已注册 Host B → 另一游戏 Session
```

初期静态配置多个连接和明确选择目标即可，不需要先引入集群调度器、服务发现平台或跨机任务 DAG。

每台主机负责自己的物理资源。Bellis 的一个人格和一个直播语音通道还有独立的表现调度问题，不能把“多机可以控制”直接等同于“一个人格能够同时清楚直播两场游戏”。

### 10.4 游戏独立运行

```text
独立 CLI / 面板 / 测试规划器
               │ Game Client API
               ▼
         同一个 Runtime Host
```

Bellis 插件不是 Runtime 启动的必要依赖。独立运行与 Bellis 运行应共享同一服务协议、任务和授权语义，不另写一套执行器。

同一会话最多一个上层控制 owner；其他客户端只能观察。独立 CLI、Bellis 和调试工具不能同时写同一会话。

## 11. 启动方式：先 attach，再 managed

### 11.1 attach（首版默认）

由游戏应用启动器启动 Runtime 与 Broker，操作员在本地选择游戏包和窗口。Bellis 插件只连接已配对服务，不负责下载和启动未知程序。

建议启动顺序：安装已验证组合 → 游戏主机启动 Runtime → 操作员打开／确认游戏窗口 → 选择 profile 与 Game Pack → Bellis 连接并协商 → 创建/绑定会话 → 本地允许控制 → 提交 Activity。

启动游戏本体是否支持自动化由可选的受信 Launcher 能力决定；初期人工打开游戏即可。选择游戏不等于允许任意 Shell 或自动绕过登录、验证码、授权确认。

### 11.2 managed（后续产品化）

Bellis 通过受控 ProcessManager 请求启动**已安装、哈希／签名验证、固定清单中的**游戏 Runtime 应用。连接后仍走与 attach 相同的服务接口。

进程生命周期归 Session Activity/宿主策略，不归每条聊天 Turn。普通对话取消不能误杀长期游戏进程。

不使用“模型给出命令字符串，由插件执行”的方式管理游戏或 Runtime。远端进程也不由本机插件随意拼 SSH/Shell 控制。

### 11.3 不推荐作为首版边界的方式

不把所有游戏 Worker 微服务化；不把 CLI stdout 作为长期游戏活动唯一协议；不让 Bellis 的临时 Tool 子进程承载整场游戏；不强迫游戏捕获和输入运行在与交互桌面脱离的容器中。

容器是否适合模型或存储等后台服务可以独立评估，不能作为自动解决桌面捕获、GPU和输入权限的手段。

## 12. 通信矩阵与协议所有权

| 连接 | 推荐方式 | 不通过此连接做什么 |
|---|---|---|
| Bellis ↔ 薄插件 | 正式 Plugin SDK，受信生命周期 | 不运行战斗 tick |
| 薄插件 ↔ Runtime Host | HTTP JSON/OpenAPI + 带游标 SSE | 不实时流式控制每个按键 |
| Runtime ↔ Game Pack | 公共 Adapter SDK，本地函数／受控 Worker IPC | 不绕过资源分配 |
| Runtime ↔ Input Broker | 本地受认证 IPC、明确 deadline | 不暴露为匿名网络键鼠口 |
| Capture ↔ Vision/Controller | 有界帧缓存／共享缓冲／本机接口 | 不在普通 JSON 总线堆积帧 |
| Runtime 事件 ↔ Bellis 表现 | 事件及受确认的阅读回执 | 不让 Game Pack 自行播放第二路 TTS |
| Bellis ↔ Iris | 既有公共 Memory Provider/SDK/API | 不共享两个项目的数据库文件 |

SSE 用于服务端向客户端发送事件，命令与阅读回执走 HTTP。未来只有出现明确双向高频需求时再评估 WebSocket；不能维护两套语义不同的并行控制协议。

沿用 v0.3 的稳定 operation_id、accepted/applied/completed 分离、快照水位、事件去重与 cursor_expired 处理。网络超时进入对账，不生成新 ID 重复执行同一次资源操作。

## 13. 多游戏服务入口：一个插件，多种会话

以下端点是对 v0.3 的拟议增量，不是现成 API：

| 接口 | 用途 |
|---|---|
| `GET /v1/handshake` | 协议、Host 身份、runtime epoch、支持的语义功能 |
| `GET /v1/games` | 列举已安装、兼容、启用的游戏适配；不暴露秘密 |
| `POST /v1/sessions` | 基于已批准 profile 创建游戏会话，默认不 Arm |
| `GET /v1/sessions/{id}/capabilities` | 该会话目前真实可用的能力与 schema |
| v0.3 的候选、操作、活动、事件接口 | 继续使用，不为每款游戏复制一套路由 |

`game_id` 可以作为创建会话时的选择，不能成为独自足够的路由或授权键。命令应绑定：

```text
registered_connection_id
verified_host_id / runtime_epoch
game_session_id / binding_id
authority_epoch
operation_id
```

可信宿主和连接注册表负责解析地址与身份；LLM 只选择授权范围内的会话／能力，不能提供任意 URL、端口、可执行路径或私有令牌。

插件可以维护多个已配对连接，但同一交互会话的控制 owner 由服务侧再次验证。读接口授权不自动转换成控制授权。

## 14. 主机级输入独占：多游戏最容易遗漏的约束

Windows 键盘输入与焦点／前台线程有关，而不是任意传入 game_session_id 就自动路由到对应窗口。两个窗口不能据此认为拥有相互隔离的物理键鼠通道。[S7][S8]

因此增加父级资源：

```text
host/<host_id>/desktop/<desktop_id>/foreground-input
                  │ 独占，至多一个游戏会话持有
                  ▼
game/<game_session_id>/foreground
                  │ 独占，至多一个根控制器持有
                  ▼
授权范围内的内部移动、镜头、攻击技能
```

本地 Broker 是主机／交互桌面的权威，独立 Runtime 实例必须经同一个 Broker 或受平台确认的独占机制；不能让不同进程各自维护一把自以为独占的锁。

第一版建议直接限制同一交互桌面只有一个可控游戏会话。多个包可以安装、多个只读后台任务可以运行，不代表两个游戏都能同时主动控制。

未来真正要并行运行两个游戏，优先选择两台主机；其他隔离环境必须分别验证捕获、设备、GPU与输入边界。API 控制等不共享前台设备的后端，也应按实际资源冲突单独建模，不能直接继承“互不影响”的假设。

### 14.1 这不是第三套战斗调度器

Bellis 选择哪个长期游戏 Activity；Host 分配哪一会话可以占用桌面；会话内 Task Engine 安排控制器；控制器完成实时动作。每层调度不同对象，不能重复维护同一个任务图。

## 15. 切换游戏与热更新不是同一件事

同一游戏内修改打法或未来任务：沿用检查点局部热更新。

原神切到另一个游戏：**明确结束／暂停旧会话，重新绑定一个新会话**，不能在原神的活动实例内随意替换 GameAdapter。

```text
请求切换
 → 旧活动在授权边界暂停／结束
 → 清理旧输入、撤销旧上下文授权
 → 刷新任务和副作用记录
 → 保留需要的日志与剧情进度
 → 确认 Host 前台资源已释放
 → 装载新游戏包／启动所需 Worker
 → 操作员确认新窗口、profile 与权限
 → 新 game_session_id 与控制授权
 → 获取新状态与能力
 → 提交新 Activity
```

清理失败时不把输入交给新会话。不能为“自动换游戏”强行关闭有未确认存档或交易状态的旧游戏；退出、保存和启动都属于有边界的可选能力，初期保留人工步骤。

若只是同游戏包新版本，旧 Session 固定使用启动时验证的代码和模型集合；在受控停用后升级。不要把轮询文件更新变成在战斗中替换整个 Python 模块。

## 16. 数据、模型与权限的多游戏隔离

建议运行数据放在可配置应用数据目录，而不是仓库目录：

```text
<app-data>/game-runtime/
├── host/                    Host 身份、配置与本机元数据
├── installed/               受管理的包版本记录
├── models/<digest>/         按哈希寻址的可共享模型资源
├── games/<game_id>/
│   └── profiles/<profile_id>/
│       ├── sessions/<session_id>/
│       │   ├── events/
│       │   ├── evidence/
│       │   └── recordings/
│       └── calibrations/
└── logs/
```

数据库可以使用每会话文件，也可以使用同一服务拥有、严格带命名空间的数据库；不允许 Bellis 直接打开游戏 SQLite，或另一游戏 Adapter 任意读取前一个游戏的证据。

Iris 的长期经历应带 `game_id/profile_scope/session_id/entity_scope` 等来源。不同游戏的同名角色不能仅凭姓名自动合并成同一实体。

模型资源只有哈希、来源、许可与适用范围都匹配时才共用。账户信息和操作密钥放入安全配置，不通过能力清单进入模型上下文。

## 17. 兼容矩阵与联合发布

不要只比较所有包的数字是否相同，应区分下列兼容面：

| 兼容面 | 验证方式 |
|---|---|
| Bellis ↔ 插件 | Plugin SDK、GameProvider 和 Activity 契约测试 |
| 插件 Client ↔ Runtime | 线协议 major、支持特性、schema fixtures |
| Runtime ↔ Game Pack | Adapter API、控制器生命周期、状态扩展校验 |
| Host ↔ Broker | 本地协议、撤权、迟到命令、按键清理 |
| Game Pack ↔ 游戏 | 版本／页面／语言／能力场景测试 |
| Game Pack ↔ 模型 | 输入输出结构、资源哈希与推理配置 |

应用组合清单锁定实际验证版本。SemVer 范围描述兼容意图，真实验收矩阵给出测试证据；不能只因 major 相同就认为角色技能与页面检测均可用。

Agent 动态获取的能力清单只展示已验证支持且当前可用的功能；模型不支持的新能力不能仅因 schema 存在而开放。

## 18. CI 与跨仓库开发方式

### 18.1 各自仓库独立可构建

Bellis CI 不需要检出游戏源码才能构建宿主；游戏 Core CI 不需要安装 Bellis 或原神才能运行模拟和契约测试。

游戏包可以同仓开发，但必须通过公开 SDK import；增加架构检查，拒绝访问 Core 内部调度器或其他游戏包的私有状态。

### 18.2 联调使用产物，不靠路径巧合

本地开发允许相邻检出、editable install 和 link，但发布验收必须使用：

```text
Bellis SDK / contracts 打包产物
＋ 游戏 Client / 薄插件 npm 产物
＋ Runtime / Broker 平台构建产物
＋ Game Pack wheel / 资源清单
```

在没有两个源码目录的干净 consumer 环境完成注册、查询、Activity 启动、取消、恢复和事件游标测试。

公共 SDK 尚未正式发布时可用 CI 产出的 tarball/wheel，仍然验证包边界；不把“必须上公网包仓库”作为第一步前提。

### 18.3 必测多游戏场景

- 未安装原神包时，Runtime 和 Bellis 插件仍可启动并使用 FakeGame。
- 添加第二个游戏包无需改 Bellis 游戏核心路由或复制 TS 插件。
- 原神包不兼容时只禁用该包，不把整个宿主标为全部不可用。
- 两个游戏尝试获得同一桌面输入时，只能一个被准入。
- 独立 CLI 与 Bellis 同时写同一会话时，拒绝非 owner。
- 旧游戏事件、旧路线结果与旧输入不能污染新游戏会话。
- 目标版本、adapter版本、runtime epoch 变化后的候选必须重新验证。
- 重模型环境冲突不迫使 Core 引入该依赖，也不产生第二个输入 Broker。
- SSE 重连可对账，有事件缺口时明确报告，不隐瞒丢失剧情。
- 同机与跨机采用同一语义协议并通过相同操作状态测试。

## 19. 从当前方案迁移的实际顺序

### 第一步：先明确两个仓库的公共契约

继续 v0.3 的 Bellis SDK、GameProvider、Session Activity 改造。游戏仓库先提供 FakeRuntime/FakeGame 与 TS Client，完成正式插件路径联调。

### 第二步：现在就把原神放到包边界

将 v0.3 的 `src/game_runtime/games/genshin` 调整为可独立构建的 `games/genshin`。同时保留 Runtime Core、平台实现和公共 Adapter SDK 的单向依赖。

若尚未实现，直接按新布局起步；若已经有代码，先移动与测试公开接口，不与算法重写混在一个迁移里。

### 第三步：交付一个 Host、一个前台会话

首版只要求 Runtime 加载原神或 FakeGame 中选定的一个；实现主机输入父锁。不要提前投入多活集群或远端 Runner 调度。

### 第四步：原神纵向闭环与固定完整任务链

保持前序路线：先无 LLM 战斗，再剧情／导航／GUI 和局部编排更新。所有新能力放入 Genshin Game Pack，调度与资源机制留在 Core。

### 第五步：增加第二个真实游戏验证抽象

第二个游戏优先承担检验接口的任务，不要求一开始具备与原神同等广度。选择实际可验收的短流程，检查是否需要修改 Bellis、复制 Runtime 或滥用原神字段。

若通用协议确实缺少能力，先定义有语义的扩展并做兼容测试，而不是通过通用字符串逃逸接口传任意代码。

### 第六步：按真实需求独立发包／迁出仓库

接口稳定且维护者独立后，再将某个 Game Pack 移到 `game-pack-<game>` 仓库。迁移保持包名、entry point、Adapter API 和运行协议不变；Core 通过安装包发现，不感知 Git 地址。

如果只需要独立发一个识别修复版本，直接同仓发适配包即可，不必迁出。

## 20. 本次应写入 v0.3 的正式变更

| v0.3 位置 | v0.4 补充 |
|---|---|
| 第 19 节语言／部署 | 代码边界与部署边界分开；一个 Host 支持按需游戏 Session |
| 第 21 节 GameAdapter | 明确公共 Adapter SDK、清单、能力发现、平台端口 |
| 第 24 节游戏仓库目录 | Genshin 从 Core 私有目录迁为独立包；同仓 Client 与插件保留 |
| 第 9／11 节资源与输入 | 增加 Host/desktop 级父资源，所有游戏共享唯一 Broker 权威 |
| 第 33 节服务协议 | 增加游戏目录与会话创建；命令绑定真实 Host、Session、Authority |
| 第 34 节发布 | 加入 Game Pack、模型和应用组合清单的兼容矩阵 |
| 第 18 节 Bellis 接入 | 一个通用插件支持多种适配与已配对 Host，不按游戏复制插件 |
| 第 23 节测试 | 增加多游戏状态隔离、抢占、跨仓产物安装与第二游戏验收 |

其他实时调度、任务状态、阅读回执、结果确认与有限失联行为继续沿用 v0.3，不因拆包而放宽。

## 21. 最终选择表

| 问题 | 当前选择 | 以后何时改变 |
|---|---|---|
| 是否立即每游戏一仓库？ | 否，同仓独立 Game Pack | 独立团队、权限、许可或发布治理需求 |
| 是否每游戏一个 Bellis 插件？ | 否，一个通用薄插件 | 只有宿主协议真的不同才评估其他插件，不按游戏标题拆 |
| 是否一个 Python 环境装所有游戏？ | 否，先轻量统一、重依赖 Worker 化 | 冲突时独立 Runner 环境，不必拆 Git 仓库 |
| 是否 Bellis 与 Runtime 同进程？ | 否，同机也走服务边界 | 不为减少一次本地请求破坏快慢闭环隔离 |
| 首版怎样连接？ | attach，HTTP + SSE，默认回环 | 跨机配对后仍用同协议；managed 后续再加 |
| 是否需要第三个共享 SDK 仓库？ | 不需要 | 外部治理独立才重新评估 |
| 是否能同机同时打两款游戏？ | 首版不支持，共享桌面单输入 owner | 独立主机或经过验证的不同输入资源 |
| 新游戏要改 Bellis 吗？ | 正常不改业务核心，能力动态发现 | 新公共契约才进行显式兼容升级 |
| 游戏包能否独立发布？ | 可以，与 Git 拆库无关 | 版本稳定后继续按包发布 |
| 游戏切换是否任务图热更新？ | 否，新会话重新识别和授权 | 不通过任意模块热替换越过授权 |

**最后的组织原则：仓库按维护边界拆，发布按安装与兼容边界拆，进程按实时性和依赖隔离拆，机器按输入资源与性能需求拆；不要把这四个选择绑成一件事。**

---

## 22. 来源、事实与设计边界

[D1] 当前对话提供的 `GAME_AGENT_RUNTIME_BELLIS_SDK_DESIGN_v0.3.md`。本文继承其两个外部 SDK、Session Activity、HTTP/SSE、双层心跳、单一语音／记忆写入及公开包边界。

以下官方材料于 2026-09-07 查阅。Bellis `main` 是可变化分支，实施时应固定具体提交并运行当前验收命令。本轮只核对公开源码／文档，不表示已经运行仓库、安装包或完成游戏真机测试。

| 编号 | 资料 | 支持内容 |
|---|---|---|
| S1 | Bellis 根目录与 README | 现有目录、文档交付边界 |
| S2 | Bellis package.json / pnpm-workspace.yaml | 当前工作区与工具配置 |
| S3 | Bellis contracts package.json / ADR 0007 | 私有公共包待整理、长期任务所有权边界 |
| S4 | PyPA Creating and discovering plugins | 包元数据 entry points 发现 |
| S5 | pnpm Workspace | 同仓多包、workspace 依赖发布转换 |
| S6 | uv Using workspaces | workspace 共享锁文件及适用边界 |
| S7 | Microsoft Keyboard Input Overview | 键盘焦点和前台输入归属 |
| S8 | Microsoft SendInput | 输入流提交、平台权限和非任务完成回执 |

```text
[S1] https://github.com/leafliber/bellis
[S2] https://raw.githubusercontent.com/leafliber/bellis/main/package.json
     https://raw.githubusercontent.com/leafliber/bellis/main/pnpm-workspace.yaml
[S3] https://raw.githubusercontent.com/leafliber/bellis/main/packages/contracts/package.json
     https://raw.githubusercontent.com/leafliber/bellis/main/docs/adr/0007-task-ownership-and-runtime-scope.md
[S4] https://packaging.python.org/en/latest/guides/creating-and-discovering-plugins/
[S5] https://pnpm.io/workspaces
[S6] https://docs.astral.sh/uv/concepts/projects/workspaces/
[S7] https://learn.microsoft.com/en-us/windows/win32/inputdev/about-keyboard-input
[S8] https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput
```

上面的目录、服务增量、资源层级、阶段、命名与发布规则是本项目工程建议，不是这些资料已经提供的现成游戏框架。
