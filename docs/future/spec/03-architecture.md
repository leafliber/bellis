## 3. 总体架构

> 冻结的后续阶段设计，不参与生成与校验；现行部分见 [docs/spec/03-architecture.md](../../spec/03-architecture.md)。

### 3.4 领域控制器内部职责

| 职责 | 作用 | 边界 |
|---|---|---|
| PolicyBackend | 在已授权目标下选择短动作；按后端声明复用语义编码、更新视觉状态，必要时对未提交连续候选做有界修正 | 没有自由目标采用、对观众播报、Iris直写或签发输入许可的权力 |
| SemanticActionInterpreter | 将明确的SemanticAction及适用证据编译为受限ControlFrame；检查profile／单位和组合冲突 | 不隐藏定位、候选编辑、重新规划或恢复决策 |
| InputBroker | 校验owner、上下文、时效、去重，提交／清理输入并提供真实已提交前缀 | 不执行模型自由决策；接纳或提交不等于游戏成功 |
| 只读定位适配器 | 基于指定目标和根截图选择区域、定位、回映坐标，产生GroundingResult | 不修改投票赢家、不驱动设备、不签发affordance |
| 恢复诊断职责 | 从既有Goal／Journal／证据形成ReflectionRecord与RecoveryProposal | 不自建权威记忆、不直接回滚世界，不阻塞安全停止 |

持续把目标保持在中央属于闭环控制器；镜头转动一个有限增量才属于动作解释器。界面控制器内部用VLM选择下一步，不等于另开高层Agent：其目标、动作集合、风险范围、费用和退出条件均已经受主控/运行时限制。具体协议见D05系列决定（第2.2节）。

### 3.8 逻辑拓扑

#### 组件关系图

```mermaid
flowchart TB
  P["平台接入"] --> IG["输入门禁／分类"]
  IG --> CH["普通候选：入流等待、不抢占"]
  IG --> ACK["付费致谢账本"]
  IG --> POLL["独立投票引擎"]
  subgraph CORE["Bellis微内核：语义级工作与正式输出"]
    ER["EventReactor／StateProjection"] --> WR["WorkRegistry：Task／Attempt／外部引用"]
    WR --> CTX["当前目标、证据、能力模式、控制质量"]
    CTX --> MAIN["LiveDirector：唯一高层采用"]
    MAIN --> GATE["权限／预算／安全门禁"]
    GATE --> PLAN["静态Plan／检查点计划修订"]
    PLAN --> SCH["就绪调度／资源／Effect／Settlement"]
    GATE --> SD["SceneDirector：流式片段"]
    SCH --> SD
    SD --> SYNC["SyncCoordinator／SpeechArbiter"]
    STOP["本地撤权／软收尾／硬停"]
  end
  CH --> CTX
  ACK --> SCH
  POLL --> ER
  SCH --> PL["辅助规划器：仅候选"]
  PL --> ER
  MAIN -. "受限计算" .-> MODEL["LLM／VLM Provider"]
  PL -. "受限计算" .-> MODEL
  MAIN --> TXT["NDJSON／双文本"]
  TXT --> GUARD["ContentGuard"]
  TXT --> EG["最小外发检查"]
  EG --> TTS["TTS：普通／获批推测"]
  TTS --> QUAR["隔离音频／背压"]
  GUARD --> SD
  subgraph ST["受信Stage：独立Origin"]
    AUDIO["Timeline／AudioWorklet"] --> SUB["审核字幕"]
    AUDIO --> AV["统一Avatar适配"]
  end
  SYNC --> AUDIO
  QUAR -->|"仅匹配正式许可"| AUDIO
  AUDIO --> ER
  SCH --> BR["通用game.bridge：语义接口与只读投影"]
  subgraph GAME["Game Runtime：本地权威，不复制Bellis主控"]
    GR["本地Plan／Task／Attempt／Effect／Settlement"] --> SEL["控制模式／能力覆盖检查"]
    SEL --> WAIT["waitable_step：指定目标—定位证据—单步核验"]
    SEL --> FAST["continuous_local：规则／解耦策略／可选候选修正"]
    SEL --> GAP["unavailable：明确降级／接管"]
    CAP["Capture／状态／Narrative服务"] --> LOC["只读定位：根观察／ROI／目标回映"]
    LOC --> WAIT
    CAP --> FAST
    CACHE["后端局部计算缓存：稳定语义，非权限"] --> FAST
    DIAG["恢复诊断：有限反思／能力核验"] --> GR
    GR --> DIAG
    WAIT --> INT["语义动作解释器：版本化映射"]
    FAST --> INT
    INT --> FRAME["ControlFrame：完整持续状态＋一次性输入"]
    FRAME --> BROKER["主机／桌面唯一Input Broker"]
    HEALTH["本地健康／观察时效／授权监督"] --> BROKER
    CAP --> HEALTH
    FAST --> HEALTH
    PATCH["PolicyUpdate：范围校验／本地边界应用"] --> FAST
    PATCH --> WAIT
    GR --> PATCH
    BROKER --> APP["游戏窗口"]
    APP --> CAP
    CAP --> GR
    BROKER --> GR
    GR --> PROGRESS["语义进展／策略实际应用／控制质量"]
  end
  BR --> GR
  PROGRESS --> BR
  BR --> ER
  PRIV["PrivacyGateway"] <--> IRIS["Iris／本场记忆"]
  PRIV --> CTX
  ER --> SUM["后台总结"]
  SUM --> PRIV
  PUB["安全公开投影"] --> OVL["低权限Overlay：另一Origin"]
  CH --> PUB
  ACK --> PUB
  POLL --> PUB
  AUDIO --> PUB
  OP["认证操作台"] --> GATE
  OP --> STOP
  SUP["独立监督租约"] --> STOP
  STOP --> AUDIO
  STOP --> BR
  LOCAL["游戏主机接管／独立看门狗"] --> BROKER
  subgraph OFFLINE["可选离线能力路线：默认不采集、不自动上线"]
    CONSENT["用途许可／最小采集范围"] --> REC["示范记录器：建议／放行／人工／结果分层"]
    REC --> DATA["受控数据集／版本／删除与导出限制"]
    DATA --> TRAIN["离线训练／对照验证／人工批准"]
    TRAIN --> ART["模型制品与能力覆盖清单"]
  end
  CAP -. "已授权最小证据" .-> REC
  FRAME -. "建议与实际输入记录" .-> REC
  BROKER -. "真实回执" .-> REC
  LOCAL -. "允许记录的接管事件" .-> REC
  ART -. "仅安全更新边界启用" .-> SEL
  SYNC --> OBSCTL["受限OBS控制"]
  AUDIO --> OBS["OBS：显式全部输出"]
  SUB --> OBS
  OVL --> OBS
  AV --> VTS["VTube Studio"]
  VTS --> OBS
  OBSCTL --> OBS
  PANIC["OBS原生／实体应急键"] --> OBS
```

图中Game Runtime内部的Controller/PolicyUpdate状态由游戏侧权威维护，Bellis只接外部引用、语义事件和状态投影。离线数据路线没有输入授权、正式发言或Iris直接写入权；图中虚线不表示默认开启采集。模型制品箭头只表示批准后的部署，不表示在线自动改权重。

### 3.9 插件清单与能力归属

#### 控制相关能力的归属

| 扩展 | 归属 | Bellis插件暴露内容 |
|---|---|---|
| ControlCapability与模式选择 | Game Runtime＋ControllerManifest；宿主保留通用Schema和质量门槛 | get_control_capabilities、模式/覆盖/不可用原因 |
| 细动作解释与ControlFrame合成 | Game Pack／控制器内部受信模块 | action_schema/profile版本及语义摘要，不暴露无限键鼠 |
| 本地快策略与局部预测 | Controller的可选PolicyBackend | 后端版本、时延范围、适用条件和验证报告 |
| PolicyPatch | 游戏侧校验与应用，Bellis主控采用提议 | propose_policy_patch、get_policy_update、cancel_policy_update、五种终态事件 |
| 控制健康与输入续租 | 游戏侧监督器＋Broker | control_quality／degraded／takeover_required投影 |
| 控制指标与示范记录 | 游戏Recorder与独立离线工具 | 经过权限过滤的报告/引用，不广播原始逐帧数据 |

上述不是六个独立的Bellis自治插件。一个通用game.bridge足够连接不同Game Pack；包、进程与算法可以分开演进，公开语义不能随实现私有字段漂移。

### 3.11 局部计算职责的部署与权威边界

定位器、编码缓存、候选编辑和恢复诊断优先作为现有Worker、PolicyBackend或RecoveryCoordinator的内部模块实现，不因名称新增进程。图中的GR与诊断之间传递只读依据和候选，不是两个互相等待资源的执行owner。

| 所属边界 | 保存／计算的内容 | 对外可见方式 |
|---|---|---|
| Game Runtime | 根视觉证据、DerivedView、GroundingResult、执行前缀、候选及修正决策 | Bridge按权限返回引用与语义摘要；高频内部轨迹不唤醒主控 |
| 当前计算Worker | ComputeArtifact及其精确依赖、容量和过期策略 | 可丢弃的局部缓存；命中和失效只作有界遥测 |
| Task/Recovery职责 | 失败诊断、可用反思项、恢复提议和已执行恢复的证据 | 既有Task结果、artifact.available和登记的恢复结果事件 |
| Bellis Host | 目标采用、任务/结果/结算、公开表达与外部投影 | 不复制游戏本地控制循环或第二个输入账本 |

高分辨率定位只在必要页面调用；稳定语义按变更重新编码；连续控制依时限选择简单或学习后端；恢复审查在停滞／失败／显式请求时运行。不存在“每次点击先串行跑四篇论文”的默认路径。
