## 7. Task、Attempt、Effect与清理结算

> 第 7.1–7.8、7.10 节属于后续阶段，冻结在 [docs/future/spec/07-task-effect-settlement.md](../future/spec/07-task-effect-settlement.md)。

### 7.9 停止与自然完成竞争

stop请求先阻止新的冲突效果，但它不是CANCELLED结果。Attempt、Segment、Utterance与TextPresentation在STOPPING仍接收匹配当前实例的自然完成和实际失败。最终判定使用真实执行/输出范围及其与端点栅栏的关系，而不是网络消息到达先后。

端点停止回执至少给出最终已接纳/已提交水位、已完成范围、未执行尾部栅栏、未知范围和清理引用。只有“我已停止”却没有最终结果，不能立即让业务对象CANCELLED；保持STOPPING进行有限结果核验，证据仍不足则UNKNOWN。已经形成不可变终态后才到的成功，只作为对账事实追加。

Attempt可以实际SUCCEEDED但deadline_missed=true；Task的结果契约进一步判断“按时完成”是否必要。可信发生时间证明截止前完成、只是回执迟到时，可保留Task SUCCEEDED；效果确在截止后才发生，则保留Effect CONFIRMED，但要求按时的Task为EXPIRED，不自动重复效果。跨时钟无法证明时保留时序不确定，不猜测按时。

P0 在假设备范围使用同一判定：查询分别返回停止请求/本地栅栏、端点实际计数与接纳水位、未执行与未知范围、清理及持久记录状态。自然完成与停止回执无论到达顺序如何，都不覆盖已发生事实。StopOperation 的 UNKNOWN/CONFIRMED 保持不可变，后来清理证据独立追加；这不要求创建通用 Task/Attempt/Effect/Settlement 引擎。
