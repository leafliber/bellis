# Bellis V2 架构概览

本文定义不可妥协的安全边界、单仓目录、四进程拓扑、快慢双主 Agent 事件流骨架与已拍板的关键边界。各最小闭环与内部契约均保持**可演进**：优先服务当前真机切片，后续按真实运行反馈随时调整，不为远期假设提前写死。

## 一、单仓目录与检查策略

单仓统一采用 **Python 3.12（`uv`）+ Rust（`cargo`）**（仅 OBS Stage 与操作台网页为纯原生 HTML/JS）：

```text
bellis/
├── AGENTS.md           # 唯一规则入口与防失控红线
├── docs/               # 精简架构与垂直切片路线图
├── core/               # Rust workspace：realtime-core、channel、watchdog
├── py/                 # 唯一 Python uv workspace：bellis_common、bellis_host、bellis_game
├── web/                # OBS Stage 与本机操作台纯原生 HTML/JS
├── games/              # 游戏适配声明与极简模板配置
├── tests/              # 全部测试、假替身与跨语言 JSON 往返夹具（生产目录零 sim*）
└── lab/                # 临时探针与实验脚本（不纳入主检查门禁，用完即归档/删除）
```

- **本机 Windows 单平台检查**：仅在 Windows 11 x64 本机运行检查，不维护 Linux 容器交叉检查。
- **分层快检查**：默认 `uv run check` 只跑快检查（ruff、pyright、依赖方向与单文件行数红线检查、pytest）；涉及 `core/` 改动或指定 `--all` 时运行 `cargo fmt`/`clippy`/`test`。
- **本地未跟踪资产隔离**：原 V1 真实配置、运行库、音色/Live2D 资源与历史报告统一隔离存放在被 `.gitignore` 忽略的 `.local/` 目录，与新代码完全解耦，需要时按需读取或复制。

## 二、四进程安全拓扑

合并仓库用于消除跨仓契约同步与重复造轮子，**物理安全边界仍由独立进程维持**：

```text
┌─────────────────── Host 进程（Python，非提权）────────────────────────┐
│ 【确定性安全与媒体底座】                                               │
│   安全核（闸门 · 单调 Lease 令牌 · 监督模式 · 急停） · SQLite WAL      │
│   操作台 / CLI（直连安全核） · OBS 应急连接 · 媒体管线(TTS→Stage→VTS)  │
│ 【慢主 Agent 事件流循环（~0.2–1Hz / 事件驱动）】                        │
│   弹幕/投票 · 公开记忆（SQLite 轻量表） · 播放游标回执 · 游戏离散事件   │
│   ──► 口播文本流(→媒体管线) · 游戏高层目标/暂停/选项决策(→快循环)        │
└────────────────────────┬─────────────────────────────▲────────────────┘
                         │ 极简本机通道(Py↔Py)          │ 许可续约/急停直连
                         ▼                             │（不经快循环转手）
┌── Game Agent（Python，非提权）─────────┐             │
│ 【快主 Agent 事件流循环（通用交互）】   │             │
│   io -> perception -> skills -> loop   │             │
│   读共享内存最新帧 + 目标事件           │             │
│   → VLM + 少量基础动作/模板（首版）     │             │
│   → 提交动作 & 新帧独立核验            │             │
│   → 向慢循环上报离散语义事件            │             │
└───────────────────┬────────────────────┘             │
                    │ 共享内存(帧/音频) + 单套统一 RPC  │
                    ▼                                  ▼
┌── Realtime Core（Rust，按需提权，最小可信核）─────────┐
│ WGC 采集 · WASAPI 进程回环 · 共享内存写端              │
│ 唯一键鼠写入者：三方权威 · 持键账目 · SendInput · 钩子  │
└───────────────────────────────────────────────────────┘

┌── Watchdog（Rust 极简独立二进制，非子进程）───────────┐
│ 监听 Host 心跳；超时直连 obs-websocket 静音并切安全场景 │
└───────────────────────────────────────────────────────┘
```

- **启动模式**：统一由极简启动入口支持 3 种模式：`game`（独立练游戏：`Game Agent` + `Realtime Core` + 独立许可控制台）、`live`（纯直播：`Host` + `Watchdog`）、`all`（边玩边播：四进程齐开）。
- **进程拉起与连接交付**：`Watchdog` 由启动器并列拉起（不做 Host 子进程）；`Realtime Core` 不提权时直接拉起，游戏需要提权时沿用已验证的按需计划任务；跨进程一次性会话密钥与管道名经 Windows 凭据管理器交付。
- **本地 TTS（后续切换）**：保持薄 `TtsSynthesizer` 接口，现阶段使用云端 MiniMax，后续按需对接本机 TTS API 服务，不向仓库引入 PyTorch/CUDA 依赖。

## 三、不可妥协的 5 条安全底线

1. **确定性把关不可绕过**：对外发声、切场景、键鼠输入必须经安全核/实时核授权与单调递增 Lease 令牌核验；AI Agent 永不自授权限。
2. **控制通道独立（Out-of-Band）**：急停、暂停、许可吊销、OBS 热键触发与真人键鼠接管直接作用于安全核/实时核，绝不进入 Agent 普通事件队列排队。
3. **三方输入权威与 Fail-Closed 释放**：Rust 实时核仅在“有效输入许可 + 有效控制源心跳 + 帧龄未过期”同时成立时注入输入；失焦、断连、超时、真人接管或急停时立刻释放全部持键并经 `GetAsyncKeyState` 核验物理抬起。
4. **不可信数据隔离（Rule of Two）**：弹幕、观众信息、游戏画面、OCR 与模型输出一律视为不可信数据，不接触凭据，不授予越权能力。
5. **副作用先落盘、重启不重做**：关键副作用经 SQLite WAL 先记意图再执行；重启只恢复状态，永不重放有时效的发声或键鼠操作。

## 四、快慢双主 Agent 事件流与通用交互

智能层摒弃 V1 的三级 LLM 串行接力与重型插件内核，收拢为快慢两个主循环，且**均可按真实运行需求持续微调，不提前定死**：

- **慢主 Agent（System 2，主播与高层任务大脑）**：
  - 消费合并后的弹幕事件、投票事件、播放游标结果与游戏离散事件。
  - 弹幕采用时间窗合并与有界丢旧；高优打断直接取消当前在途推理。
  - 只向独立时钟的高频媒体管线输出文本流，并向快循环下发/取消高层目标。
- **快主 Agent（System 1，通用游戏交互循环）**：
  - 画面走共享内存**最新值覆盖（按需拉取）**，绝不将视频帧排入事件队列；仅离散控制/目标事件走有界队列。
  - 内部严格单向分层：`io`（帧/音频读端与实时核提交）→ `perception`（无状态算子）→ `skills`（基础动作原语、模板与新帧核验）→ `loop`（薄调度循环）。
  - 首版（Step 2）**先只用 VLM + 少量确定性基础动作/模板**跑通 HSR 最小闭环；后续按实测需要灵活增补 OCR、本地 UI 检测或连续控制（VLA）。
- **慢 ↔ 快最小事件集（纯 Python dataclass，按需演进）**：
  - 慢 → 快：`GoalSet`、`GoalCancel`、`PacingPause`、`PacingResume`、`DecisionResolved`
  - 快 → 慢：`GoalCompleted`、`GoalStuck`、`DecisionNeeded`、`HighlightObserved`、`ControlReleased`
  - 同仓共享同一份 Python 定义，零代码生成，后续需要增删字段直接同提交修改。

## 五、统一单套实时核协议与轻量化边界

- **显式模块化装配**：直接构造、依赖注入与统一 `quiesce()`/`close()` 清理栈；零插件内核、零 Profile/Patch DSL。
- **单套通道与许可协议**：
  - 本机通道统一用双向 HMAC 认证的 `bellis-channel/1`，只做传输与认证，绝不反向耦合业务解析。
  - 独立许可控制台与 Host 对 Rust 实时核使用**同一套许可控制 RPC**（`lease.renew`、`lease.revoke`、`input.stop`、`input.released`、`health`），彻底移除多轨许可协议与重复的 `game-bridge-protocol`。
  - 取消 `schemars`/`datamodel-code-generator` 重型生成链，改为**手写极简类型 + `tests/fixtures/` 双向 JSON 往返测试 + 共享内存头布局偏移断言测试**防漂移。
- **轻量遥测**：统一写入精简 JSONL（trace/span/耗时/关键属性），配极小统计脚本计算 p50/p95/p99；不自研 OTLP 闭合 Schema 校验器。

## 六、白名单移植边界（来自本地 `dev-1`）

| 类别 | 处置 | 范围 |
| --- | --- | --- |
| **白名单移植（底层已验证叶子）** | 摘取并适配新接口 | Rust WGC 采集、WASAPI 回环、共享内存环、QPC 时钟、SendInput + 低层钩子 + 残留核验；Stage 网页与 AudioWorklet 游标对齐；OBS/B 站/VTS/GLM/MiniMax 协议要点与 SQLite WAL 思路 |
| **坚决废弃（不迁回）** | 留在 `dev-1` | TS/Py 两套插件内核、Profile/Patch DSL、双版本游戏桥、GR-38 假设备任务账本、`game-bridge-protocol` 重复 RPC、视觉小说 `step_control`/`narrative`/`planner`、生产内嵌 `sim*` 与 `TraceService`、历史 `spikes/` |
