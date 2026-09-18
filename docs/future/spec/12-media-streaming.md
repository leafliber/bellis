## 12. 流式表达与媒体同步

> 冻结的后续阶段设计，不参与生成与校验；现行部分见 [docs/spec/12-media-streaming.md](../../spec/12-media-streaming.md)。

### 12.2 主控输出格式与采用责任

有界NDJSON，UTF-8，每行一个完整DirectorRecord。每条最大16KiB，层级/数组/字符串长度受Schema限制，拒绝重复键、未知字段、畸形UTF-8、NaN和无穷。Provider原生结构化输出可转同一类型；不能退回eval、Markdown解释执行或把内部推理当台词。

| type | 载荷 | 谁补充哪些信息 |
|---|---|---|
| speech_segment | client_ref/source_seq/text/emotion/evidence_refs | 候选正文由主控给出；宿主规范化双文本、审核后分配正式Segment/seq。 |
| end_utterance | client_ref/last_source_seq | 宿主核对候选接纳映射，才能形成正式seal.last_seq；拒绝/漏行不能normal结束。 |
| action_proposal | client_ref/action（完整Action） | 主控或事前模板必须给齐能力版本、Schema、权限引用、结果契约和timeout；宿主只校验并分配Task/Attempt等运行身份。 |
| plan_adoption_proposal | client_ref/candidate_ref（candidate_id/base_revision/digest） | 候选须预登记；宿主查询、核对并采用，不接受任意URL或代码。 |
| policy_patch_proposal | client_ref/action（能力固定control.propose_policy_patch） | 完整有限Action登记更新；权限与PolicySchema另验，不能修改安全配置。 |
| text_presentation_proposal | client_ref/text/evidence_refs/replaces_utterance_id | 新TextPresentation独立审核和完成；被替代语音保持原终态。 |

示例直接读取交付fixture，不包含缺字段缩略Action：

{{director_fixture}}

运行时不能从capability名称默补缺失字段，也不能因提议与安全台词出现在同一流而自动执行动作。两种Action提议进入同一网关；policy_patch_proposal额外限定能力名，避免记录类型变成权限绕过。

source_seq/last_source_seq属于当前decision_cycle＋client_ref的候选序号；segment_seq/last_seq属于正式utterance_id。当前源正常结束记录只表明模型不再追加，不等于已审核、已seal、EOS或实际播完。解析异常只保留此前完整已接受记录，已播前缀不能回滚。
