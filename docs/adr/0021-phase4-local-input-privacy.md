# ADR 0021：待消费 Signal 与 Tool Result 的隐私版本

状态：已实施并验证本地输入版本过滤；完整 Phase 4 仍进行中。日期：2026-09-07。

## 冻结语义

1. Signal 的外来 JSON 不能声明可信策略版本。接纳事务从宿主 Context Port 的当前 stamp（或既有可信 Observe 映射）取得版本，并与 Signal 一起写入独立元数据表。重复输入保留首次版本，不按重试时的版本重新授权；已绑定 Memory scope 的 Session 不能省略 stamp。
2. MemoryHost 在构造本地 Prompt、actors 和 Recall query 前，通过 DB Worker 核对批次中每个 Signal ID 的接纳版本。未知、歧义或旧版本输入不进入请求。原 Signal、消费水位及历史审计不改写。缺少逐项来源 ID 的聚类 topic 和聚合 weight 只有在原批次水位范围无缺口、全部 Signal 均有当前版本证明时才保留；否则只保留已核验的独立 highlight。
3. 待消费 Tool Result 通过 Tool Run 所属的已采用 Context Manifest 确定来源策略，且检查已准备请求的资源 tombstone。没有来源证据或属于旧版本的结果移除正文，仅保留固定的抑制状态；远端结果未知仍保留 `tool_outcome_unknown`，防止下一轮误认为可以换键重写。此检查不替代工具返回时必需的权限/隐私过滤。
4. Manifest 保存有界的本地输入纳入/排除记录，不保存被排除正文。模型调用和 adoption 继续使用既有取消与策略复核，构造期间发生隐私变更不得采用旧结果。没有持久策略的单元/嵌入夹具可以沿用非持久路径；有策略但缺少核验端口时不得降级为不检查。
5. Migration 14 只增加 Signal 策略元数据，不把历史未标记 Signal 自动归属到当前版本。元数据设置 16,384 行容量上限，满额拒绝新的接纳并回滚事务，不驱逐可能仍被恢复或审计引用的行。

## 验收要求

验证接纳回滚、重复输入不重标记、跨 Session/scope 和旧版本拒绝、Worker 重启、混合新旧 Signal、排队工具结果及 unknown 状态、Manifest 审计与模型/Recall 实际正文过滤。真实 Core/Stage 回归需要继续证明新的隐私 generation 下合法新输入仍能形成闭环。


## 已运行证据

根 `pnpm check` 通过：1,014 项单元/性质测试、227 项集成测试，158 个生成契约文件无漂移。Persistence 专项 4 项覆盖原版本重放/重启、跨 scope/Session、批次范围证明、Tool Run 所属 Manifest、事务回滚及容量拒绝；Runtime 单元与真实 Decision Host/DB Worker 集成覆盖实际 Prompt/actors/Recall 过滤、unknown 状态保留、完整批次聚合保留和取消传播。

同一次 Core 0.13/SDK 0.11.1 联合探针通过公共工具和真实 Chromium Stage：三 Cycle、四条输出 Observe、三次 Usage、隐私 generation 1 中断；注册 Forget 的两次目标读取、一次确认/写入、持久屏障和重启回执也通过。此短回归不替代 A4 100 Cycle 或崩溃窗口。见 [本地输入隐私专项](../evidence/phase4-local-input-privacy-probe.json) 和 [真实 Core/Stage 报告](../evidence/phase4-local-input-privacy-core-probe.json)。

本切片验证策略 generation 的隔离；可信来源、用户意图/证据授权以及工具结果自身的权限过滤仍由对应应用端口负责。旧版未带策略元数据的 Signal 不自动迁入当前身份；历史记录保留，只有模型可见输入被过滤。Migration 14 沿用只前进的升级规则，不能用旧二进制忽略新增版本。
