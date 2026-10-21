"""Bellis 的 Python sidecar 运行时（D-13、D-21、R-06、R-24）。

- `channel`：本机通道客户端，与 `packages/channel` 逐字节兼容；
- `rpc`：通道之上的 JSON-RPC 2.0 对端，处理宿主请求、发通知与二进制帧；
- `runtime`：以 `sidecar.<条目 id>` 角色连接宿主，应答握手，按 R-06 的顺序退出；
- `processes`：Job Object 与派生进程；
- `qos`：本进程的电源节流状态（Windows 的 QoS），启动时声明 HighQoS、健康检查时读回；
- `telemetry`：遥测（R-21），以宿主给的 traceparent 为父写 span，JSONL 与宿主写在同一目录；
- `protocol`：由 `packages/protocol` 生成的 Pydantic 模型。

这里不导入子模块，`processes` 与 `qos` 只依赖标准库，可以在没有第三方包的解释器里单独使用。
"""
