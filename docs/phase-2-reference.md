# Bellis Phase 2 完成态参考：演出纵向链路

> 文档状态：完成态 v1（Gate 2 通过）  
> 实施指南：[Phase 2 开发指南](./phase-2-development-guide.md)（含工作包分解与验收标准）  
> 上游基线：[Phase 1 完成态参考](./phase-1-reference.md)  
> 协议：[Scene Execution](./protocols/scene-execution.md) · [Control WebSocket](./protocols/control-websocket.md) · [Binary Media WebSocket](./protocols/binary-media-websocket.md)  
> 决策：[ADR 0001](./adr/0001-canonical-core-and-wire-contracts.md) · [ADR 0002](./adr/0002-node-26-baseline.md) · [ADR 0003](./adr/0003-phase-2-scene-wire-and-browser-boundary.md)

## 1. 阶段结论

Phase 2 完成确定性演出骨架（架构设计 Milestone 1 的确定性子集）：一条
本地 Fake Signal 在无公网、无真实模型、无未授权资源的条件下走通

```text
Fake Signal → Fake Model（固定 DecisionPacket）→ ActionFrame 校验
  → Action Compiler（Scene + Cue）→ Scene Director（Prepare Barrier）
  → stage.capabilities 驱动编译能力
  → media.stream.announce → ready → Runtime→Stage PCM 帧流（BELL v1）
  → 数据库原子 Commit（含 plan_json）→ 未来单调时刻 Commit
  → 三 Lane（AudioWorklet/字幕/Avatar）同步启动 → 完成/取消/降级
  → Snapshot v2 重连对账（uncertain 不自动重播）
```

## 2. 交付形态

| 位置 | 交付 |
| --- | --- |
| `packages/contracts` | ScenePlan/SceneExecutionState/StageCapabilities/PCM 基线常量/Phase2 Snapshot/10 个 Phase 2 消息类型（双 JSON Schema + 三方 fixture 等价） |
| `packages/transport` | `./browser` 浏览器安全入口（静态扫描强制）；BaseMonotonicClock 共享等待算法 |
| `packages/scene-runtime` | 纯函数 Action Compiler（确定性拒绝/锚点闭合/能力策略）、PrepareBarrier（hard 全 ready、soft 超时缺席记录）、SceneDirector 状态机（commitAtRuntimeUs 先于 durable 提交选定；DB 失败只发取消；结果不确定即 uncertain 终不自动重试；终态保留窗 128） |
| `apps/runtime` | Phase2PerformanceService（Signal→Model→Compiler→媒体编排→Director；Scene 级稳定 traceId；版本化审计 Record）、MediaConnection 出站 BELL v1（背压上限）、clientType=stage 连接归属、Snapshot v2 装饰、`phase2.stageDistDir` 静态托管 `/stage/*` |
| `apps/stage` | StageApp 引导状态机、三 Lane（真实 AudioWorklet/DOM 字幕文本节点/Recording+DOM Avatar）、StageMediaClient（入站 Registry 校验 + 断线有界重连）、CueTimeline（Runtime 时刻映射 + 迟到容忍）、Vite 构建（base=/stage/、Worklet 独立 lib 产物） |
| `packages/persistence` | Migration 0002 `scenes.plan_json`；commitScene 携带完整 plan |
| `packages/observability` | Phase 2 Runtime 侧指标目录（§13） |

## 3. 验收命令与证据（全部通过）

```bash
pnpm check             # typecheck + lint + format + 单测/集成/性质
pnpm build             # 含 Stage dist-web 与 Worklet 产物
pnpm contracts:check   # 双 JSON Schema 漂移检测
pnpm test:browser      # 真实 Chromium E2E
pnpm demo:phase1       # Phase 1 回归
pnpm demo:phase2       # 协议级纵向链路 + 真实媒体帧流
pnpm demo:phase2:crash # 四个 Crash Window + Snapshot v2
```

代表性证据（浏览器级，真实 Chromium + 真实 AudioWorklet，多次实测）：

```text
audioWorklet=started(frames=26)
subtitle=visible(textNodes,releasedOnFinish)
avatarAdapter=started(commands=3)
hardLaneSkewMs=2.4~3.2(browser, budget=50)
underruns=0
interruptLatencyMs=2.0~2.1(browser, budget=100+slack)
```

协议级（`pnpm demo:phase2`）：媒体帧 sequence 严格连续、targetTimeUs 恒
20ms 等差、RMS≈4854（真实波形非静音）、预缓冲 6 帧达标才宣告 audio
ready、取消后帧流立即停止、全链路 Trace 连续（Signal 提交根 ==
Control 线上 announce/prepare/commit/cancel == Media 帧头 == DB Record
四类证据 + 真实 sessionId）。

Crash Window（`pnpm demo:phase2:crash`）：W1 未落库无重放（v1）；W2
durable 落库且 commit 不外泄、不补发，重启返回 v2 uncertain 对账视图；
W3 commit 已送达无重放（v2 uncertain）；W4 崩溃前真实观察到 cancel、
至多重放一次（cancel 终态落库竞态下 v1/v2 均合法）；同进程断连重连
收到 schemaVersion 2 快照（activeScene.executionState=uncertain、
requiresReprepare=true）。

## 4. 资源与失败语义（不变量）

- 所有队列/缓冲/Barrier/Timer/Socket/浏览器资源有界并具备 Abort、
  Deadline 与 close 路径（媒体发送三重限制——帧数/字节按「已发送未
  播放」账目执行、迟到超预算丢弃重同步计入 droppedByLimit、Worklet
  有界缓冲、重连退避封顶、Director 并发与终态保留上限）；
- Prepare 零副作用（缓冲不是生效）；Commit 持久化优先；
  commitAtRuntimeUs 在 durable 提交之前选定；
- 硬同步组整组处理：任一 hard Lane 不可用即整组取消
  （`hard_lane_unavailable:<detail>`）；降级重编译属应用层策略；
- 取消优先于媒体发送；Control 取消先于 Media 帧（P1 优先级）；
- uncertain 绝不自动重试外部效果；迟到回执不得复活终态；
- Media Sequence 只计数到达传输层的帧（丢弃帧不缺号）；媒体 Stream
  完成/终态即 closed（Stage Registry 并发槽位释放；E2E 马拉松 9+ 场
  opened=11 仍零拒绝帧）；closed 携带 finalSequence 关闭边界——与帧
  跨 WebSocket 乱序时边界内迟到尾帧仍入账；closed 入队失败保留重发，
  Stage 控制代际变化即失效全部媒体槽位（不遗留）；
- Stage 侧 Deadline 检查经时钟偏移映射后同域比较（宽限 100ms；
  估计未就绪跳过——不做跨域误判）；
- 断线即停：Stage 连接代际变化时 running Scene 的 Lane 副作用本地
  停止（音频淡出/字幕行移除/Avatar stop），对账交由协议；
- 角色与 Session 隔离：演出回执仅 clientType=stage 的绑定连接可提交；
  首个 stage hello 决定归属 Session（改绑拒绝）；Media WS 仅归属
  Session 可承载 Phase 2 出站；
- 能力快照权威：stage.capabilities Schema 通过即照单（Stage 明确不
  支持 PCM 时音频 Cue 编译拒绝，不回落默认）；断线按代际清除；
- 审计 payload 版本化：signal_accepted/decision_packet/
  scene_plan_compiled/scene_lifecycle 携带 payloadVersion=1 并经
  版本化 Schema 校验（非法 payload 显式失败，不落任意 JSON）；
- 跨进程对账覆盖并发 Scene（scene_lifecycle 专用倒序最近窗口聚合，
  不被审计 Record 挤占、不取最早一批）；未知 payloadVersion 绝不
  静默当作已知格式；Director admission 拒绝时预分配状态回滚（PCM
  物化推迟到 ready 之后）；maxBufferedUs=0 合法（零预算 = 只按目标
  时刻发送），迟到重同步阈值独立（与 Stage Deadline 宽限同族）。

## 5. 已知边界（后续阶段）

- `bellis_stage_*` 指标上报通道（现以 E2E 证据行承载）；
- 真实 Cubism Adapter（浏览器路径为 Recording+DOM 徽标；未授权资源
  不进仓库）；
- 真实 TTS Provider/LLM/Signal Hub（Phase 3+）。
