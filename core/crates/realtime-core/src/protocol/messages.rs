//! 核连接与统一许可控制连接的非动作类消息类型（严格 `deny_unknown_fields`）。

use serde::{Deserialize, Serialize};

use super::actions::HeldInput;

/// 不带字段的 params 或 result。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Empty {}

// ---------------------------------------------------------------- 握手

/// `core.hello` 的 params。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoreHelloParams {
    pub protocol_version: u32,
    pub core_version: String,
}

/// `core.hello` 的 result。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoreHelloResult {
    pub protocol_version: u32,
}

// ---------------------------------------------------------------- 共享内存环与采集目标

/// `frame_ring.attach` 的 params。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrameRingAttachParams {
    pub name: String,
    pub size_bytes: u64,
    pub layout_version: u32,
    pub slot_count: u32,
    pub slot_stride: u64,
    pub max_width: u32,
    pub max_height: u32,
}

/// `audio_ring.attach` 的 params。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AudioRingAttachParams {
    pub name: String,
    pub size_bytes: u64,
    pub layout_version: u32,
    pub block_count: u32,
    pub block_stride: u64,
    pub block_capacity: u32,
    pub sample_rate: u32,
    pub channels: u32,
    pub sample_format: u32,
}

/// `capture.set_target` 与 `audio.set_target` 共用的窗口识别规则：进程名加窗口类或标题至少其一。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WindowTargetParams {
    /// 进程可执行文件名，不区分大小写。
    pub process_name: String,
    /// 窗口类名，精确匹配；`null` 表示不限。
    pub window_class: Option<String>,
    /// 窗口标题，精确匹配；`null` 表示不限。
    pub title: Option<String>,
}

// ---------------------------------------------------------------- 控制产出者

/// 控制产出者的身份与严格递增代次。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Producer {
    pub id: String,
    pub generation: u64,
}

/// `producer.heartbeat` 的 params。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProducerHeartbeatParams {
    pub producer: Producer,
    pub seq: u64,
}

/// `producer.revoke` 的 params。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProducerRevokeParams {
    /// 作废此代次及更早的全部代次。
    pub generation: u64,
}

/// `producer.revoke` 的 result。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProducerRevokeResult {
    /// 关联的释放编号；没有新/可关联释放时为 `null`。
    pub release_id: Option<u64>,
}

// ---------------------------------------------------------------- 统一许可控制

/// `lease.renew` 的 params：授予、续约或换发单调递增令牌。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LeaseRenewParams {
    /// 单调递增令牌（须 >= 1）。等于当前令牌即续约，大于当前令牌即换发（先释放并核验旧许可）。
    pub token: u64,
    /// 到期时刻（与帧环同基的单调纳秒时钟）。
    pub expires_ns: u64,
}

/// `lease.revoke` 的 params：吊销 `token` 及更早的全部令牌。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LeaseRevokeParams {
    pub token: u64,
}

/// `input.stop` 的 params：带外急停或按令牌水位的显式停止。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InputStopParams {
    /// `null` 表示无条件立即吊销当前令牌并释放；`Some(t)` 表示吊销 `<= t` 并在无更新有效令牌时强制释放与核验。
    pub through_token: Option<u64>,
}

/// `input.stop` 的 result。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InputStopResult {
    /// 本次触发的释放编号；若存在更新的有效令牌而未触发释放则为 `null`。
    pub release_id: Option<u64>,
}

// ---------------------------------------------------------------- 释放与健康

/// `input.released` 的 params（核连接与许可控制连接共用）。
///
/// 释放执行完立即发出一条（`verification` 为 `unverified` 或 `up_failed`）；
/// 真实后端完成 `GetAsyncKeyState` 物理核验后，再以相同 `release_id` 发出核验结果
/// （`verified` / `residual` / `unavailable` / `superseded`，残留项填在 `residual_items`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InputReleasedParams {
    pub release_id: u64,
    pub token: Option<u64>,
    pub reason: ReleaseReason,
    pub producer: Option<Producer>,
    pub released_at_ns: u64,
    pub verification: ReleaseVerification,
    pub residual_items: Vec<HeldInput>,
}

/// 一次释放的证据与物理核验状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReleaseVerification {
    /// 抬起请求已发出，尚未完成物理核验。
    Unverified,
    /// 后端至少拒绝了一项抬起事件。
    UpFailed,
    /// 物理核验通过：活动输入桌面可读且白名单键鼠均未按下。
    Verified,
    /// 物理核验发现残留（或补发抬起被拒）。
    Residual,
    /// 无法读取活动输入桌面状态，或释放已有抬起失败。
    Unavailable,
    /// 核验已被更新的一次释放取代。
    Superseded,
}

/// 释放全部输入的原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReleaseReason {
    CoreStart,
    GenerationRevoked,
    ProducerChanged,
    HeartbeatTimeout,
    DeadlineExpired,
    FrameStale,
    LeaseExpired,
    LeaseRevoked,
    InputStop,
    LeaseSourceLost,
    NoLease,
    FocusLost,
    Takeover,
    EmergencyStop,
    InjectionBlocked,
    HookLost,
    MaxHold,
    Shutdown,
    CoreConnectionLost,
    StdinClosed,
}

/// `health` 的 params（核连接与许可控制连接共用）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HealthParams {
    pub now_ns: u64,
    pub capture: CaptureState,
    pub audio: CaptureState,
    pub inputs_held: bool,
    pub producer: Option<Producer>,
    pub latest_frame: Option<LatestFrame>,
    pub latest_audio: Option<LatestAudio>,
    pub lease: LeaseStatus,
    pub queue_depth: u32,
    pub target_focused: bool,
    pub human_idle_ms: Option<u64>,
}

/// 最近写进帧环的一帧。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LatestFrame {
    pub frame_number: u64,
    pub capture_ns: u64,
}

/// 最近写进音频环的一块。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LatestAudio {
    pub block_number: u64,
    pub capture_ns: u64,
}

/// 输入许可状态（只报状态，不暴露令牌值）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LeaseStatus {
    NotGranted,
    Valid,
    Expired,
    Revoked,
    SourceLost,
}

/// 画面与声音的采集状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureState {
    Idle,
    Searching,
    Capturing,
}
