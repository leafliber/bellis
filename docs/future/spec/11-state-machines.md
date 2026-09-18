## 11. 状态机登记

> 冻结的后续阶段设计，不参与生成与校验；现行部分见 [docs/spec/11-state-machines.md](../../spec/11-state-machines.md)。

### 11.7 局部计算产物不增加执行状态机

系统使用21组状态机管理生命周期、停止、deadline与人工结案。GroundingResult.status、RecoveryResult.outcome和反思条目分类是不可变产物的结果枚举，不是可被外部消息反复推进的新生命周期。

耗时感知／审查仍用已有Task与Attempt承载失败、期限和取消；高频本地控制计算在当前Attempt内有界运行。一次新定位结果不能触发Effect.CONFIRMED，反思记录不能触发no_effect_proven，恢复提议不能触发resume_valid。受信守卫必须引用当前真实授权与证据，具体义务见I87–I104。
