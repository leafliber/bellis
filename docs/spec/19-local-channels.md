## 19. 本地通道、浏览器源与凭证隔离

> 第 19.6、19.8 节属于后续阶段，冻结在 [docs/future/spec/19-local-channels.md](../future/spec/19-local-channels.md)。

### 19.1 loopback不是认证

恶意网页可能尝试连接本地服务，本地进程也可能伪造Origin。浏览器的本地网络限制随实现而异，不能替代服务端鉴权。WebSocket必须检查精确Origin、身份和消息级权限，不能仅依赖CORS响应头。[S17][S27]

首版仅监听明确IPv4/IPv6 loopback；跨机连接通过配对和受控加密通道，不直接匿名开放桌面控制。检查Host与精确Origin白名单，拒绝浏览器未知/空/null Origin；非浏览器Worker走独立注册凭证，不能把“无Origin”当可信。

### 19.2 三个来源与角色

| 示例Origin | 角色 | 权限 |
|---|---|---|
| http://127.0.0.1:17860 | 操作台 | 登录/配对后管理指定Session，敏感操作再次确认 |
| http://127.0.0.1:17861 | 受信Stage | 只消费获准片段、回报输出，无自由内容提交/键鼠/私有记忆权限 |
| http://127.0.0.1:17862 | 低权限Overlay | 只读公开投影，无控制、原始私有内容或长期密钥 |

端口仅示例，集中配置。不同端口形成不同Origin，但Cookie不按端口隔离；不能让这些来源共享高权限Cookie/长期令牌。[S18][S28] 原始观众展示放Overlay，审核字幕仍在Stage以保持音字同步。

### 19.3 持久配对与短连接凭证

一次性启动码只用于首次配对批准，不作为每次OBS刷新所需的唯一凭证。Stage URL保持无凭据固定地址。配对身份绑定设备公钥、pairing_id、角色、精确Origin、允许Session范围、pairing_epoch和撤销状态；连接令牌另绑定当前server_instance/connection_instance、短期限和角色。

首版方案：Stage在OBS浏览器上下文生成不可导出的WebCrypto签名私钥，使用IndexedDB保存CryptoKey；服务端只存公钥/权限。配对页面展示非授权pair_request_id与短期指纹，操作员在已认证操作台核对批准；批准证明一次消费后失效。私钥与长期管理Bearer token不写URL、localStorage或日志。WebCrypto支持CryptoKey序列化和导出权限控制，但不等同硬件密钥保险箱；同Origin恶意脚本仍可能调用密钥签名。[S33][S34]

每次刷新/重启：读取已配对设备密钥→服务端给单次短挑战→签名绑定server_instance、connection_instance、role、Origin、pairing_epoch和expiry→服务端验证→签发只在页面内存保存的短期角色token。挑战重放拒绝；未完成认证不发送音频/私有状态。配对被撤销后旧密钥不可继续认证，需要新pairing_id重新批准。

OBS官方明确浏览器源可能隐藏时卸载、场景激活时刷新，也提供手动刷新，因此重连是正常生命周期而非只靠重启规避。[S8] 必须在目标OBS/CEF实测CryptoKey存储跨刷新/退出恢复；不支持或存储被清除时进入UNPAIRED并明确要求重新批准，不能降级为URL长期密钥或匿名信任loopback。

同pairing_id只允许一个有效Stage输出连接。新连接发现旧连接仍活跃时不抢占，要求确认旧连接停止或操作员显式交接。已配对身份只是准许重新认证；重连创建新Stage实例和连接代次，不恢复旧Segment许可、PCM或发声权。只有监督和当前媒体准入重新通过，才允许新内容输出；旧未明输出先对账。

配对State和ExecutionGrant分开：StagePairing.PAIRED/AUTHENTICATED不代表public或test_only许可有效。端点停止/监督失效先撤新媒体许可，不因有持久设备身份自动复权。

### 19.4 安全渲染与资源

字幕和Overlay使用textContent或等价安全文本输出，不拼innerHTML，不解释外来CSS/脚本/Markdown HTML。[S19] 限长、处理控制字符与双向文字；内容审核不是XSS过滤的替代。

头像或图片通过受限代理、类型/大小校验和缓存，禁止Stage直接访问任意观众URL。两类页面分别最小CSP：固定脚本、禁止eval/任意内联、限制connect/worker/media/frame，不为AudioWorklet写成全局通配。

跨源只走公开投影或精确校验origin/source的消息。预览默认静音只读。来源隔离和受信插件清单不证明抵御同权限本机恶意代码；OS/进程级攻击需部署最小权限与额外隔离。

### 19.5 必测项目

恶意/null Origin、伪Host、未认证订阅、角色错误/过期令牌、旧实例重连、超大消息、重复JSON键、昵称XSS、外链资源、Overlay调用stop/keyboard、Stage提交自由台词、凭证日志泄漏、媒体凭证越界，都应在真实开发浏览器及OBS内嵌环境测试。

### 19.7 配对验收

覆盖首次配对、刷新、OBS关闭重开、隐藏后卸载/再显示、服务端重启、令牌过期、配对撤销、挑战重放、旧连接未死、新旧Stage输出竞争、密钥存储不可用与存储被清除。每次恢复都验证“只恢复身份、不重播旧效果”。私钥可用性与泄露风险要在目标CEF实测，未通过只允许人工重新配对的受控本地测试。
