# ADR 0034：原 Recall 请求的批量重验

状态：公开批量接口已实现并验证；宿主原请求持久化、跨批次一致性与安全解除仍未完成。日期：2026-09-07。

断档清单需要公开的 Canonical 核验依据。新增 `recall.revalidate.v1` 能力及只读 `POST /v1/recall:revalidate`：一次提供 1–16 个完整原 Recall 请求和本次截止时间，在一个 Core 读事务中检查原请求指纹、当前 scope/purpose/actor 授权、存档返回资源集合及 Persona。嵌套请求中的旧截止时间不改变原指纹，也不能阻止核验；实际执行受本次截止时间约束。

返回每个原 requestId 的 `valid` 或 `unavailable`，不返回原正文、资源身份、缺失原因或其他应用的记录。请求不存在、原指纹不匹配、已擦除或候选/Persona 失效均为 unavailable。任何请求越权或格式非法使整个批次失败；重复 requestId 拒绝。不得通过这条只读接口创建 Recall、Usage、事件或新幂等记录。

结果只涵盖同一批次的读取快照和评估时刻。各批次不能因时间戳相近、全部 valid 或遍历结束就合并为全量一致性证明，也不能解除宿主缺口屏障。调用方必须保存并提供真正的原请求；无法重建原请求的旧清单项保持未证明，不能从 requestId 猜测正文。独立 Observation/Usage 请求核对、无 Recall 存档的资源、跨批次一致性以及安全解除继续实施。

每批 HTTP 请求体最多 1 MiB；载入存档后、反序列化前检查单个正文最多 1 MiB、累计最多 8 MiB，展开的候选总数最多 512；超限整体拒绝。这些是服务处理限额，不是 SQLite 单行物化的内存硬配额。执行使用本次截止时间与服务端 60 秒上限的较早者，超时返回标准 deadline 错误。能力为显式授权，既有凭据不自动扩权；普通认证仍在传输入口执行，这里不声明凭据并发撤销与 Canonical 事务拥有同一个锁。

六项专项测试覆盖原指纹/未知请求/不返回正文、原记录不变、并发纠正时同批读取一个快照、同批固定 TTL 评估时刻、能力/scope/截止时间/请求体边界及存档正文/候选超限。相关 Recall/Usage/HTTP/公开契约回归共 102 项通过，新增 Schema 20 的 Console 操作迁移及相关回归另有 33 项通过。生成契约、兼容检查、公开 API 白名单、类型和 Ruff 检查通过。公开面相对前一个候选只增加该操作及两个 Schema，SDK 方法保持原状。

最终候选 Core 0.13.0 / Schema 20 wheel SHA 为 `2183f77fbcbcc00abecb27bdb4440d7eb8f6fff19aaf125bf4487dc0a253642f`，178 个安装文件核验。Schema 20 包含当前 Iris 工作树新增的 Console 操作/问题记录表，已单独审查和测试；探针仅按精确 hash 接纳。真实安装的公共 HTTP 验证原请求 valid、公开纠正后 unavailable、旧截止时间不阻止重验且不返回原文，原 Usage 回执仍一致，新修订实际进入后续 Context。删除、缺口屏障/清单、检查点与 Chromium 回归通过。见 [批量核验证据](../evidence/phase4-recall-batch-probe.json)。

当前 Bellis Manifest 为摘要审计，不能完整重建原 Recall 请求。后续需在可信 Provider/宿主边界持久保存实际请求并绑定清单，不能填造旧请求。批量端点目前通过现有 checked HTTP 测试，尚未增加 SDK 方法或接入生产缺口恢复编排；它也没有创建解除屏障的接口。
