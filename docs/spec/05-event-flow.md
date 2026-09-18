## 5. 事件流与非阻塞主控

> 第 5.1–5.2、5.4–5.7 节属于后续阶段，冻结在 [docs/future/spec/05-event-flow.md](../future/spec/05-event-flow.md)。

### 5.3 事件信封、目录与防重入

跨组件公开事件必须在`events.json`登记event_name、权威、payload_schema、可靠性、去重键和启用阶段。内部状态机短事件不是可由插件任意发布的公共topic。EventEnvelope包含schema_version、event_name/event_id、authority_id/source_instance/authority_epoch、source_seq、session_id/scope_ref、correlation、occurred_at、trace_id及结构化payload；没有通用全局cancel_epoch。

来源发生时间`occurred_at`和接收方记录的`received_at`分开。received_at保存在接收投影/传输日志，不修改原事件payload或签名。source_seq无法取得时显式null，并记录上游覆盖不可验证；不能造一个本地序号冒充平台无缺口。

可靠终态、Effect、清理与权限事件采用稳定event_id和Outbox重放；高频进度可合并，关键首次故障不能丢弃。事件去重之外，业务防重入键为handler_id＋activity_id＋occurrence_id。重复识别同一选择页面不能开十轮投票，内容相同的不同真实对白也不能仅凭hash合并。

同一业务事实收到多次只重放原结果，不再次触发输入或播音。若同event_id/业务唯一键载荷冲突，返回EVENT_IDENTITY_CONFLICT并保留原事实。事件目录见各阶段契约简报，登记规则见附录B.4。
