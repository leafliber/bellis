//! Bellis V2 实时核的统一协议定义（纯 serde，零代码生成）。
//!
//! 跨语言一致性由 `tests/fixtures/realtime_core/` 下的 JSON 夹具往返断言保证：
//! - 许可控制连接（独立控制台 / Host ↔ 实时核）只有唯一一套 5 个 RPC 方法：
//!   `lease.renew`、`lease.revoke`、`input.stop`、`input.released`、`health`；
//! - 核连接（主控进程 ↔ 实时核）精简为 Step 1–2 最小必需集。

pub mod actions;
pub mod messages;

pub use actions::*;
pub use messages::*;

/// 核协议版本（Bellis V2）。握手时两端核对，不相等即拒绝。
pub const PROTOCOL_VERSION: u32 = 1;

/// 核连接（主控进程 ↔ 实时核）RPC 方法名。
pub mod core_methods {
    /// 握手（实时核 → 主控，请求）。
    pub const CORE_HELLO: &str = "core.hello";
    /// 挂接共享内存帧环（主控 → 实时核，请求）。
    pub const FRAME_RING_ATTACH: &str = "frame_ring.attach";
    /// 设定画面采集窗口目标（主控 → 实时核，请求）。
    pub const CAPTURE_SET_TARGET: &str = "capture.set_target";
    /// 挂接共享内存音频环（主控 → 实时核，请求）。
    pub const AUDIO_RING_ATTACH: &str = "audio_ring.attach";
    /// 设定音频采集窗口进程目标（主控 → 实时核，请求）。
    pub const AUDIO_SET_TARGET: &str = "audio.set_target";
    /// 配置不可变输入策略，每实例一次（主控 → 实时核，请求）。
    pub const INPUT_CONFIGURE: &str = "input.configure";
    /// 控制产出者心跳（主控 → 实时核，通知）。
    pub const PRODUCER_HEARTBEAT: &str = "producer.heartbeat";
    /// 作废控制产出者代次（主控 → 实时核，请求）。
    pub const PRODUCER_REVOKE: &str = "producer.revoke";
    /// 提交动作块（主控 → 实时核，请求）。
    pub const ACTION_SUBMIT: &str = "action.submit";
    /// 动作块执行回执（实时核 → 主控，通知）。
    pub const ACTION_RECEIPT: &str = "action.receipt";
    /// 输入释放及物理核验通知（实时核 → 主控，通知）。
    pub const INPUT_RELEASED: &str = "input.released";
    /// 定期健康上报（实时核 → 主控，通知）。
    pub const HEALTH: &str = "health";
    /// 正常停止（主控 → 实时核，请求）。
    pub const SHUTDOWN: &str = "shutdown";
}

/// 统一许可控制连接（独立控制台或 Host ↔ 实时核）唯一一套 5 个 RPC 方法名。
pub mod permit_methods {
    /// 授予、续约或换发单调递增令牌（许可源 → 实时核，请求）。
    pub const LEASE_RENEW: &str = "lease.renew";
    /// 单调吊销令牌及更早令牌，释放完成后应答（许可源 → 实时核，请求）。
    pub const LEASE_REVOKE: &str = "lease.revoke";
    /// 带外急停/显式停止，立即释放并触发核验（许可源 → 实时核，请求）。
    pub const INPUT_STOP: &str = "input.stop";
    /// 输入释放及物理核验结果（实时核 → 许可源，通知）。
    pub const INPUT_RELEASED: &str = "input.released";
    /// 定期健康上报（实时核 → 许可源，通知）。
    pub const HEALTH: &str = "health";
}

/// 实时核自定义 JSON-RPC 2.0 错误码。
pub mod error_code {
    /// `core.hello` 协议版本不匹配。
    pub const PROTOCOL_VERSION_MISMATCH: i64 = -32001;
    /// `frame_ring.attach` 共享内存无法打开或头部参数不匹配。
    pub const FRAME_RING_MISMATCH: i64 = -32002;
    /// `capture.set_target` 或 `audio.set_target` 当前环境不支持。
    pub const CAPTURE_UNSUPPORTED: i64 = -32003;
    /// `lease.renew` 许可被拒绝（令牌陈旧/已吊销/已过期/到期早于当前/钩子或释放故障）。
    pub const LEASE_REFUSED: i64 = -32004;
    /// `audio_ring.attach` 共享内存无法打开或头部参数不匹配。
    pub const AUDIO_RING_MISMATCH: i64 = -32005;
    /// `input.configure` 本实例已配置过策略。
    pub const INPUT_POLICY_CONFLICT: i64 = -32006;
}

#[cfg(test)]
mod tests;
