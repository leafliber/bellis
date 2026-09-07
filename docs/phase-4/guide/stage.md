# Phase 4：Stage 与主动表现

> 原构建计划的主题分册，保留原章节编号；章节目标不等于已交付能力。当前事实见 [实施状态](../../phase-4-implementation-status.md)，恢复 Gate 以 [ADR 0047](../../adr/0047-phase4a-recovery-scope-freeze.md) 为准。
> [返回构建指南](../../phase-4-development-guide.md)。跨分册的 § 引用按构建指南目录定位。

## 10. P5：Avatar Mixer、Presence 与 Stage 装配

### 10.1 Avatar Mixer

Mixer 接收六层语义输入：

| 层        | 默认优先级 | 来源                                |
| --------- | ---------: | ----------------------------------- |
| Safety    |        100 | reset、断线、异常恢复               |
| LipSync   |         90 | 音频/viseme 或包络                  |
| Directed  |         80 | DecisionPacket → Scene Director Cue |
| Reactive  |         60 | 礼物、胜负、加载等确定性反应        |
| Proactive |         20 | Presence 注视、空闲和受约束随机行为 |
| Base      |         10 | 呼吸、眨眼、基础物理                |

- 每个 Intent 声明 channels、priority、duration、fade、interruptible、exclusive 和 mutex tags；
- Mixer 以通道租约仲裁，不允许低层直接写其他层持有的参数；
- 相同优先级使用稳定来源顺序和 intent identity 决胜；
- 抢占生成显式 `suspended/preempted` 状态，结束后按策略恢复或重新选择，不从过期时间点继续；
- 不支持的 motion/expression 由 Adapter 做语义替代或安全忽略，并记录有界原因；
- 帧级权重、Cubism 参数和插值留在浏览器 Adapter，不进入 Control WS。

### 10.2 Presence Engine

Presence 长期运行但必须有界：

- 基础眨眼、呼吸、轻微姿态和注视不调用模型；
- 行为目录声明 weight、cooldown、required/forbidden tags、channels、mutex 和 max duration；
- 使用注入的单调时钟和可记录 Seed；生产随机源只在 Session/epoch 边界播种；
- World/Avatar State 通过最新值可合并流输入，不排队消费过期状态；
- 行为选择考虑说话、工具等待、当前情绪、最近动作和通道占用；
- 连续重复、单位时间行为数、Timer 数和待执行行为数均有限制；
- 需要语言或长期规划的主动话题只发出受控 Signal 候选，由 Decision Trigger 决定是否唤醒 LLM。

### 10.3 抢占与自然恢复

```text
Presence owns eyes/body
  → Directed Scene requests body/expression
  → Mixer fades/suspends conflicting Presence channels
  → Directed Cue starts at Scene T0
  → Scene finishes or is cancelled
  → leases released
  → Mixer returns through neutral blend
  → Presence re-evaluates current World State and selects fresh behavior
```

- Directed Scene 不能等待低优先级行为自然结束；
- 不冲突通道可以并行，例如 LipSync mouth 与 Presence eyes；
- Safety reset 立即抢占所有相关通道；
- 取消必须撤销目标 Scene 的租约，不清空其他 Scene/基础层仍有效状态；
- 恢复使用当前状态重新评估，不补播抢占期间错过的随机行为。

### 10.4 Stage 与协议

- 现有 Recording/DOM Avatar Lane 是兼容基线，不能删除来让新路径通过；
- Directed Cue 继续使用现有 `sceneId/cueId/sequence/targetTime`；
- 新增状态流时必须有 schemaVersion、session/stage identity、sequence、容量和重连快照；
- 浏览器真实时钟仍由 `AudioContext`/Stage 单调时钟映射，不读取墙钟调度 Cue；
- React 只负责页面和调试视图，Mixer/Cubism 帧循环不进入 React State；
- Stage 重连先进入 Safety/Base，再应用权威快照，不重放过期 Presence delta；
- 未配置授权 Cubism 资源时，Demo 和 CI 必须由 Recording/DOM Adapter 完整通过。
