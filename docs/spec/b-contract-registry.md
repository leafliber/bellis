## 附录B 协议、字段、错误与事件登记

> 第 B.3、B.5、B.9 节属于后续阶段，冻结在 [docs/future/spec/b-contract-registry.md](../future/spec/b-contract-registry.md)。

各登记的字段表、事件目录、错误码与命令目录按阶段列在[P0](../generated/P0.md)与[P1](../generated/P1.md)契约简报中；本附录只写登记本身的规则。登记文件与派生类型的说明见 [contracts/README.md](../../contracts/README.md)。

### B.1 登记边界与读取接口

手写对象形状在`contracts/src/schema.json`；生成器把它与由登记派生的枚举、事件/错误绑定和RPC请求形状合成为`contracts/generated/bundle.schema.json`，离线引用只解析该bundle，不访问任意网络。所有对象拒绝额外字段；多态业务inputs允许受限结构化绑定，但解析后必须按其精确业务Schema再次验证。严格JSON解析另拒重复键、NaN/Infinity和过深/过大文档，JSON Schema本身不能恢复已被解析器覆盖的重复键。

注册读取接口建议为get_contract(ref)、get_state_machine(id)、get_error(reason_code)、get_event(event_name)，只返回不可变快照；未登记引用使用CONTRACT_REFERENCE_INVALID，未启用能力使用固定unsupported。运行热配置不能就地改变已采用对象引用的契约。字段的完整形状与单位不能只靠表面JSON可解析来验证。

### B.2 错误与固定原因

每个reason_code只属于一个顶层类别，并固定恢复分类（retry_disposition）；ErrorEnvelope按原因码绑定两者。CONTROLLER_NOT_READY固定STATE_CONFLICT，不归计算Provider故障。

ErrorEnvelope固定category、reason_code、object_ref、phase、operation_id（无命令时null）、retry_disposition、safe_message和evidence_refs。未知效果必须query_only；unsupported/隐私/权限拒绝不可普通重试。底层传输错误与业务结果分层，不能因错误分类易重试而覆盖可能已发生的效果。JSON-RPC的整数error.code保留传输含义，业务字段放error.data。[S7]

### B.4 公开事件目录

事件名、authority、payload_schema和可靠性统一登记在`events.json`；登记中的阶段是该能力开始启用的阶段。关键终态使用可靠Outbox/稳定event_id；源端断电前未持久化造成缺口时保留unknown，不作绝对恰好一次承诺。每个订阅者通过同一业务唯一键幂等消费；表外事件不进入执行归约器。

原来源事实与Bellis外部投影不是两个同名写入者。桥接重放保留原authority/source_instance/event_id；宿主只能为自己权威的对象发布状态事实，不能替外部权威另发一次同名事实。

### B.6 对象记录形状

状态机登记对象的生命周期，事件载荷只携带引用和结果；**运行时实际要持久化的字段登记为对象记录**（`object-records.json`绑定状态机与记录Schema）。实现的存储层、SDK类型和恢复逻辑都从登记取形状，不从正文散文里抄字段。

每个记录的状态字段引用同名状态机派生的`<状态机>State`枚举，由生成器从状态表产出，两处不会漂移；`close_reason`复用同一套终止原因词表。所有记录拒绝未列字段，且每个字段都必填：不适用时写显式null，不省略键，避免“缺字段”和“值为空”混淆。

记录里出现的引用（contract_ref、object_ref、evidence_refs等）只是标识，存在性、权限和证据仍由受信逻辑核验；登记不定义索引、表结构或存储引擎。

### B.7 插件声明与配置Schema

Manifest、RPC上下文与运行配置均在同一bundle内定义。引用存在性、权限、单位组合、时效及真实证据由受信宿主核验；结构合法不能自动启用能力。

### B.8 命令目录

命令来自`commands.json`；公开事实事件仍只在B.4。目录给出完整方法名、输入/结果Schema及最早阶段；静态不支持原因、幂等规则也在源登记。宿主内部、Stage、插件和其它Runtime分别暴露各自目标方法，不能把整个目录开放给任一插件。所有结果按发起命令的result_schema再次验证。
