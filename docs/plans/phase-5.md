# Phase 5 执行入口：真实直播基础与 FakeGame 公共接入

状态：待实施。总体依赖见 [双线路线图](./README.md)。本阶段必须同时交付 L5、G5 和 J5；仅 G5 全部通过应写“游戏线 Phase 5 完成”，不能写“Phase 5 全部完成”。

## 工作包与顺序

| 工作包 | 负责边界 | 可并行推进与完成依据 |
| --- | --- | --- |
| **S5 公共基线** | Bellis 公共 Plugin SDK、注册/权限/禁用生命周期；游戏 Activity 与现有 Turn/Scene 的兼容；冻结外部条件和各线 Gate | 复验现有命令；按 [G5.0](./game/phase-5.md) 与 [L5.0](./live/README.md) 固定契约、规格缺项、实际版本与负载口径；公共 SDK 只有一个所有者与一份产物 |
| **L5 直播基础** | Bellis 的实际模型/TTS、Cubism/Mixer/Presence、首个平台、最小 Studio 与 OBS | 可先做 Speech/Avatar 端口，再接 SDK 平台插件与 UI；L5.0–L5.5 各有真实证据 |
| **G5 公共游戏接入** | Bellis Activity/GameProvider；独立游戏平台 Runtime/Adapter SDK/FakeGame/Client/薄插件 | 公开模型和无输入 FakeGame 可先做；两仓用实际包产物联调；G5.0–G5.5 全部通过 |
| **J5 联合演示** | FakeGame 事件经真实直播表现与 Iris；一个人格/语音/记忆 owner | L5、G5 都通过后复验重复事件/部分输出/取消/禁用/断线；旧会话结果不污染新会话 |

S5 是两线共享的交付，不另建第三工作线/SDK 仓库，也不重复计验收。先实现足够支撑两类插件的最小公共面，不在 Phase 5 建完整插件市场、安装器或游戏控制算法。

## 完成边界

Phase 5 的体验出口是“无游戏也可真实直播，加上 FakeGame 能通过公共插件接入同一表现链”。游戏事件模拟与声音/角色真实可以同时成立，报告必须逐层标明。Phase 6 才开始首款真实游戏/物理输入；Phase 7 第二游戏/跨机；Phase 8 安装与发行。

开工使用 [当前构建命令](../guides/build-and-validation.md) 建立基线，新检查实现后再登记。现有 CI 确定性检查不等于 L5 的账号、模型、资产和 OBS 验收；真实环境缺失则保留具体未运行项，完成可独立工作。Phase 4A 的冻结 480 项不变；Phase 4B 必需依赖按 [承接表](./phase-4/backlog.md) 处理。

跨仓规格以 [ADR 0048](../adr/0048-external-game-runtime-and-session-activity.md) 和 v0.4 快照为依据。v0.3 未取得可读正文，精确继承语义必须补齐再通过 G5.0；不能以猜测接口或创建占位包消除该缺项。

## 精简 goal prompt

```text
按 docs/plans/phase-5.md 完成 Phase 5 双线交付。先复验现有基线，冻结共享 Plugin SDK、L5/G5 契约与外部条件；Bellis 的公共插件宿主只实现一份。
直播线按 docs/plans/live/README.md 完成 L5：真实 LLM/TTS、Cubism/Mixer/Presence、首个平台插件、最小 Studio、Windows/OBS 无游戏验收。游戏线按 docs/plans/game/phase-5.md 完成 G5：公共 GameProvider/Session Activity、独立 Runtime/Adapter SDK/FakeGame、HTTP/SSE Client 和单一薄插件，用干净 tarball/wheel consumer 验证 attach、owner、操作及事件恢复。
最后完成 J5：FakeGame 事件进入真实直播与 Iris 链路，验证取消、部分输出、去重和单一语音/记忆写入。保留 Phase 4A 冻结边界；不提前实现真实游戏输入、第二游戏或安装器。按可验证切片提交，推送遵循已获授权的范围；原始报告归 artifact。只有 L5、G5、J5 均有证据才宣布本阶段完成；缺外部条件时明确列出未运行项。
```
