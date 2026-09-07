# ADR 0011：Phase 4 输出语义片段与渲染确认

状态：实施中；2026-09-06。此处冻结目标协议；未接通的环节不构成验收证据。

## 片段身份与确认策略

Runtime 在 Prepare 前冻结完整 speech 的 SHA-256、UTF-16 长度与最多 32 个完整语义片段。每段带唯一 segmentId、cueId、指定 Lane、文本范围与片段摘要；范围必须连续、无重叠、覆盖完整文本且不切开代理对。优先按句末标点分段，过多句子合并尾段，不按预计时间估算字符位置。

有音频 Cue 时指定 audio 作为语义片段的确认 Lane，字幕不重复记录；仅字幕输出指定 subtitle。音频每个片段独立完成合成后，根据实际 PCM 样本数形成不可变 binding；不能从预计时长、收包数量或 EOS 推导文本完成。绑定写入持久层后发送 Stage，先生成绑定也不代表播放。

指定确认 Lane 所在同步组提升为 hard，使用 Scene 的准备预算；零预算 best-effort 不能跳过该 Lane 后照常提交。认证 Stage 被宿主接纳时，Phase 4 的决策/Manifest 与 Scene 绑定同一真实 Session。

`SpeechEffectPlan` 放在 ScenePlan 的可选 effects 字段中，旧计划保持合法。`scene.effect.binding` 传递实际样本范围，`scene.effect.receipt` 传递完整片段回执，`scene.effect.ack` 表示效果事实与 Observe 投影已同事务提交。所有消息绑定 Session、Runtime Control connection generation、Scene/Cue、准备内容摘要和片段身份；receipt 还带唯一幂等 ID。Stage 不另传自由正文。

## 实际生效边界

Worklet 仅累计真正写入输出缓冲的源 PCM 样本；静音补齐不增加源样本计数，取消后的淡出不确认新的语义片段。样本拒收、溢出或映射缺口不能通过总量补齐。完整片段 endSample 被渲染越过后才能发出对应回执。全段回执可以在取消后迟到，但不能改变 Director 终态。

字幕在实际应用冻结文本后确认，不因 prepare、调度或 scene.started 确认。两种 Lane 都只发指定片段的增量身份。未完整确认的最后一段被舍弃；重启后没有持久证据的输出不推测、不重播。

## 持久化与容量

Runtime 校验回执对应实际提交的 Scene、原连接代际和不可变片段映射，并从持久化原计划提取正文。效果记录、业务去重、独立观察游标及每 Provider Observe Outbox 必须同事务写入。整个话语仅一段且完整确认时可用 committed；多段增量用 partial 并携带该段独立 confirmed_range，不能把累计前缀重复发送。

Prepare 前为最大活动 Scene × 每 Scene 最多 32 段 × Provider 上限预留确认容量。新准入在高水位停止，已有 Scene 的确认使用保留容量；取消/完成不会按本机超时释放已发给 Stage 的保留额度。

Runtime 终态后停止接纳新绑定，等待在途 DB 绑定写入结算，再用 `scene.effect.seal` 发送完整、不可变的绑定前缀。即使调用方已经取消，只要 DB 接受了绑定也纳入清单；Stage 仍须用真实渲染样本验证，绑定本身不产生事实。清单重发直到释放握手，不设两秒迟到窗口。

Stage 保留终态渲染进度，取得最终清单且全部效果回执获得持久 ACK 后发送 `scene.effect.release`；Runtime 关闭未使用预留后返回 `scene.effect.released`。清单、回执及释放请求均可重试；容量始终有界，积压会阻止新 Scene 准入。未发送的计划、已断开的连接或 Runtime 重启会关闭旧许可。回执重试复用 receiptId，使用新传输 messageId；ACK 丢失不产生重复 Observe。

## 验证目标

已覆盖 Prepare/收包/静音不确认、真实样本越界、半段取消、重复/迟到回执、跨 Session/代际拒绝、非法范围、事务回滚、ACK/释放重试和容量预留。VirtualClock 验证终态一分钟后收到清单仍可确认已渲染前段；运行时验证清单等待在途 DB 写入。完整网络/崩溃窗口矩阵仍属于 A4。

2026-09-06：`demo:phase4:iris` 通过真实 Chromium → Runtime/DB Worker → Iris Provider/已安装 SDK → Core API/Worker 的联合路径。三个 Cycle 产生四条真实输出观察，Core 公共 source cursor 为 4；逐段/整段证明、下一轮 Context 回读及取消后不补写均通过。该短闭环不替代 A3 隐私/工具和 A4 长时/恢复 Gate。
