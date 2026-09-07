# ADR 0033：Recall 发布与重放的 Canonical 核验

状态：响应发布/重放的候选与 Persona 核验已实现；跨请求全量重验及安全解除仍未完成。日期：2026-09-07。

Core Recall 的请求幂等记录保存第一次返回的完整候选集合，供原请求重放和 Usage 四阶段对账使用。原实现重放时直接返回该正文；首次响应发布前只检查删除。因而 Correct、有效期结束或 Persona 切换发生在候选收集之后时，旧响应仍可能返回给 Bellis。SSE 取消不能代替公开读取入口自己的有效性检查。

现在 RecallService 在三个位置调用同一 Canonical 核验：普通重放读取记录的事务、首次发布写入记录的事务，以及另一请求抢先发布后在写事务内重放的分支。候选重新经过现有 Canonical 过滤器，检查资源修订、删除、状态、有效时间、scope、隐私和该类型已有的内容摘要检查；Persona revision/hash 同当前指针比较。原请求的 scope/purpose 授权和 Surface 校验仍在前面执行。

核验失败返回 409 `conflict`，不泄露失效资源身份。不能删减旧候选集合、用新内容覆盖原 requestId，或自动重跑后伪装原响应。先前已提交的 Recall 记录与返回集合保持原样，已确认 Usage 仍按原身份对账；尚未首次发布的失败结果不创建请求记录。未改变相关资源的请求仍原样重放，新的独立 Recall 可读取当前有效资源。显式历史 `as_of` 继续按原评估时刻核验，不能把当前撤回误当成当时不可见。

十三项新增测试覆盖 supersede、retract、过期和 Persona 切换在三个窗口的失效，以及授权历史重放；核对失败不改写原返回集合、失败首次发布无残留记录、新请求可使用有效修订。现有 Recall、Persona、HTTP、Usage、向量/图谱召回和纠正事件回归另行运行。最终计数和性能结果见 [验证证据](../evidence/phase4-recall-revalidation-probe.json)。

真实安装探针使用 SDK 0.11.1 及现有 checked HTTP 边界，先确认原请求可以原样重放，再停止 Core Worker、公开纠正 Claim，确认同一 Recall 返回 409；随后重放原 Usage，report ID 和四阶段计数一致。新修订进入后续 Bellis Context，旧 Context 被取消。联合删除、事件身份、断档屏障/清单和 Chromium 回归通过；既有 24 次崩溃恢复冒烟通过，完整恢复入口仍退出 2。

候选 Core 0.13.0 / Schema 19 的 wheel SHA 为 `c3114eec8208aff4b527d261fcee285bc6f347cfb5837ac7e14dd23ef04b8beb`，170 个安装文件核验通过，应用 OpenAPI 未改变。探针只按精确 hash 接纳候选，默认 SDK 与 Provider Schema 范围维持现有配置。

这里证明单次响应事务中的候选/Persona 核验，不提供跨请求固定快照、缺口清单逐项结论或恢复授权。原 source watermark 不被改写成新的全量核验水位，既有 pending event 身份也不由此升级成新的有效性证明。各类型已有过滤器不等于所有原文的独立重哈希证明；断档恢复仍需覆盖 Observation/Usage 原请求、删除/权限、外置状态、远端一致性及原子安全解除。完整 Phase4 Gate 保持开放。
