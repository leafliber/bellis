//! 输入策略、动作块与执行回执的消息类型（严格 `deny_unknown_fields`）。

use serde::{Deserialize, Serialize};

/// 归一化矩形：客户区相对坐标，各分量取值 [0, 1]，左上小于右下。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NormRect {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

/// `input.configure` 的 params：动作白名单、静态禁区、速率与最长按住时长。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InputPolicy {
    pub click_buttons: Vec<MouseButton>,
    pub press_keys: Vec<u16>,
    pub scroll: bool,
    pub click_regions: Vec<NormRect>,
    pub forbidden_zones: Vec<NormRect>,
    pub press_duration_ms: u32,
    pub max_rate: f64,
    pub hold_keys: Vec<u16>,
    pub hold_buttons: Vec<MouseButton>,
    pub max_hold_ms: Option<u32>,
}

/// `action.submit` 的 params：主控向实时核提交的唯一动作块形式。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionBlock {
    pub producer: super::messages::Producer,
    pub seq: u64,
    pub base_frame: u64,
    pub start_ns: u64,
    pub deadline_ns: u64,
    pub steps: Vec<ControlStep>,
}

/// 动作块中的一步：持续状态集合与一次性动作序列。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ControlStep {
    pub offset_ns: u64,
    pub held: Vec<HeldInput>,
    pub actions: Vec<Action>,
}

/// 持续状态的一项。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HeldInput {
    Key(HeldKey),
    MouseButton(HeldMouseButton),
    Axis(HeldAxis),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HeldKey {
    /// Set 1 扫描码；扩展键在高字节带 `0xE0`。
    pub scan_code: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HeldMouseButton {
    pub button: MouseButton,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HeldAxis {
    pub axis: String,
    pub value: f64,
}

/// 一次性动作，每个带同代次内唯一 `id` 供去重。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Action {
    Click(Click),
    KeyPress(KeyPress),
    Scroll(Scroll),
    MouseMove(MouseMove),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Click {
    pub id: u64,
    pub x: u32,
    pub y: u32,
    pub button: MouseButton,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KeyPress {
    pub id: u64,
    pub scan_code: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scroll {
    pub id: u64,
    pub x: u32,
    pub y: u32,
    pub notches: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MouseMove {
    pub id: u64,
    pub dx: i32,
    pub dy: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

/// `action.submit` 的 result。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ActionSubmitResult {
    Accepted(Accepted),
    Rejected(Rejected),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Accepted {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rejected {
    pub reason: RejectReason,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RejectReason {
    StaleGeneration,
    ProducerMismatch,
    StaleSeq,
    Expired,
    Invalid,
    NotAllowed,
    Stopping,
}

/// `action.receipt` 的 params。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionReceiptParams {
    pub producer: super::messages::Producer,
    pub block_seq: u64,
    pub outcomes: Vec<ActionOutcome>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ActionOutcome {
    Executed(Executed),
    Dropped(Dropped),
    Uncertain(Uncertain),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Executed {
    pub id: u64,
    pub at_ns: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Dropped {
    pub id: u64,
    pub reason: DropReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DropReason {
    Superseded,
    Duplicate,
    Released,
    GeometryChanged,
    NotAllowed,
    RateLimited,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Uncertain {
    pub id: u64,
    pub at_ns: u64,
}
